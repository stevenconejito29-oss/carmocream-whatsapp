// server.js — CarmoCream WhatsApp (Railway)
// Sesión persistida en Supabase como JSON (sin zip, sin timeout)

const express   = require('express')
const { Client, LocalAuth } = require('whatsapp-web.js')
const { createClient } = require('@supabase/supabase-js')
const fs        = require('fs')
const path      = require('path')

const app    = express()
const PORT   = process.env.PORT || 3000
const SECRET = process.env.WA_SECRET || 'carmocream2024'

// ── Supabase (usa service_role para bypass RLS) ───────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

app.use(express.json())

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const secret = req.headers['x-secret'] || req.query.secret
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// ══════════════════════════════════════════════════════════════════════════════
// SESIÓN EN SUPABASE
// Tabla (crear una vez en Supabase SQL Editor):
//
//   create table if not exists whatsapp_sessions (
//     id         text primary key,
//     data       jsonb,
//     updated_at timestamptz default now()
//   );
// ══════════════════════════════════════════════════════════════════════════════

const SESSION_ID   = 'carmocream'
const SESSION_KEY  = `wa_session_${SESSION_ID}`
const AUTH_PATH    = '/tmp/.wwebjs_auth'
const SESSION_DIR  = path.join(AUTH_PATH, `session-${SESSION_ID}`)
const SESSION_FILE = path.join(SESSION_DIR, 'session.json')

async function saveSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
    const { error } = await supabase
      .from('whatsapp_sessions')
      .upsert({ id: SESSION_KEY, data, updated_at: new Date().toISOString() })
    if (error) console.error('[Session] Error guardando:', error.message)
    else       console.log('[Session] ✅ Guardada en Supabase')
  } catch (e) {
    console.error('[Session] Excepción al guardar:', e.message)
  }
}

async function restoreSession() {
  try {
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('data')
      .eq('id', SESSION_KEY)
      .maybeSingle()
    if (error || !data?.data) {
      console.log('[Session] Sin sesión guardada — se generará QR')
      return false
    }
    fs.mkdirSync(SESSION_DIR, { recursive: true })
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data.data), 'utf8')
    console.log('[Session] ✅ Restaurada desde Supabase')
    return true
  } catch (e) {
    console.error('[Session] Excepción al restaurar:', e.message)
    return false
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CLIENTE WHATSAPP
// ══════════════════════════════════════════════════════════════════════════════

let client  = null
let isReady = false
let lastQr  = null

async function initClient() {
  await restoreSession()

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: SESSION_ID,
      dataPath:  AUTH_PATH,
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
      ],
    },
  })

  client.on('qr', (qr) => {
    lastQr = qr
    console.log('[!] Nuevo QR generado — visita /status para escanearlo')
  })

  client.on('authenticated', async () => {
    console.log('🔐 Autenticado correctamente')
    lastQr = null
    // Guardar sesión tras autenticación (pequeño delay para que wwebjs escriba el archivo)
    setTimeout(saveSession, 3000)
  })

  client.on('ready', () => {
    console.log('✅ WhatsApp conectado y listo')
    isReady = true
    lastQr  = null
    // Guardar sesión al estar listo
    setTimeout(saveSession, 2000)
  })

  client.on('disconnected', async (reason) => {
    console.warn('⚠️ Desconectado:', reason)
    isReady = false
    if (reason === 'LOGOUT') {
      await supabase.from('whatsapp_sessions').delete().eq('id', SESSION_KEY)
      console.log('[Session] Eliminada de Supabase (logout)')
    }
    // Reconectar tras 8 segundos
    setTimeout(() => {
      console.log('♻️  Reconectando...')
      client?.destroy().catch(() => {})
      initClient()
    }, 8000)
  })

  // Guardar sesión cada 15 min como respaldo
  setInterval(saveSession, 15 * 60 * 1000)

  await client.initialize()
}

// ══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// Health check público
app.get('/', (req, res) => {
  res.json({ ok: true, ready: isReady, service: 'CarmoCream WhatsApp' })
})

// Ver QR en el navegador (protegido)
app.get('/status', auth, (req, res) => {
  if (isReady) {
    return res.send(`
      <div style="text-align:center;font-family:sans-serif;padding:40px;">
        <h1 style="color:#2D6A4F;">✅ WhatsApp Conectado</h1>
        <p>El cliente está listo para enviar mensajes.</p>
      </div>
    `)
  }
  if (lastQr) {
    return res.send(`
      <div style="text-align:center;font-family:sans-serif;padding:40px;">
        <h1 style="color:#2D6A4F;">🍦 Vincular CarmoCream</h1>
        <p>Escanea este código con tu WhatsApp:</p>
        <div style="background:white;padding:20px;display:inline-block;border:2px solid #2D6A4F;border-radius:15px;">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(lastQr)}" />
        </div>
        <p style="color:#666;margin-top:20px;">Refresca la página si el código no carga.</p>
        <script>setTimeout(()=>location.reload(), 30000)</script>
      </div>
    `)
  }
  res.send(`
    <div style="text-align:center;font-family:sans-serif;padding:40px;">
      <h1 style="color:#888;">⏳ Iniciando...</h1>
      <p>Espera unos segundos y refresca.</p>
      <script>setTimeout(()=>location.reload(), 5000)</script>
    </div>
  `)
})

// Enviar mensaje (llamado desde el frontend)
app.post('/send', auth, async (req, res) => {
  const { phone, message } = req.body
  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Faltan phone o message' })
  }
  if (!isReady || !client) {
    return res.status(503).json({ success: false, error: 'WhatsApp no está listo' })
  }

  // Normalizar teléfono
  const digits = String(phone).replace(/\D/g, '')
  const normalized = (digits.startsWith('34') && digits.length === 11)
    ? digits
    : digits.length === 9 ? `34${digits}` : digits
  const chatId = `${normalized}@c.us`

  try {
    console.log(`[Send] → ${chatId}`)
    await client.sendMessage(chatId, message)
    console.log(`[Send] ✅ Enviado a ${chatId}`)
    res.json({ success: true })
  } catch (err) {
    console.error(`[Send] ❌`, err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Logout forzado (genera nuevo QR en el siguiente restart)
app.post('/logout', auth, async (req, res) => {
  try {
    await client?.logout()
    await supabase.from('whatsapp_sessions').delete().eq('id', SESSION_KEY)
    res.json({ success: true, message: 'Sesión cerrada. Reinicia el servidor para nuevo QR.' })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ── Arrancar ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`)
  initClient().catch(err => console.error('Error fatal:', err))
})
