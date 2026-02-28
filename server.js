const express = require('express')
const cors = require('cors')
const qrcode = require('qrcode')
const { Client, LocalAuth } = require('whatsapp-web.js')

const app = express()
const PORT = process.env.PORT || 3000
const SECRET = process.env.WA_SECRET || 'carmocream2024'

app.use(cors())
app.use(express.json())

let qrImageBase64 = null
let isReady = false
let client = null

function initClient() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/wwebjs_auth' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/run/current-system/sw/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  })

  client.on('qr', async (qr) => {
    console.log('QR generado — visita la URL del servidor para escanearlo')
    isReady = false
    try {
      qrImageBase64 = await qrcode.toDataURL(qr)
    } catch (e) {
      console.error('Error generando QR:', e)
    }
  })

  client.on('ready', () => {
    console.log('WhatsApp conectado y listo')
    isReady = true
    qrImageBase64 = null
  })

  client.on('authenticated', () => {
    console.log('Autenticado correctamente')
  })

  client.on('auth_failure', (msg) => {
    console.error('Fallo de autenticacion:', msg)
    isReady = false
  })

  client.on('disconnected', (reason) => {
    console.log('Desconectado:', reason)
    isReady = false
    setTimeout(() => {
      console.log('Reintentando conexion...')
      initClient()
    }, 5000)
  })

  client.initialize()
}

initClient()

function checkSecret(req, res, next) {
  const secret = req.headers['x-secret'] || req.query.secret
  if (secret !== SECRET) {
    return res.status(401).json({ error: 'No autorizado' })
  }
  next()
}

app.get('/', (req, res) => {
  if (isReady) {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>CarmoCream WA</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0fdf4;}
    .card{background:white;border-radius:20px;padding:40px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.1);max-width:400px;width:90%;}
    h1{color:#2d6a4f;} .status{background:#dcfce7;color:#166534;padding:8px 20px;border-radius:20px;font-weight:700;display:inline-block;margin-top:16px;}</style>
    </head><body><div class="card"><div style="font-size:4rem">✅</div><h1>CarmoCream WhatsApp</h1>
    <p style="color:#6b7280">El servidor esta conectado y enviando mensajes automaticamente.</p>
    <div class="status">&#9679; Conectado</div></div></body></html>`)
  } else if (qrImageBase64) {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>CarmoCream WA - Escanea QR</title>
    <meta http-equiv="refresh" content="30">
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0fdf4;}
    .card{background:white;border-radius:20px;padding:40px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.1);max-width:440px;width:90%;}
    h1{color:#2d6a4f;font-size:1.4rem;} img{width:260px;height:260px;border:3px solid #d1fae5;border-radius:12px;}
    p{color:#6b7280;font-size:0.9rem;}</style>
    </head><body><div class="card"><div style="font-size:3rem">📱</div><h1>Escanea con tu WhatsApp</h1>
    <p>Abre WhatsApp en tu movil → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${qrImageBase64}" alt="QR WhatsApp" />
    <p style="font-size:0.75rem;color:#9ca3af;margin-top:16px">La pagina se recarga sola cada 30 segundos</p>
    </div></body></html>`)
  } else {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>CarmoCream WA - Iniciando</title>
    <meta http-equiv="refresh" content="5">
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0fdf4;}
    .card{background:white;border-radius:20px;padding:40px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.1);}
    h1{color:#2d6a4f;}</style>
    </head><body><div class="card"><h1>⏳ Iniciando servidor...</h1>
    <p style="color:#6b7280">El QR aparecera en unos segundos. La pagina se recarga sola.</p>
    </div></body></html>`)
  }
})

app.get('/status', (req, res) => {
  res.json({ ready: isReady, hasQr: !!qrImageBase64 })
})

app.post('/send', checkSecret, async (req, res) => {
  const { phone, message } = req.body

  if (!phone || !message) {
    return res.status(400).json({ error: 'Faltan phone y message' })
  }

  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp no esta conectado. Escanea el QR en /' })
  }

  try {
    const clean = phone.replace(/[^\d]/g, '')
    const chatId = clean + '@c.us'
    await client.sendMessage(chatId, message)
    console.log('Mensaje enviado a ' + clean)
    res.json({ success: true, to: clean })
  } catch (err) {
    console.error('Error enviando mensaje:', err)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log('Servidor CarmoCream WhatsApp en puerto ' + PORT)
})
