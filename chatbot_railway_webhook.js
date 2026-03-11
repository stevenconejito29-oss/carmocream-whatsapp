/**
 * chatbot_railway_webhook.js — CarmoCream
 * =====================================================
 * INSTRUCCIONES DE INTEGRACIÓN EN RAILWAY:
 *
 * 1. Copia este archivo en la raíz de tu proyecto Railway WA.
 * 2. En tu server.js principal, añade al final:
 *      require('./chatbot_railway_webhook')(app, client, SUPABASE_URL, SUPABASE_KEY)
 * 3. Asegúrate de que el cliente WA (whatsapp-web.js) esté expuesto como `client`.
 * 4. Añade las variables de entorno en Railway:
 *      SUPABASE_URL=<tu URL de Supabase>
 *      SUPABASE_ANON_KEY=<tu anon key de Supabase>
 * 5. Redeploy. Verifica en el panel Admin > Chatbot WA > "Verificar webhook".
 * =====================================================
 */

const WEB_URL = process.env.SHOP_URL || 'https://carmocream.vercel.app'

module.exports = function setupChatbot(app, client, supabaseUrl, supabaseKey) {
  // ── Health check del webhook ──────────────────────────────────────
  app.get('/webhook-status', (req, res) => {
    res.json({ ok: true, chatbot: true, version: '1.0.0' })
  })

  // ── Estado del chatbot (para verificación desde el panel admin) ───
  app.get('/chatbot/status', (req, res) => {
    res.json({ ok: true, enabled: chatbotEnabled, rules: chatbotRules.length, version: '1.0.0' })
  })

  // ── Cargar reglas desde Supabase ──────────────────────────────────
  let chatbotEnabled = false
  let chatbotRules   = []

  async function loadRules() {
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/settings?key=in.(chatbot_enabled,chatbot_rules)&select=key,value`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
      )
      const data = await res.json()
      const map  = Object.fromEntries((data || []).map(r => [r.key, r.value]))
      chatbotEnabled = map.chatbot_enabled === 'true'
      try { chatbotRules = JSON.parse(map.chatbot_rules || '[]') } catch { chatbotRules = [] }
      console.log(`[Chatbot] Reglas cargadas: ${chatbotRules.length} (activo: ${chatbotEnabled})`)
    } catch (e) {
      console.error('[Chatbot] Error cargando reglas:', e.message)
    }
  }

  // Cargar al arrancar y refrescar cada 5 minutos
  loadRules()
  setInterval(loadRules, 5 * 60 * 1000)

  // ── Función de matching ───────────────────────────────────────────
  function findReply(messageText) {
    if (!chatbotEnabled || !chatbotRules.length) return null
    const msg = messageText.toLowerCase().trim()
    const rule = chatbotRules.find(r => {
      if (!r.active) return false
      return r.trigger
        .split(',')
        .map(t => t.trim().toLowerCase())
        .some(kw => kw && msg.includes(kw))
    })
    return rule ? rule.response.replace(/\{\{web\}\}/g, WEB_URL) : null
  }

  // ── Escuchar mensajes entrantes de WhatsApp ───────────────────────
  // IMPORTANTE: client debe ser la instancia de whatsapp-web.js
  if (client && typeof client.on === 'function') {
    client.on('message', async (msg) => {
      try {
        // Solo responder a chats individuales (no grupos)
        const chat = await msg.getChat()
        if (chat.isGroup) return

        // No responder a mensajes propios ni de status
        if (msg.fromMe) return
        if (msg.type === 'e2e_notification') return

        const reply = findReply(msg.body || '')
        if (!reply) return

        // Anti-spam: no responder dos veces en 10 min al mismo número
        const contact = msg.from
        if (recentReplies.has(contact)) return
        recentReplies.add(contact)
        setTimeout(() => recentReplies.delete(contact), 10 * 60 * 1000)

        // Simular "escribiendo…"
        await chat.sendStateTyping()
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 800))
        await chat.clearState()

        await msg.reply(reply)
        console.log(`[Chatbot] ✅ Respondido a ${contact}: "${(msg.body || '').slice(0, 40)}"`)
      } catch (e) {
        console.error('[Chatbot] Error procesando mensaje:', e.message)
      }
    })
    console.log('[Chatbot] Escucha de mensajes entrantes activada ✅')
  } else {
    console.warn('[Chatbot] ⚠️  client.on no disponible — asegúrate de pasar el cliente WA correcto')
  }

  // ── Control de anti-spam ──────────────────────────────────────────
  const recentReplies = new Set()

  // ── Endpoint manual para forzar recarga de reglas ─────────────────
  app.post('/chatbot/reload', (req, res) => {
    const secret = req.headers['x-secret']
    if (secret !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    loadRules().then(() => res.json({ ok: true, rules: chatbotRules.length, enabled: chatbotEnabled }))
  })

  // ── Endpoint de prueba de matching (para debug) ───────────────────
  app.post('/chatbot/test', (req, res) => {
    const secret = req.headers['x-secret']
    if (secret !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    const { message } = req.body || {}
    const reply = findReply(message || '')
    res.json({ matched: !!reply, reply })
  })
}
