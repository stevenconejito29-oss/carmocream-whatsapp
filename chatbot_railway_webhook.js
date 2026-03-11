/**
 * chatbot_railway_webhook.js — CarmoCream v2.0
 * ─────────────────────────────────────────────
 * Chatbot inteligente con máquina de estados:
 *  • Cancelación de pedidos por WA
 *  • Estado del pedido en tiempo real
 *  • Escalado automático a admin + notificación
 *  • Admin puede tomar el chat desde el panel
 *  • 20+ casos comunes cubiertos automáticamente
 *
 * Variables de entorno Railway necesarias:
 *   SUPABASE_URL, SUPABASE_ANON_KEY (o SERVICE_ROLE_KEY)
 *   ADMIN_PHONE   — número del admin sin + (ej: 34622663874)
 *   SHOP_URL      — URL de la tienda (ej: https://carmocream.vercel.app)
 */

const WEB_URL    = process.env.SHOP_URL    || 'https://carmocream.vercel.app'
const ADMIN_PHONE = process.env.ADMIN_PHONE || ''

// ── Estados de conversación ───────────────────────────────────────────────────
const STATE = {
  IDLE:                  'idle',
  CANCEL_NEED_NUMBER:    'cancel_need_number',
  CANCEL_NEED_CONFIRM:   'cancel_need_confirm',
  STATUS_NEED_NUMBER:    'status_need_number',
  COMPLAINT_NEED_DETAIL: 'complaint_need_detail',
  ESCALATED:             'escalated',
}

// ── Emojis de estado de pedido ────────────────────────────────────────────────
const STATUS_EMOJI = {
  pending:    '⏳ Recibido',
  preparing:  '👨‍🍳 Preparando',
  ready:      '✅ Listo para enviar',
  delivering: '🛵 En camino',
  delivered:  '🎉 Entregado',
  cancelled:  '❌ Cancelado',
}

module.exports = function setupChatbot(app, client, supabaseUrl, supabaseKey) {

  // ── Cache local de conversaciones ─────────────────────────────────────────
  // { phone: { state, context, adminTakeover, lastActivity } }
  const conversations = new Map()

  // ── Anti-spam para respuestas estáticas ───────────────────────────────────
  const staticReplyCooldown = new Map() // phone → timestamp

  // ── Config dinámica cargada desde Supabase settings ───────────────────────
  let chatbotEnabled = false
  let staticRules    = []

  // ════════════════════════════════════════════════════════════════════════════
  // SUPABASE HELPERS
  // ════════════════════════════════════════════════════════════════════════════

  async function sbFetch(path, options = {}) {
    const res = await fetch(`${supabaseUrl}/rest/v1${path}`, {
      ...options,
      headers: {
        apikey:        supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer:         'return=representation',
        ...(options.headers || {}),
      },
    })
    const text = await res.text()
    try { return JSON.parse(text) } catch { return text }
  }

  async function loadConfig() {
    try {
      const data = await sbFetch('/settings?key=in.(chatbot_enabled,chatbot_rules)&select=key,value')
      const map  = Object.fromEntries((data || []).map(r => [r.key, r.value]))
      chatbotEnabled = map.chatbot_enabled === 'true'
      try { staticRules = JSON.parse(map.chatbot_rules || '[]') } catch { staticRules = [] }
      console.log(`[Chatbot] Config cargada — activo:${chatbotEnabled} reglas:${staticRules.length}`)
    } catch (e) { console.error('[Chatbot] Error cargando config:', e.message) }
  }

  // Buscar pedido por número o por teléfono
  async function findOrderByNumber(rawNum) {
    const num = String(rawNum).replace(/\D/g, '')
    if (!num) return null
    const data = await sbFetch(
      `/orders?order_number=eq.${num}&select=id,order_number,status,total,customer_name,customer_phone,delivery_address,created_at&limit=1`
    )
    return Array.isArray(data) && data.length ? data[0] : null
  }

  async function findLatestOrderByPhone(phone) {
    // Busca por los últimos 9 dígitos del teléfono para tolerar prefijos
    const digits = phone.replace(/\D/g, '').slice(-9)
    const data = await sbFetch(
      `/orders?customer_phone=ilike.*${digits}*&select=id,order_number,status,total,customer_name,customer_phone,delivery_address,created_at&order=created_at.desc&limit=3`
    )
    return Array.isArray(data) ? data : []
  }

  async function cancelOrder(orderId) {
    return sbFetch(`/orders?id=eq.${orderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled' }),
    })
  }

  // Guardar conversación escalada en Supabase para el panel admin
  async function saveEscalation(phone, message, reason) {
    try {
      await sbFetch('/chatbot_conversations', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          phone,
          state:          STATE.ESCALATED,
          last_message:   message,
          escalation_reason: reason,
          admin_takeover: false,
          updated_at:     new Date().toISOString(),
        }),
      })
    } catch (e) { console.error('[Chatbot] Error guardando escalación:', e.message) }
  }

  async function setAdminTakeover(phone, value) {
    try {
      await sbFetch(`/chatbot_conversations?phone=eq.${encodeURIComponent(phone)}`, {
        method: 'PATCH',
        body: JSON.stringify({ admin_takeover: value, updated_at: new Date().toISOString() }),
      })
    } catch {}
  }

  async function checkAdminTakeover(phone) {
    try {
      const data = await sbFetch(
        `/chatbot_conversations?phone=eq.${encodeURIComponent(phone)}&select=admin_takeover&limit=1`
      )
      return Array.isArray(data) && data[0]?.admin_takeover === true
    } catch { return false }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // GESTIÓN DE ESTADO LOCAL
  // ════════════════════════════════════════════════════════════════════════════

  function getConv(phone) {
    if (!conversations.has(phone)) {
      conversations.set(phone, { state: STATE.IDLE, context: {}, lastActivity: Date.now() })
    }
    return conversations.get(phone)
  }

  function setState(phone, state, context = {}) {
    conversations.set(phone, { state, context, adminTakeover: false, lastActivity: Date.now() })
  }

  function resetConv(phone) {
    conversations.set(phone, { state: STATE.IDLE, context: {}, lastActivity: Date.now() })
  }

  // Limpiar conversaciones inactivas > 30 min
  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000
    for (const [phone, conv] of conversations.entries()) {
      if (conv.lastActivity < cutoff && conv.state !== STATE.ESCALATED) {
        conversations.delete(phone)
      }
    }
  }, 10 * 60 * 1000)

  // ════════════════════════════════════════════════════════════════════════════
  // ENVÍO DE MENSAJES
  // ════════════════════════════════════════════════════════════════════════════

  async function reply(chat, msg, text) {
    try {
      await chat.sendStateTyping()
      await new Promise(r => setTimeout(r, 800 + Math.random() * 700))
      await chat.clearState()
      await msg.reply(text)
    } catch (e) { console.error('[Chatbot] Error enviando respuesta:', e.message) }
  }

  async function notifyAdmin(phone, message, reason) {
    if (!ADMIN_PHONE || !client) return
    try {
      const text = `⚠️ *CarmoCream — Atención requerida*\n\n📞 Cliente: +${phone.replace('@c.us','').replace(/\D/g,'')}\n🔖 Motivo: ${reason}\n💬 Mensaje: "${message.slice(0,120)}"\n\n_Responde a este cliente desde tu WhatsApp o gestiona desde el panel admin._`
      await client.sendMessage(`${ADMIN_PHONE}@c.us`, text)
      console.log(`[Chatbot] 🔔 Admin notificado — ${reason}`)
    } catch (e) { console.error('[Chatbot] Error notificando admin:', e.message) }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DETECCIÓN DE INTENCIONES
  // ════════════════════════════════════════════════════════════════════════════

  function normalize(text) { return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') }

  function hasAny(text, keywords) {
    const n = normalize(text)
    return keywords.some(k => n.includes(normalize(k)))
  }

  // Intención de CANCELAR pedido
  function isCancelIntent(text) {
    return hasAny(text, ['cancelar','anular','cancela','anula','no quiero','me arrepiento','quiero cancelar'])
  }

  // Intención de ver ESTADO del pedido
  function isStatusIntent(text) {
    return hasAny(text, ['estado','donde esta','dónde está','mi pedido','cuando llega','cuándo llega',
      'cuanto tarda','cuánto tarda','ha salido','lo han','lo están','preparando','repartidor','sigue'])
  }

  // Intención de QUEJA / problema
  function isComplaintIntent(text) {
    return hasAny(text, ['queja','reclamacion','reclamación','llegó mal','llego mal','faltó','falto',
      'falta algo','estaba mal','estaba frio','estaba frío','no llegó','no llego','producto mal',
      'cobro mal','cobro doble','me han cobrado','devolver','devolucion','devolución','reembolso'])
  }

  // Intención de HABLAR con humano
  function isHumanIntent(text) {
    return hasAny(text, ['hablar con alguien','hablar con una persona','persona real','humano',
      'hablar con vosotros','llamar','teléfono','telefono','atención al cliente','atencion al cliente',
      'quiero hablar','necesito hablar'])
  }

  // Intención de REPETIR pedido
  function isRepeatIntent(text) {
    return hasAny(text, ['mismo pedido','repetir pedido','el mismo','quiero lo mismo','como la ultima vez'])
  }

  // Afirmación / confirmación
  function isYes(text) {
    return hasAny(text, ['si','sí','yes','confirmo','confirmar','ok','dale','adelante','cancela','cancelar'])
  }

  // Negación
  function isNo(text) {
    return hasAny(text, ['no','nope','espera','para','cancela no','no cancelar'])
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FLUJOS DE CONVERSACIÓN
  // ════════════════════════════════════════════════════════════════════════════

  async function handleCancelFlow(phone, text, chat, msg, conv) {
    // Estado: pedir número de pedido
    if (conv.state === STATE.IDLE) {
      setState(phone, STATE.CANCEL_NEED_NUMBER)
      await reply(chat, msg,
        '😟 Claro, te ayudo a cancelar.\n\n¿Cuál es el *número de pedido*? Lo encontrarás en el mensaje de confirmación que te enviamos (ej: *#42*).\n\nSi no lo tienes, escribe tu *nombre y apellido* y lo busco yo.'
      )
      return
    }

    // Estado: tenemos el número, buscamos el pedido
    if (conv.state === STATE.CANCEL_NEED_NUMBER) {
      // Extraer número del mensaje (ej: "42", "#42", "pedido 42")
      const match = text.match(/\d+/)
      let order = null

      if (match) {
        order = await findOrderByNumber(match[0])
      }

      // Si no encontró por número, intenta por teléfono del chat
      if (!order) {
        const phoneDigits = phone.replace('@c.us', '').replace(/\D/g, '')
        const orders = await findLatestOrderByPhone(phoneDigits)
        if (orders.length === 1) order = orders[0]
        else if (orders.length > 1) {
          setState(phone, STATE.CANCEL_NEED_NUMBER, { multipleOrders: orders })
          const list = orders.map(o => `• *#${o.order_number}* — ${STATUS_EMOJI[o.status] || o.status} — €${o.total}`).join('\n')
          await reply(chat, msg, `Encontré varios pedidos tuyos:\n\n${list}\n\n¿De cuál quieres cancelar? Escribe el número (ej: *42*).`)
          return
        }
      }

      if (!order) {
        await reply(chat, msg,
          '🔍 No encontré ningún pedido con ese número.\n\nVerifica el número e inténtalo de nuevo, o escribe *"ayuda"* para hablar con nosotros.'
        )
        return
      }

      // Pedido encontrado — verificar si se puede cancelar
      const cancellable = ['pending', 'preparing'].includes(order.status)
      if (!cancellable) {
        resetConv(phone)
        if (order.status === 'delivering') {
          await reply(chat, msg,
            `🛵 *Pedido #${order.order_number}* ya está *en camino* — no es posible cancelarlo.\n\nSi tienes un problema con el pedido cuando llegue, escríbenos y lo solucionamos 🙏`
          )
        } else if (order.status === 'delivered') {
          await reply(chat, msg,
            `✅ *Pedido #${order.order_number}* ya fue entregado.\n\nSi tuviste algún problema, escríbenos "queja" y te ayudamos.`
          )
        } else if (order.status === 'cancelled') {
          await reply(chat, msg, `❌ El pedido *#${order.order_number}* ya estaba cancelado.`)
        }
        return
      }

      // Pedir confirmación
      setState(phone, STATE.CANCEL_NEED_CONFIRM, { orderId: order.id, orderNumber: order.order_number, orderTotal: order.total, orderStatus: order.status })
      await reply(chat, msg,
        `Encontré tu pedido:\n\n📋 *Pedido #${order.order_number}*\n💰 Total: €${order.total}\n📍 Estado: ${STATUS_EMOJI[order.status]}\n\n¿Confirmas la *cancelación*? Responde *SÍ* para cancelar o *NO* para mantenerlo.`
      )
      return
    }

    // Estado: esperando confirmación SÍ/NO
    if (conv.state === STATE.CANCEL_NEED_CONFIRM) {
      if (isYes(text)) {
        await cancelOrder(conv.context.orderId)
        await notifyAdmin(
          phone,
          `Cancelación pedido #${conv.context.orderNumber} (€${conv.context.orderTotal})`,
          `Cancelación por cliente`
        )
        resetConv(phone)
        await reply(chat, msg,
          `✅ *Pedido #${conv.context.orderNumber} cancelado correctamente.*\n\nSentimos no poder prepararte tu pedido esta vez 😔\nEstaremos aquí cuando quieras volver a pedir:\n👉 ${WEB_URL}\n\n_CarmoCream · Carmona_ 🍓`
        )
      } else if (isNo(text)) {
        resetConv(phone)
        await reply(chat, msg,
          `¡Perfecto! Tu pedido *#${conv.context.orderNumber}* sigue activo 🙌\nEstamos preparándolo con mucho cariño 🍓`
        )
      } else {
        await reply(chat, msg, 'Por favor responde *SÍ* para cancelar o *NO* para mantener el pedido.')
      }
      return
    }
  }

  async function handleStatusFlow(phone, text, chat, msg, conv) {
    if (conv.state === STATE.IDLE) {
      // Primero intentar buscar por teléfono automáticamente
      const phoneDigits = phone.replace('@c.us', '').replace(/\D/g, '')
      const orders = await findLatestOrderByPhone(phoneDigits)

      if (orders.length === 1) {
        const o = orders[0]
        resetConv(phone)
        const timeAgo = Math.round((Date.now() - new Date(o.created_at).getTime()) / 60000)
        await reply(chat, msg,
          `🔍 Encontré tu pedido más reciente:\n\n📋 *Pedido #${o.order_number}*\n📍 Estado: ${STATUS_EMOJI[o.status] || o.status}\n💰 Total: €${o.total}\n🕐 Hace ${timeAgo} min\n\n${o.status === 'delivering' ? '🛵 *¡Ya va de camino!* Llegará en breve.' : o.status === 'pending' ? '⏳ Acaba de entrar, en breve empezamos.' : o.status === 'preparing' ? '👨‍🍳 Estamos preparándolo ahora mismo.' : ''}`
        )
        return
      } else if (orders.length > 1) {
        setState(phone, STATE.STATUS_NEED_NUMBER)
        const list = orders.map(o => `• *#${o.order_number}* — ${STATUS_EMOJI[o.status] || o.status}`).join('\n')
        await reply(chat, msg, `Tienes varios pedidos recientes:\n\n${list}\n\n¿De cuál quieres saber el estado? Escribe el número.`)
        return
      } else {
        setState(phone, STATE.STATUS_NEED_NUMBER)
        await reply(chat, msg,
          '🔍 No encontré pedidos asociados a este número.\n\n¿Puedes decirme el *número de pedido*? Lo tienes en el mensaje de confirmación.'
        )
        return
      }
    }

    if (conv.state === STATE.STATUS_NEED_NUMBER) {
      const match = text.match(/\d+/)
      if (!match) {
        await reply(chat, msg, 'Escribe solo el número de pedido, por ejemplo: *42*')
        return
      }
      const order = await findOrderByNumber(match[0])
      resetConv(phone)
      if (!order) {
        await reply(chat, msg, '🔍 No encontré ese pedido. Verifica el número e inténtalo de nuevo.')
        return
      }
      const timeAgo = Math.round((Date.now() - new Date(order.created_at).getTime()) / 60000)
      await reply(chat, msg,
        `📋 *Pedido #${order.order_number}*\n📍 Estado: ${STATUS_EMOJI[order.status] || order.status}\n💰 Total: €${order.total}\n🕐 Hace ${timeAgo} min`
      )
    }
  }

  async function handleComplaintFlow(phone, text, chat, msg, conv) {
    if (conv.state === STATE.IDLE) {
      setState(phone, STATE.COMPLAINT_NEED_DETAIL)
      await reply(chat, msg,
        '😔 Lo sentimos mucho, queremos solucionarlo.\n\nCuéntame con detalle qué pasó y el *número de pedido* si lo tienes. Voy a notificar a nuestro equipo ahora mismo.'
      )
      return
    }

    if (conv.state === STATE.COMPLAINT_NEED_DETAIL) {
      // Escalar a admin con el detalle
      await escalateToAdmin(phone, text, 'Queja/problema con pedido', chat, msg)
    }
  }

  async function escalateToAdmin(phone, text, reason, chat, msg) {
    setState(phone, STATE.ESCALATED)
    await saveEscalation(phone, text, reason)
    await notifyAdmin(phone, text, reason)
    await reply(chat, msg,
      `🙏 Entendido. He notificado a nuestro equipo ahora mismo.\n\nAlguien del equipo de *CarmoCream* revisará tu caso y te contactará en breve.\n\n_Gracias por tu paciencia_ 🍓`
    )
  }

  // ════════════════════════════════════════════════════════════════════════════
  // RESPUESTAS ESTÁTICAS INTELIGENTES (ampliadas)
  // ════════════════════════════════════════════════════════════════════════════

  const SMART_REPLIES = [
    // ── Saludo ──────────────────────────────────────────────────────────────
    {
      id: 'saludo',
      match: t => hasAny(t, ['hola','buenas','buenos dias','buenas tardes','buenas noches','hey','hi','hello','ola','good morning']),
      reply: () => `¡Hola! 👋🍓 Soy el asistente de *CarmoCream*.\n\nPuedo ayudarte con:\n• 📋 *Estado* de tu pedido\n• ❌ *Cancelar* un pedido\n• 🕐 *Horarios* y zona de reparto\n• 🍓 *Ver el menú* y hacer tu pedido\n\n¿En qué te ayudo? 😊`,
    },
    // ── Precio ───────────────────────────────────────────────────────────────
    {
      id: 'precio',
      match: t => hasAny(t, ['precio','cuanto cuesta','cuánto cuesta','cuanto vale','cuánto vale','coste','tarifa','cuanto es','cuánto es','precios']),
      reply: () => `💰 Todos nuestros precios están en el menú online:\n\n👉 *${WEB_URL}*\n\nDesde ahí también puedes hacer tu pedido directamente 🛵`,
    },
    // ── Menú ─────────────────────────────────────────────────────────────────
    {
      id: 'menu',
      match: t => hasAny(t, ['menu','menú','carta','que teneis','qué tenéis','que hay','qué hay','que vendeis','qué vendéis','productos','sabores','tipos']),
      reply: () => `🍓 Tenemos helados artesanales, combos, toppings personalizados y más.\n\nVe el menú completo aquí:\n👉 *${WEB_URL}*\n\n¡Hecho al momento, sin conservantes! ✨`,
    },
    // ── Horario ──────────────────────────────────────────────────────────────
    {
      id: 'horario',
      match: t => hasAny(t, ['horario','cuando abren','cuándo abren','hora','abris','abren','cerrais','cerráis','cerrado','abierto']),
      reply: () => `🕐 Estamos abiertos:\n*Martes a Domingo · 14:00 – 21:00*\n\nFuera de horario puedes hacer tu pedido en la web y lo gestionamos al reabrir 👇\n*${WEB_URL}*`,
    },
    // ── Zona de reparto ───────────────────────────────────────────────────────
    {
      id: 'zona',
      match: t => hasAny(t, ['reparto','envio','envío','entrega','zona','domicilio','delivery','llegais','llegáis','repartis','repartís','carmona']),
      reply: () => `🛵 Hacemos reparto *solo en Carmona*.\n\nSi estás en Carmona, pide aquí:\n👉 *${WEB_URL}*\n\n¡En menos de 30 minutos en tu puerta! 🍓`,
    },
    // ── Pago ─────────────────────────────────────────────────────────────────
    {
      id: 'pago',
      match: t => hasAny(t, ['pago','pagar','bizum','tarjeta','efectivo','como pago','cómo pago','formas de pago']),
      reply: () => `💵 Aceptamos *efectivo al repartidor*.\n\nPide cómodamente online:\n👉 *${WEB_URL}*`,
    },
    // ── Tiempo de espera ──────────────────────────────────────────────────────
    {
      id: 'tiempo',
      match: t => hasAny(t, ['cuanto tarda','cuánto tarda','tiempo de espera','cuando llega','cuándo llega','tardais','tardáis']),
      reply: () => `⏱️ El tiempo medio de entrega es *20-30 minutos* desde que confirmas el pedido.\n\nDepende de la carga del momento. En el pedido verás el estado en tiempo real 👇\n*${WEB_URL}*`,
    },
    // ── Ingredientes / alérgenos ──────────────────────────────────────────────
    {
      id: 'alergenos',
      match: t => hasAny(t, ['alergeno','alérgeno','alergia','intolerancia','lactosa','gluten','sin lactosa','vegano','vegan','ingredientes']),
      reply: () => `✅ *CarmoCream es 100% sin lactosa.*\n\nTodos nuestros productos están elaborados sin lactosa. Para consultas específicas de alérgenos escríbenos "hablar" y te asesoramos personalmente 🙏`,
    },
    // ── Descuento / cupón ─────────────────────────────────────────────────────
    {
      id: 'descuento',
      match: t => hasAny(t, ['descuento','cupon','cupón','oferta','promocion','promoción','codigo','código','sale']),
      reply: () => `🎟️ ¡Tenemos cupones y descuentos en la web!\n\nAl hacer tu pedido puedes introducir el código de descuento:\n👉 *${WEB_URL}*\n\nSíguenos en *@carmocream_* para no perderte ninguna promo 📸`,
    },
    // ── Pedido mínimo ─────────────────────────────────────────────────────────
    {
      id: 'minimo',
      match: t => hasAny(t, ['pedido minimo','pedido mínimo','minimo','mínimo','cuanto minimo','cuánto minimo']),
      reply: () => `🛒 No tenemos pedido mínimo.\n\nPuedes pedir desde un solo producto:\n👉 *${WEB_URL}*`,
    },
    // ── Personalizar pedido ───────────────────────────────────────────────────
    {
      id: 'personalizar',
      match: t => hasAny(t, ['personalizar','personalizado','a mi gusto','sin topping','extra topping','sin fruta','con fruta','cambiar']),
      reply: () => `🎨 ¡Sí! Puedes personalizar tu pedido al 100% desde la web:\n\n👉 *${WEB_URL}*\n\nElige sabores, toppings, tamaños y mucho más 🍓`,
    },
    // ── Instagram / redes ─────────────────────────────────────────────────────
    {
      id: 'instagram',
      match: t => hasAny(t, ['instagram','insta','redes','siguros','seguidores','fotos','stories']),
      reply: () => `📸 ¡Síguenos en Instagram!\n\n👉 *@carmocream_*\n\nPublicamos novedades, sorteos y fotos de nuestros productos 🍓`,
    },
    // ── Gracias ───────────────────────────────────────────────────────────────
    {
      id: 'gracias',
      match: t => hasAny(t, ['gracias','muchas gracias','mil gracias','thank you','genial','perfecto','ok gracias']),
      reply: () => `🙏 ¡De nada! Un placer.\n\nCualquier cosa que necesites, aquí estamos 🍓\n\n*CarmoCream · Carmona*`,
    },
    // ── Quién sois / about ────────────────────────────────────────────────────
    {
      id: 'about',
      match: t => hasAny(t, ['quienes sois','quiénes sois','que sois','qué sois','de donde','de dónde','donde estais','dónde estáis','tienda fisica','tienda física']),
      reply: () => `🍓 *CarmoCream* somos un negocio de helados artesanales sin lactosa de *Carmona, Sevilla*.\n\nSolo entregamos a domicilio en Carmona. Puedes hacer tu pedido en:\n👉 *${WEB_URL}*`,
    },
    // ── Problema con pago / cobro ─────────────────────────────────────────────
    {
      id: 'problema_pago',
      match: t => hasAny(t, ['me han cobrado','cobro doble','cobro mal','cobro incorrecto','cargo','cargado']),
      reply: () => null, // Fuerza escalado
      escalate: true,
      escalateReason: 'Problema con cobro',
    },
  ]

  function findStaticReply(text) {
    for (const rule of SMART_REPLIES) {
      if (rule.match(text)) return rule
    }
    // También buscar en reglas configuradas desde el panel admin
    for (const rule of staticRules) {
      if (!rule.active) continue
      const matched = rule.trigger
        .split(',')
        .map(t => t.trim().toLowerCase())
        .some(kw => kw && normalize(text).includes(normalize(kw)))
      if (matched) return { id: rule.id, reply: () => rule.response.replace(/\{\{web\}\}/g, WEB_URL) }
    }
    return null
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ROUTER PRINCIPAL DE MENSAJES
  // ════════════════════════════════════════════════════════════════════════════

  async function handleMessage(msg) {
    try {
      const chat = await msg.getChat()
      if (chat.isGroup || msg.fromMe || msg.type === 'e2e_notification') return

      const phone = msg.from // ej: "34622663874@c.us"
      const text  = (msg.body || '').trim()
      if (!text) return

      // ── ¿Admin ha tomado el control de este chat? ─────────────────────────
      const isAdminChat = ADMIN_PHONE && phone === `${ADMIN_PHONE}@c.us`
      if (!isAdminChat) {
        const adminOwns = await checkAdminTakeover(phone)
        if (adminOwns) {
          console.log(`[Chatbot] 🔒 Admin takeover activo para ${phone} — bot silenciado`)
          return
        }
      }

      if (!chatbotEnabled) return

      const conv = getConv(phone)
      conv.lastActivity = Date.now()

      console.log(`[Chatbot] 📩 ${phone}: "${text.slice(0,50)}" [estado:${conv.state}]`)

      // ── Comando de reset ─────────────────────────────────────────────────
      if (normalize(text) === 'reiniciar' || normalize(text) === 'reset' || normalize(text) === 'inicio') {
        resetConv(phone)
        await reply(chat, msg, '🔄 Conversación reiniciada. ¿En qué te puedo ayudar?')
        return
      }

      // ── Flujos activos (stateful) ─────────────────────────────────────────
      if (conv.state === STATE.CANCEL_NEED_NUMBER || conv.state === STATE.CANCEL_NEED_CONFIRM) {
        await handleCancelFlow(phone, text, chat, msg, conv)
        return
      }
      if (conv.state === STATE.STATUS_NEED_NUMBER) {
        await handleStatusFlow(phone, text, chat, msg, conv)
        return
      }
      if (conv.state === STATE.COMPLAINT_NEED_DETAIL) {
        await handleComplaintFlow(phone, text, chat, msg, conv)
        return
      }
      if (conv.state === STATE.ESCALATED) {
        await reply(chat, msg,
          '🙏 Tu caso ya está siendo atendido por nuestro equipo.\n\nSi es urgente escribe *"reiniciar"* para empezar de nuevo.'
        )
        return
      }

      // ── Detección de intenciones (desde idle) ──────────────────────────────

      // 1. Hablar con humano
      if (isHumanIntent(text)) {
        await escalateToAdmin(phone, text, 'Cliente solicita atención humana', chat, msg)
        return
      }

      // 2. Queja / problema
      if (isComplaintIntent(text)) {
        await handleComplaintFlow(phone, text, chat, msg, conv)
        return
      }

      // 3. Cancelar pedido
      if (isCancelIntent(text)) {
        await handleCancelFlow(phone, text, chat, msg, conv)
        return
      }

      // 4. Estado del pedido
      if (isStatusIntent(text)) {
        await handleStatusFlow(phone, text, chat, msg, conv)
        return
      }

      // 5. Repetir pedido
      if (isRepeatIntent(text)) {
        await reply(chat, msg,
          `🔄 ¡Claro! Puedes repetir tu pedido fácilmente desde la web:\n\n👉 *${WEB_URL}*\n\nTus datos se guardan automáticamente para que sea más rápido 🍓`
        )
        return
      }

      // 6. Respuestas estáticas (con cooldown anti-spam)
      const staticRule = findStaticReply(text)
      if (staticRule) {
        // Si fuerza escalado
        if (staticRule.escalate) {
          await escalateToAdmin(phone, text, staticRule.escalateReason || 'Consulta', chat, msg)
          return
        }
        // Anti-spam: misma respuesta no más de 1 vez cada 15 min
        const cooldownKey = `${phone}:${staticRule.id}`
        const lastSent = staticReplyCooldown.get(cooldownKey) || 0
        if (Date.now() - lastSent < 15 * 60 * 1000) return // silencio
        staticReplyCooldown.set(cooldownKey, Date.now())
        setTimeout(() => staticReplyCooldown.delete(cooldownKey), 15 * 60 * 1000)
        const text2 = staticRule.reply()
        if (text2) { await reply(chat, msg, text2); return }
      }

      // 7. Sin coincidencia — respuesta de fallback (máx 1 vez cada 20 min)
      const fallbackKey = `${phone}:fallback`
      const lastFallback = staticReplyCooldown.get(fallbackKey) || 0
      if (Date.now() - lastFallback > 20 * 60 * 1000) {
        staticReplyCooldown.set(fallbackKey, Date.now())
        await reply(chat, msg,
          `Hola 👋 No he entendido bien tu mensaje.\n\nPuedo ayudarte con:\n• *"estado"* → ver dónde está tu pedido\n• *"cancelar"* → cancelar un pedido\n• *"menú"* → ver productos y precios\n• *"ayuda"* → hablar con una persona\n\nO haz tu pedido directamente:\n👉 *${WEB_URL}*`
        )
      }

    } catch (e) {
      console.error('[Chatbot] Error handleMessage:', e.message)
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // INICIALIZACIÓN
  // ════════════════════════════════════════════════════════════════════════════

  loadConfig()
  setInterval(loadConfig, 5 * 60 * 1000)

  if (client && typeof client.on === 'function') {
    client.on('message', handleMessage)
    console.log('[Chatbot] ✅ Escucha de mensajes activada — v2.0 con máquina de estados')
  } else {
    console.warn('[Chatbot] ⚠️ client no disponible aún — se registrará cuando esté listo')
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ENDPOINTS HTTP
  // ════════════════════════════════════════════════════════════════════════════

  app.get('/chatbot/status', (req, res) => {
    res.json({
      ok:            true,
      enabled:       chatbotEnabled,
      rules:         staticRules.length,
      conversations: conversations.size,
      version:       '2.0.0',
    })
  })

  // Forzar recarga de config
  app.post('/chatbot/reload', (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    loadConfig().then(() => res.json({ ok: true, rules: staticRules.length, enabled: chatbotEnabled }))
  })

  // Admin toma el chat (silencia el bot para ese número)
  app.post('/chatbot/takeover', (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    const { phone, release } = req.body || {}
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' })
    setAdminTakeover(phone, !release)
    if (release) resetConv(phone)
    console.log(`[Chatbot] Admin ${release ? 'liberó' : 'tomó'} el chat: ${phone}`)
    res.json({ ok: true, phone, adminTakeover: !release })
  })

  // Ver conversaciones escaladas activas
  app.get('/chatbot/escalations', (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    const escalated = [...conversations.entries()]
      .filter(([, c]) => c.state === STATE.ESCALATED)
      .map(([phone, c]) => ({ phone, ...c }))
    res.json({ ok: true, escalated })
  })

  // Test de matching
  app.post('/chatbot/test', (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    const { message } = req.body || {}
    const norm = normalize(message || '')
    const cancel  = isCancelIntent(norm)
    const status  = isStatusIntent(norm)
    const complaint = isComplaintIntent(norm)
    const human   = isHumanIntent(norm)
    const staticR = findStaticReply(norm)
    res.json({
      matched: !!(cancel || status || complaint || human || staticR),
      intents: { cancel, status, complaint, human },
      staticRule: staticR?.id || null,
    })
  })

  app.get('/webhook-status', (req, res) => {
    res.json({ ok: true, chatbot: true, version: '2.0.0' })
  })
}
