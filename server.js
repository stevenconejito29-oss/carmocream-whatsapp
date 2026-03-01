/**
 * CarmoCream WhatsApp Server — v2
 *
 * FIXES aplicados:
 * - SupabaseStore.save() ahora espera correctamente el zip que escribe RemoteAuth
 * - Ruta del zip calculada igual que lo hace RemoteAuth internamente
 * - Logs claros en cada paso para diagnosticar desde Railway
 * - backupSyncIntervalMs reducido a 60s para Railway
 * - Manejo robusto de errores en /send
 *
 * Variables de entorno necesarias en Railway:
 *   WA_SECRET=tu_secreto
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_KEY=tu_anon_key_o_service_role_key
 *
 * Tabla necesaria en Supabase:
 *   CREATE TABLE whatsapp_session (
 *     id TEXT PRIMARY KEY,
 *     data TEXT NOT NULL,
 *     updated_at TIMESTAMPTZ DEFAULT NOW()
 *   );
 */

const express      = require('express')
const cors         = require('cors')
const qrcode       = require('qrcode')
const fs           = require('fs')
const path         = require('path')
const { Client, RemoteAuth } = require('whatsapp-web.js')
const { execSync } = require('child_process')
const { createClient } = require('@supabase/supabase-js')

// ── Variables de entorno ─────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const SECRET       = process.env.WA_SECRET
const PORT         = process.env.PORT || 3000
const SESSION_ID   = 'carmocream'

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Faltan SUPABASE_URL o SUPABASE_KEY')
  process.exit(1)
}
if (!SECRET) {
  console.error('❌ Falta WA_SECRET')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── Esperar a que exista un archivo ──────────────────────────────
function waitForFile(filePath, timeoutMs = 20000, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      if (fs.existsSync(filePath)) {
        console.log(`[Store] Archivo encontrado: ${filePath}`)
        return resolve()
      }
      if (Date.now() - start >= timeoutMs) {
        return reject(new Error(`Timeout esperando archivo: ${filePath}`))
      }
      setTimeout(check, intervalMs)
    }
    check()
  })
}

// ── SupabaseStore — store correcto para RemoteAuth ───────────────
// RemoteAuth llama a estos métodos con { session, path } donde:
//   session = clientId ('carmocream')
//   path    = ruta absoluta donde RemoteAuth YA escribió el zip
//
// IMPORTANTE: En save(), el zip YA existe en `path` cuando RemoteAuth llama.
// En el código anterior se intentaba construir la ruta manualmente, lo cual
// era incorrecto. Aquí usamos la ruta que RemoteAuth nos pasa directamente.

class SupabaseStore {
  async sessionExists({ session }) {
    try {
      const { data } = await supabase
        .from('whatsapp_session')
        .select('id')
        .eq('id', session)
        .maybeSingle()
      const exists = !!data
      console.log(`[Store] sessionExists(${session}):`, exists)
      return exists
    } catch (e) {
      console.error('[Store] sessionExists error:', e.message)
      return false
    }
  }

  // RemoteAuth llama a save({ session, path }) cuando quiere persistir.
  // `path` = ruta absoluta del zip que RemoteAuth YA escribió en disco.
  async save({ session, path: zipPath }) {
    console.log(`[Store] save() llamado — zip en: ${zipPath}`)
    try {
      // Esperar hasta 20s por si RemoteAuth aún no terminó de escribir
      await waitForFile(zipPath, 20000)

      const buf    = fs.readFileSync(zipPath)
      const base64 = buf.toString('base64')

      const { error } = await supabase
        .from('whatsapp_session')
        .upsert(
          { id: session, data: base64, updated_at: new Date().toISOString() },
          { onConflict: 'id' }
        )

      if (error) {
        console.error('[Store] Error guardando en Supabase:', error.message)
      } else {
        console.log(`[Store] ✅ Sesión guardada en Supabase (${Math.round(buf.length / 1024)} KB)`)
      }
    } catch (e) {
      console.error('[Store] save() error:', e.message)
    }
  }

  // RemoteAuth llama a extract({ session, path }) para restaurar la sesión.
  // `path` = ruta donde RemoteAuth espera que escribamos el zip.
  async extract({ session, path: destPath }) {
    console.log(`[Store] extract() llamado — destino: ${destPath}`)
    try {
      const { data, error } = await supabase
        .from('whatsapp_session')
        .select('data')
        .eq('id', session)
        .maybeSingle()

      if (error) {
        console.error('[Store] Error leyendo de Supabase:', error.message)
        return
      }
      if (!data) {
        console.log('[Store] No hay sesión guardada — se generará QR')
        return
      }

      const buf = Buffer.from(data.data, 'base64')
      fs.writeFileSync(destPath, buf)
      console.log(`[Store] ✅ Sesión restaurada desde Supabase (${Math.round(buf.length / 1024)} KB)`)
    } catch (e) {
      console.error('[Store] extract() error:', e.message)
    }
  }

  async delete({ session }) {
    try {
      await supabase
        .from('whatsapp_session')
        .delete()
        .eq('id', session)
      console.log(`[Store] Sesión eliminada: ${session}`)
    } catch (e) {
      console.error('[Store] delete() error:', e.message)
    }
  }
}

// ── App Express ──────────────────────────────────────────────────
const app = express()
app.use(cors())
app.use(express.json())

let qrImageBase64 = null
let isReady       = false
let client        = null
let initAttempts  = 0

// ── Localizar Chromium ───────────────────────────────────────────
function findChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.log('[Chrome] Usando env:', process.env.PUPPETEER_EXECUTABLE_PATH)
    return process.env.PUPPETEER_EXECUTABLE_PATH
  }
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
  ]
  for (const p of candidates) {
    try { execSync(`test -f "${p}"`); console.log('[Chrome] Encontrado:', p); return p } catch {}
  }
  console.warn('[Chrome] No encontrado, puppeteer buscará solo')
  return undefined
}

const CHROMIUM_PATH = findChromium()

// ── initClient ───────────────────────────────────────────────────
function initClient() {
  initAttempts++
  console.log(`\n[Init] ── Intento #${initAttempts} ──────────────────`)

  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  }
  if (CHROMIUM_PATH) puppeteerConfig.executablePath = CHROMIUM_PATH

  const store = new SupabaseStore()

  client = new Client({
    authStrategy: new RemoteAuth({
      store,
      // 60 segundos: guarda sesión frecuentemente para sobrevivir reinicios
      backupSyncIntervalMs: 60000,
      clientId: SESSION_ID,
    }),
    puppeteer: puppeteerConfig,
  })

  client.on('qr', async (qr) => {
    console.log('[QR] Nuevo QR generado — visita la URL del servidor para escanearlo')
    isReady = false
    try {
      qrImageBase64 = await qrcode.toDataURL(qr)
    } catch (e) {
      console.error('[QR] Error generando imagen:', e.message)
    }
  })

  client.on('authenticated', () => {
    console.log('[Auth] ✅ Autenticado correctamente')
  })

  client.on('ready', () => {
    console.log('[Ready] ✅ WhatsApp conectado y listo para enviar')
    isReady       = true
    qrImageBase64 = null
    initAttempts  = 0
  })

  client.on('remote_session_saved', () => {
    // RemoteAuth ya llamó a store.save() — solo logueamos
    console.log('[Session] 💾 remote_session_saved recibido')
  })

  client.on('auth_failure', async (msg) => {
    console.error('[Auth] ❌ Fallo de autenticación:', msg)
    isReady = false
    // Borrar sesión corrupta y reintentar
    await store.delete({ session: SESSION_ID })
    setTimeout(() => initClient(), 8000)
  })

  client.on('disconnected', (reason) => {
    console.log('[Disconnected] Motivo:', reason)
    isReady = false
    const delay = Math.min(5000 * initAttempts, 60000)
    console.log(`[Disconnected] Reintentando en ${delay / 1000}s...`)
    setTimeout(() => initClient(), delay)
  })

  client.initialize()
}

initClient()

// ── Middleware de autenticación ──────────────────────────────────
function checkSecret(req, res, next) {
  const secret = req.headers['x-secret'] || req.query.secret
  if (secret !== SECRET) return res.status(401).json({ error: 'No autorizado' })
  next()
}

// ── Rutas ────────────────────────────────────────────────────────

// Estado — usado por el admin para verificar conexión
app.get('/status', (req, res) => {
  res.json({
    ready:    isReady,
    hasQr:    !!qrImageBase64,
    attempts: initAttempts,
  })
})

// Enviar mensaje
app.post('/send', checkSecret, async (req, res) => {
  const { phone, message } = req.body

  if (!phone || !message) {
    return res.status(400).json({ error: 'Faltan phone y/o message' })
  }

  if (!isReady || !client) {
    console.warn(`[Send] Intento de envío pero no está listo (isReady=${isReady})`)
    return res.status(503).json({
      success: false,
      error:   'WhatsApp no está conectado. Escanea el QR en /',
      ready:   false,
    })
  }

  // Normalizar teléfono: solo dígitos + @c.us
  const clean  = String(phone).replace(/[^\d]/g, '')
  const chatId = clean + '@c.us'

  console.log(`[Send] Enviando a ${clean} (chatId: ${chatId})`)

  try {
    await client.sendMessage(chatId, message)
    console.log(`[Send] ✅ Mensaje enviado a ${clean}`)
    res.json({ success: true, to: clean })
  } catch (err) {
    console.error(`[Send] ❌ Error enviando a ${clean}:`, err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Página web — QR o estado
app.get('/', (req, res) => {
  if (isReady) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>CarmoCream WA ✅</title>
    <style>
      body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
           min-height:100vh;margin:0;background:#f0fdf4;}
      .card{background:white;border-radius:20px;padding:40px;text-align:center;
            box-shadow:0 10px 40px rgba(0,0,0,.1);max-width:400px;width:90%;}
      h1{color:#2d6a4f;} .badge{background:#dcfce7;color:#166534;padding:8px 20px;
        border-radius:20px;font-weight:700;display:inline-block;margin-top:16px;}
    </style></head><body><div class="card">
      <div style="font-size:4rem">✅</div>
      <h1>CarmoCream WhatsApp</h1>
      <p style="color:#6b7280">Servidor conectado y enviando mensajes automáticamente.</p>
      <div class="badge">● Conectado</div>
      <p style="margin-top:20px;font-size:.8rem;color:#9ca3af">
        Sesión persistente en Supabase · sobrevive reinicios de Railway
      </p>
    </div></body></html>`)
  }

  if (qrImageBase64) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>CarmoCream WA — Escanea QR</title>
    <meta http-equiv="refresh" content="30">
    <style>
      body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
           min-height:100vh;margin:0;background:#f0fdf4;}
      .card{background:white;border-radius:20px;padding:40px;text-align:center;
            box-shadow:0 10px 40px rgba(0,0,0,.1);max-width:440px;width:90%;}
      h1{color:#2d6a4f;font-size:1.4rem;}
      img{width:260px;height:260px;border:3px solid #d1fae5;border-radius:12px;}
      .steps{text-align:left;background:#f0fdf4;border-radius:12px;padding:16px;margin:16px 0;font-size:.85rem;}
      .steps li{margin-bottom:6px;color:#374151;}
    </style></head><body><div class="card">
      <div style="font-size:3rem">📱</div>
      <h1>Escanea con tu WhatsApp</h1>
      <ol class="steps">
        <li>Abre WhatsApp en tu móvil</li>
        <li>Ve a <strong>Dispositivos vinculados</strong></li>
        <li>Pulsa <strong>Vincular dispositivo</strong></li>
        <li>Escanea este QR</li>
      </ol>
      <img src="${qrImageBase64}" alt="QR" />
      <p style="font-size:.75rem;color:#9ca3af;margin-top:12px">
        La sesión se guarda en Supabase automáticamente.<br>
        No tendrás que escanear de nuevo tras reinicios.<br><br>
        Esta página se recarga sola cada 30 segundos.
      </p>
    </div></body></html>`)
  }

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>CarmoCream WA — Iniciando</title>
  <meta http-equiv="refresh" content="5">
  <style>
    body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
         min-height:100vh;margin:0;background:#f0fdf4;}
    .card{background:white;border-radius:20px;padding:40px;text-align:center;
          box-shadow:0 10px 40px rgba(0,0,0,.1);}
    h1{color:#2d6a4f;}
  </style></head><body><div class="card">
    <h1>⏳ Iniciando...</h1>
    <p style="color:#6b7280">Restaurando sesión desde Supabase o generando QR...<br>
    Esta página se recarga en 5 segundos.</p>
  </div></body></html>`)
})

app.listen(PORT, () => {
  console.log(`\n🚀 Servidor CarmoCream WhatsApp en puerto ${PORT}`)
  console.log(`   Supabase: ${SUPABASE_URL}`)
})
