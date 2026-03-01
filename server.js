// ══════════════════════════════════════════════════════════════════════════════
// server.js — CarmoCream WhatsApp Server (Railway)
// FIX: Reemplaza el SupabaseStore que fallaba por Timeout del zip
//      Solución: guardar/restaurar la sesión como Base64 directamente
//                en Supabase (tabla whatsapp_sessions), sin depender del
//                archivo .zip temporal que Railway destruye entre deploys.
// ══════════════════════════════════════════════════════════════════════════════

const express      = require('express')
const { Client, LocalAuth } = require('whatsapp-web.js')
const qrcode       = require('qrcode-terminal')
const { createClient } = require('@supabase/supabase-js')
const fs           = require('fs')
const path         = require('path')

const app    = express()
const PORT   = process.env.PORT || 3000
const SECRET = process.env.WA_SECRET || 'carmocream2024'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY   // usa service_role para bypass RLS
)

app.use(express.json())

// ── Middleware de autenticación ───────────────────────────────────────────────
function auth(req, res, next) {
  const secret = req.headers['x-secret'] || req.query.secret
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// ══════════════════════════════════════════════════════════════════════════════
// CUSTOM SESSION STORE  (sin zip, sin timeout)
// Guarda la sesión como JSON en Supabase → tabla: whatsapp_sessions
// ══════════════════════════════════════════════════════════════════════════════
//
// SQL para crear la tabla en Supabase (ejecutar una sola vez):
//
//   create table if not exists whatsapp_sessions (
//     id   text primary key,
//     data jsonb,
//     updated_at timestamptz default now()
//   );
//
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_ID  = 'carmocream'
const SESSION_KEY = `wa_session_${SESSION_ID}`

// Guarda la sesión en Supabase como jsonb
async function saveSessionToSupabase(sessionData) {
  try {
    const { error } = await supabase
      .from('whatsapp_sessions')
      .upsert({ id: SESSION_KEY, data: sessionData, updated_at: new Date().toISOString() })
    if (error) {
      console.error('[Session] Error guardando en Supabase:', error.message)
    } else {
      console.log('[Session] ✅ Sesión guardada en Supabase')
    }
  } catch (e) {
    console.error('[Session] Excepción al guardar:', e.message)
  }
}

// Carga la sesión desde Supabase
async function loadSessionFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('data')
      .eq('id', SESSION_KEY)
      .maybeSingle()
    if (error) { console.error('[Session] Error cargando:', error.message); return null }
    if (data?.data) { console.log('[Session] ✅ Sesión encontrada en Supabase'); return data.data }
    console.log('[Session] Sin sesión guardada — se generará QR')
    return null
  } catch (e) {
    console.error('[Session] Excepción al cargar:', e.message)
    return null
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CLIENTE WHATSAPP
// Usamos LocalAuth con dataPath en /tmp (persistente en el contenedor
// mientras corre, pero no entre deploys → por eso complementamos con Supabase)
// ══════════════════════════════════════════════════════════════════════════════

let client      = null
let isReady     = false
let qrGenerated = false

async function initClient() {
  // Restaurar sesión desde Supabase antes de arrancar el cliente
  const savedSession = await loadSessionFromSupabase()

  // Escribir la sesión al disco si existe, para que LocalAuth la encuentre
  const authDataPath = '/tmp/.wwebjs_auth'
  const sessionPath  = path.join(authDataPath, `session-${SESSION_ID}`)

  if (savedSession) {
    try {
      fs.mkdirSync(sessionPath, { recursive: true })
      fs.writeFileSync(
        path.join(sessionPath, 'session.json'),
        JSON.stringify(savedSession),
        'utf8'
      )
      console.log('[Session] Sesión restaurada al disco desde Supabase')
    } catch (e) {
      console.error('[Session] Error escribiendo sesión al disco:', e.message)
    }
  }

  client = new Client({
    authStrategy: new LocalAuth({
      clientId:  SESSION_ID,
      dataPath:  authDataPath,
    }),
    puppeteer: {
      headless: true,
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
    qrGenerated = true
    console.log('QR generado — visita la URL del servidor para escanearlo')
    qrcode.generate(qr, { small: true })
    // Guardar QR en memoria para endpoint /qr
    currentQR = qr
  })

  client.on('authenticated', async (session) => {
    console.log('🔐 Autenticado correctamente')
    qrGenerated = false
    currentQR   = null
    // Guardar sesión en Supabase inmediatamente tras autenticación
    if (session) {
      await saveSessionToSupabase(session)
    }
  })

  client.on('ready', () => {
    console.log('✅ WhatsApp conectado y listo')
    isReady = true
  })

  client.on('disconnected', async (reason) => {
    console.warn('⚠️ WhatsApp desconectado:', reason)
    isReady = false
    // Limpiar sesión si fue logout explícito
    if (reason === 'LOGOUT') {
      await supabase.from('whatsapp_sessions').delete().eq('id', SESSION_KEY)
      console.log('[Session] Sesión eliminada de Supabase (logout)')
    }
    // Reconectar tras 5 segundos
    setTimeout(() => {
      console.log('♻️ Reconectando WhatsApp...')
      isReady = false
      client?.destroy().catch(() => {})
      initClient()
    }, 5000)
  })

  // Guardar sesión periódicamente como respaldo (cada 10 min)
  setInterval(async () => {
    if (!isReady || !client) return
    try {
      const session = await client.getState()
      if (session === 'CONNECTED') {
        // wwebjs no expone getSessionData directamente con LocalAuth,
        // pero podemos leer el archivo de sesión y guardarlo
        const sessionFile = path.join(sessionPath, 'session.json')
        if (fs.existsSync(sessionFile)) {
          const raw = fs.readFileSync(sessionFile, 'utf8')
          await saveSessionToSupabase(JSON.parse(raw))
        }
      }
    } catch (e) {
      // Silencioso — es solo respaldo
    }
  }, 10 * 60 * 1000)

  await client.initialize()
}

let currentQR = null

// ══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// Health check público
app.get('/health', (req, res) => {
  res.json({ ok: true, ready: isReady, qr: !!currentQR })
})

// Ver QR (para escanear cuando no hay sesión)
app.get('/qr', auth, (req, res) => {
  if (isReady)    return res.json({ status: 'connected' })
  if (!currentQR) return res.json({ status: 'waiting_qr', message: 'Arrancando, espera unos segundos...' })
  res.json({ status: 'qr_ready', qr: currentQR })
})

// Enviar mensaje
app.post('/send', auth, async (req, res) => {
  const { phone, message } = req.body

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Faltan phone o message' })
  }

  if (!isReady || !client) {
    return res.status(503).json({ success: false, error: 'WhatsApp no está listo aún' })
  }

  // Normalizar teléfono
  const digits = String(phone).replace(/\D/g, '')
  const normalized = digits.startsWith('34') && digits.length === 11
    ? digits
    : digits.length === 9 ? `34${digits}` : digits

  const chatId = `${normalized}@c.us`

  try {
    console.log(`[Send] → ${chatId}`)
    await client.sendMessage(chatId, message)
    console.log(`[Send] ✅ Enviado a ${chatId}`)
    res.json({ success: true })
  } catch (err) {
    console.error(`[Send] ❌ Error:`, err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Logout (fuerza re-QR)
app.post('/logout', auth, async (req, res) => {
  try {
    await client?.logout()
    await supabase.from('whatsapp_sessions').delete().eq('id', SESSION_KEY)
    res.json({ success: true, message: 'Sesión cerrada. Reinicia el servidor para generar nuevo QR.' })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ── Arrancar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`)
  initClient().catch(err => {
    console.error('Error fatal inicializando WhatsApp:', err)
  })
})
