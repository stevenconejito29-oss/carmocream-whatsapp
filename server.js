/**
 * CarmoCream WhatsApp Server
 * 
 * PROBLEMA RESUELTO: Railway borra /tmp en cada reinicio, lo que causaba
 * que LocalAuth perdiera la sesión y generara QR en bucle infinito.
 * 
 * SOLUCIÓN: RemoteAuth con Supabase como store persistente.
 * La sesión se guarda en la tabla `whatsapp_session` de Supabase
 * y se restaura automáticamente al reiniciar el contenedor.
 * 
 * REQUISITO: Crear esta tabla en Supabase:
 *   CREATE TABLE whatsapp_session (
 *     id TEXT PRIMARY KEY,
 *     data TEXT NOT NULL,
 *     updated_at TIMESTAMPTZ DEFAULT NOW()
 *   );
 * 
 * Variables de entorno necesarias en Railway:
 *   WA_SECRET=tu_secreto
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_KEY=tu_anon_key_o_service_role_key
 */

const express    = require('express')
const cors       = require('cors')
const qrcode     = require('qrcode')
const { Client, RemoteAuth } = require('whatsapp-web.js')
const { execSync } = require('child_process')

// ── Supabase client ──────────────────────────────────────────────
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('⚠️  Faltan SUPABASE_URL o SUPABASE_KEY en las variables de entorno')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── SupabaseStore para RemoteAuth ────────────────────────────────
// RemoteAuth necesita un "store" con métodos: sessionExists, save, extract, delete
class SupabaseStore {
  constructor() {
    this.supabase = supabase
    this.tableName = 'whatsapp_session'
  }

  async sessionExists({ session }) {
    try {
      const { data } = await this.supabase
        .from(this.tableName)
        .select('id')
        .eq('id', session)
        .maybeSingle()
      return !!data
    } catch (e) {
      console.error('[SupabaseStore] sessionExists error:', e)
      return false
    }
  }

  async save({ session }) {
    // RemoteAuth pasa la ruta del zip de sesión
    // Aquí solo confirmamos que existe — el archivo ya fue guardado por extract
    console.log('[SupabaseStore] save llamado para sesión:', session)
  }

  async extract({ session, path: destPath }) {
    try {
      const { data } = await this.supabase
        .from(this.tableName)
        .select('data')
        .eq('id', session)
        .maybeSingle()

      if (!data) {
        console.log('[SupabaseStore] No hay sesión guardada para:', session)
        return
      }

      const fs = require('fs')
      const buf = Buffer.from(data.data, 'base64')
      fs.writeFileSync(destPath, buf)
      console.log('[SupabaseStore] Sesión restaurada desde Supabase')
    } catch (e) {
      console.error('[SupabaseStore] extract error:', e)
    }
  }

  async delete({ session }) {
    try {
      await this.supabase
        .from(this.tableName)
        .delete()
        .eq('id', session)
      console.log('[SupabaseStore] Sesión eliminada:', session)
    } catch (e) {
      console.error('[SupabaseStore] delete error:', e)
    }
  }
}

// ── App ──────────────────────────────────────────────────────────
const app    = express()
const PORT   = process.env.PORT || 3000
const SECRET = process.env.WA_SECRET

if (!SECRET) {
  console.error('⚠️  Falta WA_SECRET en las variables de entorno')
  process.exit(1)
}

app.use(cors())
app.use(express.json())

let qrImageBase64 = null
let isReady       = false
let client        = null
let initAttempts  = 0

// ── Chromium ─────────────────────────────────────────────────────
function findChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.log('Usando PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH)
    return process.env.PUPPETEER_EXECUTABLE_PATH
  }
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome-unstable',
  ]
  for (const p of candidates) {
    try {
      execSync(`test -f "${p}"`)
      console.log('Chromium encontrado en:', p)
      return p
    } catch {}
  }
  console.log('Chromium no encontrado manualmente, dejando que puppeteer lo busque')
  return undefined
}

const CHROMIUM_PATH = findChromium()

// ── initClient ───────────────────────────────────────────────────
function initClient() {
  initAttempts++
  console.log(`[Init] Intento #${initAttempts}`)

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

  if (CHROMIUM_PATH) {
    puppeteerConfig.executablePath = CHROMIUM_PATH
  }

  const store = new SupabaseStore()

  client = new Client({
    authStrategy: new RemoteAuth({
      store,
      backupSyncIntervalMs: 300000, // Guarda sesión en Supabase cada 5 min
      clientId: 'carmocream',
    }),
    puppeteer: puppeteerConfig,
  })

  client.on('qr', async (qr) => {
    console.log('QR generado — visita la URL del servidor para escanearlo')
    isReady = false
    try {
      qrImageBase64 = await qrcode.toDataURL(qr)
    } catch (e) {
      console.error('Error generando QR image:', e)
    }
  })

  client.on('ready', () => {
    console.log('✅ WhatsApp conectado y listo')
    isReady       = true
    qrImageBase64 = null
    initAttempts  = 0
  })

  client.on('authenticated', () => {
    console.log('🔐 Autenticado correctamente')
  })

  // RemoteAuth guarda la sesión cuando se emite este evento
  client.on('remote_session_saved', () => {
    console.log('💾 Sesión guardada en Supabase')
    // Guardamos el zip de sesión en Supabase manualmente
    saveSessionToSupabase()
  })

  client.on('auth_failure', (msg) => {
    console.error('❌ Fallo de autenticación:', msg)
    isReady = false
    // Borrar sesión corrupta y reintentar
    store.delete({ session: 'carmocream' }).then(() => {
      setTimeout(() => initClient(), 8000)
    })
  })

  client.on('disconnected', (reason) => {
    console.log('🔌 Desconectado:', reason)
    isReady = false
    const delay = Math.min(5000 * initAttempts, 60000) // backoff: máx 60s
    console.log(`Reintentando en ${delay / 1000}s...`)
    setTimeout(() => initClient(), delay)
  })

  client.initialize()
}

// ── Guardar sesión zip en Supabase ───────────────────────────────
async function saveSessionToSupabase() {
  const fs   = require('fs')
  const path = require('path')

  // RemoteAuth guarda el zip en el directorio de trabajo
  const zipPath = path.join(process.cwd(), 'RemoteAuth-carmocream.zip')

  if (!fs.existsSync(zipPath)) {
    console.warn('[Session] No se encontró el zip de sesión en:', zipPath)
    return
  }

  try {
    const buf    = fs.readFileSync(zipPath)
    const base64 = buf.toString('base64')

    await supabase.from('whatsapp_session').upsert(
      { id: 'carmocream', data: base64, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    )
    console.log('[Session] ✅ Sesión guardada en Supabase correctamente')
  } catch (e) {
    console.error('[Session] Error guardando sesión:', e)
  }
}

initClient()

// ── Middleware auth ───────────────────────────────────────────────
function checkSecret(req, res, next) {
  const secret = req.headers['x-secret'] || req.query.secret
  if (secret !== SECRET) {
    return res.status(401).json({ error: 'No autorizado' })
  }
  next()
}

// ── Rutas ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (isReady) {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>CarmoCream WA</title>
    <style>
      body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
           min-height:100vh;margin:0;background:#f0fdf4;}
      .card{background:white;border-radius:20px;padding:40px;text-align:center;
            box-shadow:0 10px 40px rgba(0,0,0,0.1);max-width:400px;width:90%;}
      h1{color:#2d6a4f;}
      .status{background:#dcfce7;color:#166534;padding:8px 20px;border-radius:20px;
              font-weight:700;display:inline-block;margin-top:16px;}
    </style>
    </head><body><div class="card">
      <div style="font-size:4rem">✅</div>
      <h1>CarmoCream WhatsApp</h1>
      <p style="color:#6b7280">El servidor está conectado y enviando mensajes automáticamente.</p>
      <div class="status">&#9679; Conectado</div>
      <p style="margin-top:20px;font-size:.8rem;color:#9ca3af">
        Sesión persistente en Supabase — sobrevive reinicios de Railway
      </p>
    </div></body></html>`)
  } else if (qrImageBase64) {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>CarmoCream WA — Escanea QR</title>
    <meta http-equiv="refresh" content="30">
    <style>
      body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
           min-height:100vh;margin:0;background:#f0fdf4;}
      .card{background:white;border-radius:20px;padding:40px;text-align:center;
            box-shadow:0 10px 40px rgba(0,0,0,0.1);max-width:440px;width:90%;}
      h1{color:#2d6a4f;font-size:1.4rem;}
      img{width:260px;height:260px;border:3px solid #d1fae5;border-radius:12px;}
      p{color:#6b7280;font-size:.9rem;}
      .steps{text-align:left;background:#f0fdf4;border-radius:12px;padding:16px;margin:16px 0;font-size:.85rem;}
      .steps li{margin-bottom:6px;color:#374151;}
    </style>
    </head><body><div class="card">
      <div style="font-size:3rem">📱</div>
      <h1>Escanea con tu WhatsApp</h1>
      <ol class="steps">
        <li>Abre WhatsApp en tu móvil</li>
        <li>Ve a <strong>Dispositivos vinculados</strong></li>
        <li>Pulsa <strong>Vincular dispositivo</strong></li>
        <li>Escanea este QR</li>
      </ol>
      <img src="${qrImageBase64}" alt="QR WhatsApp" />
      <p style="font-size:.75rem;color:#9ca3af;margin-top:12px">
        ⚡ Una vez escaneado, la sesión se guarda en Supabase<br>
        y no tendrás que volver a escanear aunque Railway reinicie.<br><br>
        La página se recarga sola cada 30 segundos.
      </p>
    </div></body></html>`)
  } else {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>CarmoCream WA — Iniciando</title>
    <meta http-equiv="refresh" content="5">
    <style>
      body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
           min-height:100vh;margin:0;background:#f0fdf4;}
      .card{background:white;border-radius:20px;padding:40px;text-align:center;
            box-shadow:0 10px 40px rgba(0,0,0,0.1);}
      h1{color:#2d6a4f;}
    </style>
    </head><body><div class="card">
      <h1>⏳ Iniciando servidor...</h1>
      <p style="color:#6b7280">Restaurando sesión desde Supabase o generando QR...<br>
      La página se recarga sola en 5 segundos.</p>
    </div></body></html>`)
  }
})

app.get('/status', (req, res) => {
  res.json({
    ready:    isReady,
    hasQr:    !!qrImageBase64,
    attempts: initAttempts,
  })
})

app.post('/send', checkSecret, async (req, res) => {
  const { phone, message } = req.body

  if (!phone || !message) {
    return res.status(400).json({ error: 'Faltan phone y/o message' })
  }

  if (!isReady) {
    return res.status(503).json({
      error: 'WhatsApp no está conectado. Escanea el QR en /',
      ready: false,
    })
  }

  try {
    const clean  = phone.replace(/[^\d]/g, '')
    const chatId = clean + '@c.us'
    await client.sendMessage(chatId, message)
    console.log(`[Send] ✅ Mensaje enviado a ${clean}`)
    res.json({ success: true, to: clean })
  } catch (err) {
    console.error('[Send] Error enviando mensaje:', err)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`Servidor CarmoCream WhatsApp en puerto ${PORT}`)
})
