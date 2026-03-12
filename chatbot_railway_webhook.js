/**
 * chatbot_railway_webhook.js — CarmoCream v3.0
 * =====================================================
 * Máquina de estados completa:
 *   - Cancelación con validación de estado del pedido
 *   - Consulta de estado en tiempo real desde Supabase
 *   - Quejas → escalado inmediato al admin
 *   - Solicitud humana → takeover admin
 *   - Anti-spam y cooldown por cliente
 *   - Reglas estáticas personalizables desde el panel
 *   - Automatizaciones de marketing (recordatorios, fidelización)
 * =====================================================
 */

const WEB_URL    = process.env.SHOP_URL    || 'https://carmocream.vercel.app'
const ADMIN_PHONE = process.env.ADMIN_PHONE || '' // ej: 34612345678 (sin +)

// ── Estados en los que YA NO se puede cancelar ───────────────────────────────
const NO_CANCEL_STATES = ['preparing', 'ready', 'delivering', 'delivered']
const STATE_LABELS = {
  pending:    '⏳ Recibido, pendiente de confirmar',
  preparing:  '👨‍🍳 En preparación',
  ready:      '✅ Listo para recoger/entregar',
  delivering: '🛵 En camino hacia ti',
  delivered:  '🎉 Entregado',
  cancelled:  '❌ Cancelado',
}

module.exports = function setupChatbot(app, client, supabaseUrl, supabaseKey) {

  // ══════════════════════════════════════════════════════════════════
  //  ESTADO INTERNO
  // ══════════════════════════════════════════════════════════════════
  let chatbotEnabled = false
  let chatbotRules   = []

  // Conversaciones activas: phone → { state, pendingCancel, orderNum, ts }
  const conversations = new Map()
  // Anti-spam: teléfonos con cooldown activo
  const recentReplies = new Map() // phone → timestamp

  // ══════════════════════════════════════════════════════════════════
  //  SUPABASE HELPERS
  // ══════════════════════════════════════════════════════════════════
  async function sbFetch(path, opts = {}) {
    const url = `${supabaseUrl}/rest/v1/${path}`
    const res = await fetch(url, {
      ...opts,
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  }

  async function loadRules() {
    try {
      const data = await sbFetch('settings?key=in.(chatbot_enabled,chatbot_rules)&select=key,value')
      const map  = Object.fromEntries((data || []).map(r => [r.key, r.value]))
      chatbotEnabled = map.chatbot_enabled === 'true'
      try { const p = JSON.parse(map.chatbot_rules || '[]'); if (p.length) chatbotRules = p } catch {}
      console.log(`[Chatbot] Reglas: ${chatbotRules.length} (activo: ${chatbotEnabled})`)
    } catch (e) { console.error('[Chatbot] loadRules:', e.message) }
  }

  // Buscar último pedido activo por teléfono
  async function findLastOrder(phone) {
    try {
      const digits = phone.replace('@c.us', '').replace(/\D/g, '')
      // Buscar los últimos 5 números posibles (con/sin prefijo)
      const variants = [digits, digits.replace(/^34/, ''), '34' + digits.replace(/^34/, '')]
      const query = variants.map(v => `customer_phone.ilike.*${v.slice(-9)}*`).join(',')
      const data = await sbFetch(
        `orders?or=(${query})&status=neq.cancelled&order=created_at.desc&limit=1&select=id,order_number,status,total,created_at,items`
      )
      return (data || [])[0] || null
    } catch (e) { console.error('[Chatbot] findLastOrder:', e.message); return null }
  }

  // Cancelar un pedido
  async function cancelOrder(orderId) {
    try {
      await sbFetch(`orders?id=eq.${orderId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelled' }),
      })
      return true
    } catch (e) { console.error('[Chatbot] cancelOrder:', e.message); return false }
  }

  // Guardar escalación en Supabase
  async function saveEscalation(phone, reason, lastMessage) {
    try {
      await sbFetch('chatbot_conversations', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          phone,
          state: 'escalated',
          escalation_reason: reason,
          last_message: lastMessage,
          admin_takeover: false,
          resolved: false,
          updated_at: new Date().toISOString(),
        }),
      })
    } catch (e) { console.error('[Chatbot] saveEscalation:', e.message) }
  }

  // Notificar al admin por WhatsApp
  async function notifyAdmin(text) {
    if (!ADMIN_PHONE || !client) return
    try {
      await client.sendMessage(`${ADMIN_PHONE}@c.us`, text)
    } catch (e) { console.error('[Chatbot] notifyAdmin:', e.message) }
  }

  // ══════════════════════════════════════════════════════════════════
  //  MÁQUINA DE ESTADOS — lógica central del chatbot
  // ══════════════════════════════════════════════════════════════════
  async function handleMessage(phone, rawText) {
    if (!chatbotEnabled) return null

    const text = (rawText || '').trim()
    const norm = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    const conv = conversations.get(phone) || { state: 'idle' }

    // ── Admin takeover: bot silenciado para este número ───────────────
    if (conv.state === 'admin_takeover') return null

    // ── Fuera de horario: respuesta automática ────────────────────────
    const hour = new Date().getHours()
    const dayOfWeek = new Date().getDay() // 0=Dom, 1=Lun
    const isOpen = dayOfWeek !== 1 && hour >= 14 && hour < 21 // Mar-Dom 14-21
    // Solo para preguntas que implican querer pedir ahora mismo
    if (!isOpen && /pedir|pedido nuevo|hacer pedido|quiero pedir|quiero uno|ponme|quisiera/.test(norm)) {
      const nextOpen = dayOfWeek === 1 ? 'mañana martes' : hour < 14 ? 'hoy a las 14:00' : 'mañana'
      return `🕐 Ahora mismo estamos cerrados.

Nuestro horario: *Martes a Domingo · 14:00 – 21:00*

Abrimos ${nextOpen} — puedes hacer tu pedido ya en la web y lo preparamos en cuanto abramos:
👉 *${WEB_URL}*

¡Hasta pronto! 🍓`
    }

    // ── Anti-spam: máx 1 respuesta por msg en los últimos 2s ─────────
    const now = Date.now()
    const last = recentReplies.get(phone) || 0
    if (now - last < 2000) return null
    recentReplies.set(phone, now)

    // ═══════════════════════════════════════════════════════
    //  ESTADO: esperando_confirmacion_cancelacion
    //  Cliente dijo "cancelar", le pedimos confirmación
    // ═══════════════════════════════════════════════════════
    if (conv.state === 'waiting_cancel_confirm') {
      conversations.delete(phone)
      if (/^(si|sí|s|yes|confirmo|cancela|cancelar|dale|ok|claro|por favor)$/i.test(norm)) {
        const order = conv.order
        if (!order) return '❌ No encontré tu pedido. Escríbenos *"hablar"* para ayudarte.'

        // Verificar estado actual (puede haber cambiado)
        let freshOrder = null
        try {
          const data = await sbFetch(`orders?id=eq.${order.id}&select=id,order_number,status&limit=1`)
          freshOrder = (data || [])[0]
        } catch {}

        const currentStatus = freshOrder?.status || order.status
        if (NO_CANCEL_STATES.includes(currentStatus)) {
          return `⚠️ *Lo sentimos, ya no podemos cancelar el pedido #${order.order_number}.*\n\n` +
            `Estado actual: *${STATE_LABELS[currentStatus] || currentStatus}*\n\n` +
            `En esta fase el pedido ya está en marcha y no es posible detenerlo.\n\n` +
            `Si hay algún problema, escríbenos *"queja"* y te atendemos personalmente 🙏`
        }

        const ok = await cancelOrder(order.id)
        if (ok) {
          return `✅ *Pedido #${order.order_number} cancelado correctamente.*\n\n` +
            `Lamentamos que no hayas podido disfrutarlo esta vez.\n` +
            `Cuando quieras volver a pedir, aquí estamos 🍓\n\n_CarmoCream · Carmona_`
        }
        return `❌ Hubo un problema al cancelar. Escríbenos *"hablar"* y lo resolvemos ahora mismo.`
      }
      // Respondió no
      if (/^(no|nop|nope|nada|cancelar cancelacion|no cancelar)$/i.test(norm)) {
        return `✅ ¡Perfecto! Tu pedido sigue activo.\n\n¿Puedo ayudarte con algo más? 😊`
      }
      // Respuesta no reconocida
      return `No he entendido. Responde *Sí* para cancelar o *No* para mantener el pedido.`
    }

    // ═══════════════════════════════════════════════════════
    //  DETECTAR INTENCIÓN: CANCELAR
    // ═══════════════════════════════════════════════════════
    if (/cancelar|anular|quiero cancelar|cancela|no lo quiero|me arrepent|no quiero|borra/.test(norm)) {
      const order = await findLastOrder(phone)

      if (!order) {
        return `❌ No encontré ningún pedido activo en tu número.\n\n` +
          `Si crees que es un error, escríbenos *"hablar"* y lo revisamos 🙏`
      }

      // Pedido ya cancelado
      if (order.status === 'cancelled') {
        return `ℹ️ Tu pedido *#${order.order_number}* ya estaba cancelado anteriormente.`
      }

      // Pedido entregado
      if (order.status === 'delivered') {
        return `ℹ️ Tu pedido *#${order.order_number}* ya fue entregado, no es posible cancelarlo.\n\n` +
          `Si tuviste algún problema con él, escríbenos *"queja"* 🙏`
      }

      // BLOQUEO: ya está en preparación o más avanzado
      if (NO_CANCEL_STATES.includes(order.status)) {
        return `⚠️ *Lo sentimos, tu pedido #${order.order_number} ya no se puede cancelar.*\n\n` +
          `Estado actual: *${STATE_LABELS[order.status] || order.status}*\n\n` +
          `En esta fase ya está siendo preparado o en camino y no podemos pararlo.\n\n` +
          `Si tienes algún problema cuando lo recibas, escríbenos *"queja"* y te ayudamos 🙏`
      }

      // Pedido cancelable (pending) — pedir confirmación
      const total = Number(order.total || 0).toFixed(2)
      conversations.set(phone, { state: 'waiting_cancel_confirm', order, ts: now })
      return `⚠️ *¿Seguro que quieres cancelar tu pedido?*\n\n` +
        `📋 Pedido *#${order.order_number}* · €${total}\n` +
        `Estado: ${STATE_LABELS[order.status] || order.status}\n\n` +
        `Responde *Sí* para cancelar o *No* para mantenerlo.`
    }

    // ═══════════════════════════════════════════════════════
    //  DETECTAR INTENCIÓN: ESTADO DEL PEDIDO
    // ═══════════════════════════════════════════════════════
    if (/estado|donde esta|mi pedido|cuando llega|lo has recibido|confirmado|cuando sale|tardais|tardáis/.test(norm)) {
      const order = await findLastOrder(phone)
      if (!order) {
        return `📋 No encontré pedidos activos en tu número.\n\n¿Quieres hacer uno? 👇\n👉 *${WEB_URL}*`
      }
      const total   = Number(order.total || 0).toFixed(2)
      const created = new Date(order.created_at).toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' })
      return `📋 *Estado de tu pedido #${order.order_number}*\n\n` +
        `🕐 Pedido a las: ${created}\n` +
        `💰 Total: €${total}\n` +
        `Estado: *${STATE_LABELS[order.status] || order.status}*\n\n` +
        (order.status === 'delivering' ? `🛵 ¡Tu repartidor ya está en camino! En breve en tu puerta 🍓` :
         order.status === 'delivered'  ? `🎉 Pedido entregado. ¡Esperamos que lo hayas disfrutado!` :
         order.status === 'preparing'  ? `👨‍🍳 Estamos preparándolo con mucho cariño. En unos minutos sale 🛵` :
         `⏳ Lo hemos recibido y lo gestionamos en breve. Te avisamos por aquí cuando avance.`)
    }

    // ═══════════════════════════════════════════════════════
    //  DETECTAR INTENCIÓN: QUEJA / PROBLEMA
    // ═══════════════════════════════════════════════════════
    if (/queja|reclamacion|reclamación|problema|llego mal|llegó mal|faltaba|estaba mal|no llegó|no llego|frio|frío|derramado|roto|equivocado/.test(norm)) {
      await saveEscalation(phone, 'Queja/problema con pedido', text)
      await notifyAdmin(
        `🚨 *QUEJA — CarmoCream Chatbot*\n\n` +
        `📞 Cliente: ${phone.replace('@c.us','')}\n` +
        `💬 Mensaje: "${text.slice(0,200)}"\n\n` +
        `👉 Panel: ${WEB_URL}/admin → Chatbot → Escalaciones`
      )
      return `😔 Sentimos mucho que hayas tenido un problema.\n\n` +
        `Hemos notificado a nuestro equipo y alguien te contactará *en menos de 30 minutos* para solucionarlo.\n\n` +
        `Si es urgente también puedes escribirnos aquí mismo y te atendemos al momento 🙏\n\n_CarmoCream · Carmona_`
    }

    // ═══════════════════════════════════════════════════════
    //  DETECTAR INTENCIÓN: HABLAR CON HUMANO
    // ═══════════════════════════════════════════════════════
    if (/hablar|persona|humano|real|agente|operador|encargado|hablar con vosotros|necesito ayuda|ayuda urgente/.test(norm)) {
      await saveEscalation(phone, 'Cliente solicita atención humana', text)
      await notifyAdmin(
        `🙋 *ATENCIÓN HUMANA — CarmoCream*\n\n` +
        `📞 Cliente: ${phone.replace('@c.us','')}\n` +
        `💬 Mensaje: "${text.slice(0,200)}"\n\n` +
        `👉 Panel: ${WEB_URL}/admin → Chatbot → Escalaciones`
      )
      return `¡Claro! 🙋 He notificado a nuestro equipo.\n\n` +
        `Alguien te responderá *en este mismo chat en unos minutos*.\n\n` +
        `Mientras tanto, ¿hay algo más que pueda ayudarte? 😊`
    }

    // ═══════════════════════════════════════════════════════
    //  DETECTAR INTENCIÓN: SOLICITUD DE FACTURA / COMPROBANTE
    // ═══════════════════════════════════════════════════════
    if (/factura|ticket|comprobante|recibo/.test(norm)) {
      return `🧾 Actualmente solo trabajamos con pago en efectivo y no emitimos facturas fiscales.\n\n` +
        `Si necesitas un comprobante por escrito, escríbenos *"hablar"* y te lo preparamos manualmente 🙏`
    }

    // ═══════════════════════════════════════════════════════
    //  DETECTAR INTENCIÓN: FELICITACIÓN / AGRADECIMIENTO
    // ═══════════════════════════════════════════════════════
    if (/gracias|muchas gracias|genial|perfecto|excelente|muy bueno|riquísimo|estaba buenísimo|me encantó|me ha gustado|volvere|volveré/.test(norm)) {
      // Marcar que este cliente es fidelizable (guardar en Supabase)
      try {
        await sbFetch('chatbot_conversations', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ phone, state: 'happy', last_message: text, resolved: true, updated_at: new Date().toISOString() }),
        })
      } catch {}
      return `🍓 ¡Muchas gracias! Nos alegra un montón saberlo.\n\n` +
        `Si tienes un momento, una reseña en Google nos ayuda a llegar a más gente de Carmona:\n` +
        `👉 https://g.page/r/carmocream/review\n\n` +
        `*¿Tienes un amigo o familiar al que le gustaría probar CarmoCream?* Compárteles nuestro enlace 💚\n\n` +
        `👉 *${WEB_URL}*\n\n_¡Hasta pronto! @carmocream_`
    }

    // ═══════════════════════════════════════════════════════
    //  DETECTAR INTENCIÓN: MODIFICAR PEDIDO
    // ═══════════════════════════════════════════════════════
    if (/cambiar|modificar|cambio|añadir al pedido|quitar del pedido|otro sabor|cambiar dirección|cambiar direccion/.test(norm)) {
      const order = await findLastOrder(phone)
      if (!order) {
        return `❓ No encontré ningún pedido activo.\n\nPara hacer un nuevo pedido:\n👉 *${WEB_URL}*`
      }
      if (NO_CANCEL_STATES.includes(order.status)) {
        return `⚠️ Tu pedido *#${order.order_number}* ya está *${STATE_LABELS[order.status]}* y no se puede modificar.\n\n` +
          `Si hay un problema al recibirlo, escríbenos *"queja"* 🙏`
      }
      await saveEscalation(phone, 'Solicitud de modificación de pedido', text)
      await notifyAdmin(
        `✏️ *MODIFICACIÓN PEDIDO — CarmoCream*\n\n` +
        `📞 ${phone.replace('@c.us','')} · Pedido #${order.order_number} (€${Number(order.total||0).toFixed(2)})\n` +
        `💬 "${text.slice(0,150)}"\n\n👉 ${WEB_URL}/admin`
      )
      return `✏️ Recibida tu solicitud de cambio para el pedido *#${order.order_number}*.\n\n` +
        `Hemos avisado al equipo. Te confirmamos en breve si es posible.\n\n` +
        `Si es urgente escríbenos *"hablar"* 🙏`
    }

    // ═══════════════════════════════════════════════════════
    //  REGLAS ESTÁTICAS (cargadas desde el panel admin)
    // ═══════════════════════════════════════════════════════
    const staticRule = chatbotRules.find(r => {
      if (!r.active) return false
      return r.trigger
        .split(',')
        .map(t => t.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
        .some(kw => kw && norm.includes(kw))
    })
    if (staticRule) {
      return staticRule.response.replace(/\{\{web\}\}/g, WEB_URL)
    }

    // ═══════════════════════════════════════════════════════
    //  FALLBACK
    // ═══════════════════════════════════════════════════════
    return `👋 ¡Hola! Soy el asistente de *CarmoCream*.\n\n` +
      `Para hacer tu pedido o ver el menú:\n👉 *${WEB_URL}*\n\n` +
      `También puedo ayudarte con:\n` +
      `• Estado de tu pedido → escribe *"mi pedido"*\n` +
      `• Cancelar → escribe *"cancelar"*\n` +
      `• Hablar con nosotros → escribe *"hablar"*\n\n` +
      `_CarmoCream · Carmona · 100% Sin Lactosa_ 🍓`
  }

  // ══════════════════════════════════════════════════════════════════
  //  ESCUCHA DE MENSAJES ENTRANTES DE WHATSAPP
  // ══════════════════════════════════════════════════════════════════
  if (client && typeof client.on === 'function') {
    client.on('message', async (msg) => {
      try {
        const chat = await msg.getChat()
        if (chat.isGroup || msg.fromMe || msg.type === 'e2e_notification') return

        const phone = msg.from
        const reply = await handleMessage(phone, msg.body || '')
        if (!reply) return

        // Simular "escribiendo…" para naturalidad
        await chat.sendStateTyping()
        const delay = 1000 + Math.min((reply.length * 15), 3000)
        await new Promise(r => setTimeout(r, delay))
        await chat.clearState()

        await msg.reply(reply)
        console.log(`[Chatbot] ✅ ${phone}: "${(msg.body||'').slice(0,40)}" → ${reply.slice(0,60)}`)
      } catch (e) {
        console.error('[Chatbot] Error:', e.message)
      }
    })
    console.log('[Chatbot] Escucha activada ✅')
  }

  // ══════════════════════════════════════════════════════════════════
  //  ENDPOINTS HTTP
  // ══════════════════════════════════════════════════════════════════
  app.get('/webhook-status', (_, res) => res.json({ ok:true, chatbot:true, version:'3.0.0' }))

  app.get('/chatbot/status', (_, res) =>
    res.json({ ok:true, enabled:chatbotEnabled, rules:chatbotRules.length, conversations:conversations.size, version:'3.0.0' })
  )

  app.post('/chatbot/reload', (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok:false })
    loadRules().then(() => res.json({ ok:true, rules:chatbotRules.length, enabled:chatbotEnabled }))
  })

  app.post('/chatbot/test', async (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok:false })
    const { message, phone } = req.body || {}
    const reply = await handleMessage(phone || 'test@c.us', message || '')
    res.json({ matched:!!reply, reply })
  })

  app.post('/chatbot/takeover', (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok:false })
    const { phone, release } = req.body || {}
    if (release) {
      // Reactivar bot para ese número
      conversations.delete(phone)
      console.log(`[Chatbot] Bot reactivado para ${phone}`)
    } else {
      // Guardar estado de takeover (el bot ignorará mensajes de este número)
      conversations.set(phone, { state: 'admin_takeover', ts: Date.now() })
      console.log(`[Chatbot] Admin tomó el chat de ${phone}`)
    }
    res.json({ ok:true, phone, release })
  })

  // ── Cargar reglas al arrancar y refrescar cada 5 min ─────────────
  loadRules()
  setInterval(loadRules, 5 * 60 * 1000)

  // ── Limpiar conversaciones colgadas (> 30 min sin actividad) ─────
  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000
    for (const [phone, conv] of conversations.entries()) {
      if ((conv.ts || 0) < cutoff && conv.state !== 'admin_takeover') {
        conversations.delete(phone)
      }
    }
  }, 10 * 60 * 1000)
}
