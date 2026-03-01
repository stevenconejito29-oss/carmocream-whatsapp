// server.js — CarmoCream WhatsApp (Railway)
// ✅ Versión segura: CORS restringido, rate limiting, validaciones, sin secretos hardcodeados

const express    = require('express')
const { Client, LocalAuth } = require('whatsapp-web.js')
const { createClient }      = require('@supabase/supabase-js')
const cors       = require('cors')
const rateLimit  = require('express-rate-limit')
const fs         = require('fs')
const path       = require('path')

const app  = express()
const PORT = process.env.PORT || 3000

// ── 🔐 Secreto obligatorio — falla si no está en variables de entorno ─────────
const SECRET = process.env.WA_SECRET
if (!SECRET) {
  console.error('❌ FATAL: WA_SECRET no está configurado en las variables de entorno de Railway.')
  console.error('   Ve a Railway → tu servicio → Variables → añade WA_SECRET=un-secreto-seguro')
  process.exit(1)
}

// ── 🔐 CORS — solo acepta peticiones desde tu dominio ─────────────────────────
// Añade aquí todos los dominios desde los que llamas al servidor
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

// Si no hay ALLOWED_ORIGINS configurado, solo permite localhost en desarrollo
if (ALLOWED_ORIGINS.length === 0) {
  console.warn('⚠️  ALLOWED_ORIGINS no configurado. Solo se permite localhost.')
  ALLOWED_ORIGINS.push('http://localhost:5173', 'http://localhost:3000')
}

app.use(cors({
  origin: (origin, callback) => {
    // Permitir peticiones sin origin (Postman, curl, Railway health checks)
    if (!origin) return callback(null, true)
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
    console.warn(`[CORS] Bloqueado origin: ${origin}`)
    callback(new Error(`Origin no permitido: ${origin}`))
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-secret'],
}))
app.options('*', cors())

// ── Supabase (service_role para bypass RLS) ───────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── Body parser con límite de tamaño ─────────────────────────────────────────
app.use(express.json({ limit: '50kb' }))

// ── 🔐 Auth middleware ────────────────────────────────────────────────────────
function auth(req, res, next) {
  const secret = req.headers['x-secret'] || req.query.secret
  if (!secret || secret !== SECRET) {
    console.warn(`[Auth] Intento no autorizado desde ${req.ip}`)
    return res.status(401).json({ error: 'No autorizado' })
  }
  next()
}

// ── 🔐 Rate limiting — máx 30 peticiones/minuto por IP en /send ───────────────
const sendLimiter = rateLimit({
  windowMs:        60 * 1000,   // 1 minuto
  max:             30,           // máx 30 mensajes por minuto por IP
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (req, res) => {
    console.warn(`[RateLimit] IP bloqueada: ${req.ip}`)
    res.status(429).json({ success: false, error: 'Demasiadas peticiones. Espera un minuto.' })
  },
})

// Rate limit general — máx 100 peticiones/minuto por IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
})
app.use(globalLimiter)

// ── 🔐 Validar número de teléfono ────────────────────────────────────────────
function validatePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (digits.length < 9 || digits.length > 15) return null
  // Normalizar a formato internacional
  if (digits.startsWith('34') && digits.length === 11) return digits
  if (digits.length === 9) return `34${digits}`
  if (digits.length >= 10) return digits
  return null
}

// ── 🔐 Sanitizar mensaje ──────────────────────────────────────────────────────
function sanitizeMessage(raw) {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 2000) return null
  return trimmed
}

// ══════════════════════════════════════════════════════════════════════════════
// SESIÓN EN SUPABASE
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
    setTimeout(saveSession, 3000)
  })

  client.on('ready', () => {
    console.log('✅ WhatsApp conectado y listo')
    isReady = true
    lastQr  = null
    setTimeout(saveSession, 2000)
  })

  client.on('disconnected', async (reason) => {
    console.warn('⚠️ Desconectado:', reason)
    isReady = false
    if (reason === 'LOGOUT') {
      await supabase.from('whatsapp_sessions').delete().eq('id', SESSION_KEY)
      console.log('[Session] Eliminada de Supabase (logout)')
    }
    setTimeout(() => {
      console.log('♻️  Reconectando...')
      client?.destroy().catch(() => {})
      initClient()
    }, 8000)
  })

  setInterval(saveSession, 15 * 60 * 1000)
  await client.initialize()
}

// ══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// ── Health check público — solo confirma que el servicio responde ─────────────
// No expone el estado interno (isReady) sin autenticación
app.get('/', (req, res) => {
  const secret = req.headers['x-secret'] || req.query.secret
  if (secret && secret === SECRET) {
    // Con auth → devuelve estado completo
    return res.json({ ok: true, ready: isReady, service: 'CarmoCream WhatsApp' })
  }
  // Sin auth → solo confirma que el servidor está vivo
  res.json({ ok: true, service: 'CarmoCream WhatsApp' })
})

// ── Ver QR en el navegador (protegido) ───────────────────────────────────────
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

// ── Enviar mensaje ────────────────────────────────────────────────────────────
app.post('/send', auth, sendLimiter, async (req, res) => {
  const phone   = validatePhone(req.body.phone)
  const message = sanitizeMessage(req.body.message)

  if (!phone) {
    return res.status(400).json({ success: false, error: 'Teléfono inválido o fuera de rango (9-15 dígitos)' })
  }
  if (!message) {
    return res.status(400).json({ success: false, error: 'Mensaje vacío o demasiado largo (máx 2000 caracteres)' })
  }
  if (!isReady || !client) {
    return res.status(503).json({ success: false, error: 'WhatsApp no está listo' })
  }

  const chatId = `${phone}@c.us`

  try {
    console.log(`[Send] → ${chatId} (${message.length} chars)`)
    await client.sendMessage(chatId, message)
    console.log(`[Send] ✅ Enviado a ${chatId}`)
    res.json({ success: true })
  } catch (err) {
    console.error(`[Send] ❌`, err.message)
    // "No LID for user" = el número no tiene WhatsApp activo o es cuenta nueva
    const userMsg = err.message?.includes('No LID')
      ? 'El número no tiene WhatsApp activo'
      : err.message
    res.status(500).json({ success: false, error: userMsg })
  }
})

// ── Logout forzado ────────────────────────────────────────────────────────────
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
  console.log(`🔐 CORS permitido para: ${ALLOWED_ORIGINS.join(', ')}`)
  initClient().catch(err => console.error('Error fatal:', err))
})
