/**
 * chatbot_railway_webhook.js — CarmoCream v4.0
 * =====================================================
 * Máquina de estados inteligente:
 *   ✅ Cancelación con validación de estado real
 *   ✅ Estado del pedido en tiempo real con detalle de items
 *   ✅ Menú y precios dinámicos desde Supabase
 *   ✅ Cliente reconocido (saludo personalizado)
 *   ✅ Zona de reparto, horario, alérgenos, formas de pago
 *   ✅ Cupones activos
 *   ✅ Modificación de pedido con notificación admin
 *   ✅ Quejas → escalado inmediato
 *   ✅ Solicitud humana → takeover admin
 *   ✅ Agradecimiento → solicita reseña
 *   ✅ Anti-spam y cooldown
 *   ✅ Reglas estáticas personalizables desde panel
 *   ✅ Endpoint post-entrega automático (reseña)
 *   ✅ Endpoint broadcast marketing
 * =====================================================
 */

const WEB_URL     = process.env.SHOP_URL    || 'https://carmocream.vercel.app'
const ADMIN_PHONE = process.env.ADMIN_PHONE || ''
const VERSION     = '4.0.0'

const NO_CANCEL_STATES = ['preparing', 'ready', 'delivering', 'delivered']
const STATE_LABELS = {
  pending:    '⏳ Recibido, pendiente de confirmar',
  preparing:  '👨‍🍳 En preparación',
  ready:      '✅ Listo para entregar',
  delivering: '🛵 En camino hacia ti',
  delivered:  '🎉 Entregado',
  cancelled:  '❌ Cancelado',
}
const STATE_TIPS = {
  pending:    'Lo hemos recibido y lo gestionamos en breve. Te avisamos cuando avance 👍',
  preparing:  '¡Estamos preparándolo ahora mismo con mucho cariño! En unos minutos sale 🛵',
  ready:      'Ya está listo y esperando al repartidor. ¡Enseguida está en camino! 🛵',
  delivering: '¡Tu repartidor ya está en camino! En breve llega a tu puerta 🍓',
  delivered:  '¡Esperamos que lo hayas disfrutado! Si quieres repetir, ya sabes 😄',
  cancelled:  'El pedido fue cancelado. Para hacer uno nuevo visita la web 👇',
}

module.exports = function setupChatbot(app, client, supabaseUrl, supabaseKey) {

  // ══════════════════════════════════════════════════════════════════
  //  ESTADO INTERNO
  // ══════════════════════════════════════════════════════════════════
  let chatbotEnabled  = false
  let chatbotRules    = []
  let productsCache   = []      // cache de productos activos
  let productsCacheTs = 0       // timestamp del último fetch
  const PRODUCTS_TTL  = 5 * 60 * 1000  // 5 min

  const conversations = new Map()  // phone → { state, ...data, ts }
  const recentReplies = new Map()  // anti-spam: phone → timestamp

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
      console.log(`[Chatbot] v${VERSION} — Reglas: ${chatbotRules.length} (activo: ${chatbotEnabled})`)
    } catch (e) { console.error('[Chatbot] loadRules:', e.message) }
  }

  // ── Productos activos con cache de 5 min ─────────────────────────
  async function getActiveProducts() {
    if (Date.now() - productsCacheTs < PRODUCTS_TTL && productsCache.length) return productsCache
    try {
      const data = await sbFetch('products?active=eq.true&select=id,name,price,description&order=sort_order')
      productsCache   = data || []
      productsCacheTs = Date.now()
    } catch (e) { console.error('[Chatbot] getActiveProducts:', e.message) }
    return productsCache
  }

  // ── Cupones activos ───────────────────────────────────────────────
  async function getActiveCoupons() {
    try {
      const now = new Date().toISOString()
      const data = await sbFetch(
        `coupons?active=eq.true&select=code,discount_type,discount_value,min_order` +
        `&or=(expires_at.is.null,expires_at.gt.${now})`
      )
      return data || []
    } catch { return [] }
  }

  // ── Último pedido activo por teléfono ─────────────────────────────
  async function findLastOrder(phone) {
    try {
      const digits = phone.replace('@c.us', '').replace(/\D/g, '')
      const variants = [digits, digits.replace(/^34/, ''), '34' + digits.replace(/^34/, '')]
      const query = variants.map(v => `customer_phone.ilike.*${v.slice(-9)}*`).join(',')
      const data = await sbFetch(
        `orders?or=(${query})&status=neq.cancelled&order=created_at.desc&limit=1` +
        `&select=id,order_number,status,total,created_at,items,customer_name,delivery_address`
      )
      return (data || [])[0] || null
    } catch (e) { console.error('[Chatbot] findLastOrder:', e.message); return null }
  }

  // ── Historial del cliente (para personalizar) ─────────────────────
  async function getCustomerHistory(phone) {
    try {
      const digits = phone.replace('@c.us', '').replace(/\D/g, '')
      const variants = [digits, digits.replace(/^34/, ''), '34' + digits.replace(/^34/, '')]
      const query = variants.map(v => `customer_phone.ilike.*${v.slice(-9)}*`).join(',')
      const data = await sbFetch(
        `orders?or=(${query})&select=id,customer_name,total,status&order=created_at.desc&limit=10`
      )
      return data || []
    } catch { return [] }
  }

  async function cancelOrder(orderId) {
    try {
      await sbFetch(`orders?id=eq.${orderId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelled' }),
      })
      return true
    } catch (e) { console.error('[Chatbot] cancelOrder:', e.message); return false }
  }

  async function saveConversation(phone, state, reason, lastMessage, extra = {}) {
    try {
      await sbFetch('chatbot_conversations', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          phone, state, escalation_reason: reason, last_message: lastMessage,
          admin_takeover: false, resolved: false,
          updated_at: new Date().toISOString(), ...extra,
        }),
      })
    } catch (e) { console.error('[Chatbot] saveConversation:', e.message) }
  }

  async function notifyAdmin(text) {
    if (!ADMIN_PHONE || !client) return
    try { await client.sendMessage(`${ADMIN_PHONE}@c.us`, text) }
    catch (e) { console.error('[Chatbot] notifyAdmin:', e.message) }
  }

  // ── Formatear items del pedido ────────────────────────────────────
  function formatOrderItems(order) {
    try {
      const items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || [])
      if (!items.length) return ''
      return '\n🛒 *Productos:*\n' + items.map(it => {
        const name = it.product_name || it.name || 'Producto'
        const qty  = it.qty || it.quantity || 1
        const price = it.price ? ` · €${Number(it.price * qty).toFixed(2)}` : ''
        return `  • ${qty}x ${name}${price}`
      }).join('\n')
    } catch { return '' }
  }

  // ── Normalizar texto para matching ───────────────────────────────
  function norm(text) {
    return (text || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[¿¡]/g, '')
  }

  // ══════════════════════════════════════════════════════════════════
  //  MÁQUINA DE ESTADOS PRINCIPAL
  // ══════════════════════════════════════════════════════════════════
  async function handleMessage(phone, rawText) {
    if (!chatbotEnabled) return null

    const text = (rawText || '').trim()
    const n    = norm(text)
    const conv = conversations.get(phone) || { state: 'idle' }
    const now  = Date.now()

    // ── Admin takeover activo → silenciar bot ─────────────────────
    if (conv.state === 'admin_takeover') return null

    // ── Anti-spam: máx 1 respuesta cada 2s ───────────────────────
    const lastReply = recentReplies.get(phone) || 0
    if (now - lastReply < 2000) return null
    recentReplies.set(phone, now)

    // ── Fuera de horario ──────────────────────────────────────────
    const hour = new Date().getHours()
    const day  = new Date().getDay() // 0=Dom, 1=Lun
    const isOpen = day !== 1 && hour >= 14 && hour < 21
    if (!isOpen && /pedir|pedido nuevo|hacer pedido|quiero pedir|quiero uno|ponme|quisiera pedir/.test(n)) {
      const nextStr = day === 1 ? 'mañana martes' : hour < 14 ? 'hoy a las 14:00' : 'mañana'
      return `🕐 Ahora mismo estamos cerrados.\n\n` +
        `*Horario: Martes a Domingo · 14:00 – 21:00*\n\n` +
        `Abrimos ${nextStr} — pero puedes ver el menú y hacer tu pedido ya:\n👉 *${WEB_URL}*\n\n¡Hasta pronto! 🍓`
    }

    // ──────────────────────────────────────────────────────────────
    //  ESTADO: esperando confirmación de cancelación
    // ──────────────────────────────────────────────────────────────
    if (conv.state === 'waiting_cancel_confirm') {
      conversations.delete(phone)
      if (/^(si|sí|s|yes|confirmo|cancela|cancelar|dale|ok|claro|por favor|adelante)$/i.test(n)) {
        const order = conv.order
        if (!order) return '❌ No encontré tu pedido. Escribe *"hablar"* y te ayudamos.'
        // Re-verificar estado actual
        let freshStatus = order.status
        try {
          const d = await sbFetch(`orders?id=eq.${order.id}&select=status&limit=1`)
          freshStatus = (d || [])[0]?.status || order.status
        } catch {}
        if (NO_CANCEL_STATES.includes(freshStatus)) {
          return `⚠️ *Ya no podemos cancelar el pedido #${order.order_number}.*\n\n` +
            `Estado actual: *${STATE_LABELS[freshStatus]}*\n` +
            `${STATE_TIPS[freshStatus]}\n\n` +
            `Si hay algún problema cuando lo recibas, escribe *"queja"* y te atendemos 🙏`
        }
        const ok = await cancelOrder(order.id)
        return ok
          ? `✅ *Pedido #${order.order_number} cancelado.*\n\nLamentamos que no hayas podido disfrutarlo.\nCuando quieras volver, aquí estamos 🍓`
          : `❌ Hubo un problema al cancelar. Escribe *"hablar"* y lo resolvemos ahora mismo.`
      }
      if (/^(no|nop|nope|no cancelar|mantener)$/i.test(n)) {
        return `✅ ¡Perfecto! Tu pedido sigue activo. ¿Puedo ayudarte con algo más? 😊`
      }
      return `Responde *Sí* para cancelar o *No* para mantener el pedido.`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: CANCELAR
    // ──────────────────────────────────────────────────────────────
    if (/cancelar|anular|quiero cancelar|cancela|no lo quiero|me arrepent|no quiero el pedido|borra el pedido/.test(n)) {
      const order = await findLastOrder(phone)
      if (!order) return `❌ No encontré ningún pedido activo en tu número.\n\nSi crees que es un error, escribe *"hablar"* 🙏`
      if (order.status === 'cancelled') return `ℹ️ Tu pedido *#${order.order_number}* ya estaba cancelado.`
      if (order.status === 'delivered')
        return `ℹ️ El pedido *#${order.order_number}* ya fue entregado, no se puede cancelar.\nSi tuviste algún problema, escribe *"queja"* 🙏`
      if (NO_CANCEL_STATES.includes(order.status)) {
        return `⚠️ *Lo sentimos, tu pedido #${order.order_number} ya no se puede cancelar.*\n\n` +
          `Estado actual: *${STATE_LABELS[order.status]}*\n` +
          `${STATE_TIPS[order.status]}\n\n` +
          `Si hay algún problema al recibirlo, escribe *"queja"* 🙏`
      }
      const total = Number(order.total || 0).toFixed(2)
      conversations.set(phone, { state: 'waiting_cancel_confirm', order, ts: now })
      return `⚠️ *¿Seguro que quieres cancelar?*\n\n` +
        `📋 Pedido *#${order.order_number}* · €${total}\n` +
        `Estado: ${STATE_LABELS[order.status]}\n` +
        `${formatOrderItems(order)}\n\n` +
        `Responde *Sí* para cancelar o *No* para mantenerlo.`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: ESTADO DEL PEDIDO
    // ──────────────────────────────────────────────────────────────
    if (/estado|donde esta|mi pedido|cuando llega|lo has recibido|confirmado|cuando sale|tardais|tardáis|ya lo preparan|sigue en pie/.test(n)) {
      const order = await findLastOrder(phone)
      if (!order) return `📋 No encontré pedidos activos en tu número.\n\n¿Quieres hacer uno?\n👉 *${WEB_URL}*`
      const created = new Date(order.created_at).toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' })
      const total   = Number(order.total || 0).toFixed(2)
      return `📋 *Pedido #${order.order_number}*\n\n` +
        `🕐 Pedido a las: ${created}\n` +
        `💰 Total: €${total}\n` +
        `Estado: *${STATE_LABELS[order.status] || order.status}*\n` +
        `${formatOrderItems(order)}\n\n` +
        `${STATE_TIPS[order.status] || ''}`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: MODIFICAR PEDIDO
    // ──────────────────────────────────────────────────────────────
    if (/cambiar|modificar|cambio|añadir al pedido|quitar del pedido|otro sabor|cambiar direc/.test(n)) {
      const order = await findLastOrder(phone)
      if (!order) return `❓ No encontré ningún pedido activo.\n\nPara hacer uno:\n👉 *${WEB_URL}*`
      if (NO_CANCEL_STATES.includes(order.status))
        return `⚠️ Tu pedido *#${order.order_number}* ya está en *${STATE_LABELS[order.status]}* y no se puede modificar.\n\nSi hay un problema al recibirlo, escribe *"queja"* 🙏`
      await saveConversation(phone, 'escalated', 'Solicitud de modificación', text)
      await notifyAdmin(`✏️ *MODIFICACIÓN — CarmoCream*\n\n📞 ${phone.replace('@c.us','')} · #${order.order_number}\n💬 "${text.slice(0,150)}"\n\n👉 ${WEB_URL}/admin`)
      return `✏️ Recibida tu solicitud para el pedido *#${order.order_number}*.\nHemos avisado al equipo. Te confirmamos en breve si es posible 🙏`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: VER MENÚ / PRECIOS
    // ──────────────────────────────────────────────────────────────
    if (/menu|carta|que teneis|que tienen|que vendeis|que haceis|que ofreceis|productos|que hay|que preparais|que tipos|ver lo que|lista de|catalogo|catálogo/.test(n)) {
      const products = await getActiveProducts()
      if (!products.length) return `Ahora mismo estamos actualizando el menú. Puedes verlo completo en:\n👉 *${WEB_URL}*`
      const list = products.map(p => `• *${p.name}* — €${Number(p.price||0).toFixed(2)}`).join('\n')
      return `🍓 *Menú CarmoCream* — Todo Sin Lactosa\n\n${list}\n\n👉 Pide directamente en: *${WEB_URL}*\n\n¿Te apetece algo? 😋`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: PRECIO ESPECÍFICO
    // ──────────────────────────────────────────────────────────────
    if (/cuanto cuesta|cuanto vale|que precio|precio de|cuanto es|cuanto cobr|cuanto tienen|cuanto valen|a cuanto/.test(n)) {
      const products = await getActiveProducts()
      if (!products.length) return `Puedes ver todos los precios en:\n👉 *${WEB_URL}*`
      // Buscar si pregunta por un producto específico
      const match = products.find(p => n.includes(norm(p.name)))
      if (match) {
        return `💰 *${match.name}* cuesta *€${Number(match.price||0).toFixed(2)}*\n\n👉 Pide en: *${WEB_URL}*`
      }
      const list = products.map(p => `• *${p.name}* — €${Number(p.price||0).toFixed(2)}`).join('\n')
      return `💰 *Nuestros precios:*\n\n${list}\n\n👉 Haz tu pedido en: *${WEB_URL}* 🛒`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: DESCUENTOS / CUPONES
    // ──────────────────────────────────────────────────────────────
    if (/descuento|cupon|cupón|codigo|oferta|promo|promocion|rebaja|mas barato|teneis algo/.test(n)) {
      const coupons = await getActiveCoupons()
      if (!coupons.length)
        return `Ahora mismo no tenemos promociones activas 😊\nSíguenos en Instagram para enterarte antes que nadie:\n👉 @carmocream_\n\nPuedes ver el menú en: *${WEB_URL}*`
      const list = coupons.map(c => {
        const val = c.discount_type === 'percent'
          ? `${c.discount_value}% descuento`
          : `€${Number(c.discount_value||0).toFixed(2)} de descuento`
        const min = c.min_order ? ` (mínimo €${Number(c.min_order).toFixed(2)})` : ''
        return `🎟️ *${c.code}* — ${val}${min}`
      }).join('\n')
      return `🎟️ *Promociones activas:*\n\n${list}\n\nAplícalos al hacer el pedido en:\n👉 *${WEB_URL}* 🛒`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: HORARIO
    // ──────────────────────────────────────────────────────────────
    if (/horario|cuando abris|cuando abrís|a que hora|cuando estais|cerrado|abierto|horas|dias de la semana/.test(n)) {
      const day = new Date().getDay(), hour = new Date().getHours()
      const isOpenNow = day !== 1 && hour >= 14 && hour < 21
      return `🕐 *Horario CarmoCream*\n\n📅 Martes a Domingo: 14:00 – 21:00\n❌ Lunes: cerrado\n\n` +
        `${isOpenNow ? '🟢 *Ahora estamos abiertos* 🍓' : '🔴 Ahora estamos cerrados.'}\n\n👉 *${WEB_URL}*`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: ZONA DE REPARTO
    // ──────────────────────────────────────────────────────────────
    if (/zona|repartis|repartís|llegais|llegáis|entregais|domicilio|delivery|reparto|envio|envío|cubris|barrio|llegar a/.test(n)) {
      return `🛵 *Zona de reparto:*\n\nRepartimos por *Carmona* y alrededores.\n\nSi no estás seguro/a de si llegamos a tu zona, indícanos la dirección y te confirmamos 😊\n\n👉 *${WEB_URL}*`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: FORMAS DE PAGO
    // ──────────────────────────────────────────────────────────────
    if (/pago|pagar|como se paga|metodo|bizum|tarjeta|efectivo|transferencia|aceptais|aceptáis/.test(n)) {
      return `💳 *Formas de pago:*\n\n• 💳 Tarjeta (crédito/débito)\n• 📲 Bizum\n• 💵 Efectivo al repartidor\n\n👉 *${WEB_URL}*`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: ALÉRGENOS / SIN LACTOSA
    // ──────────────────────────────────────────────────────────────
    if (/alergeno|alérgeno|lactosa|sin lactosa|intolerante|gluten|vegano|ingredientes|que lleva|que contiene|sin azucar|dieta/.test(n)) {
      return `🌿 *CarmoCream — 100% Sin Lactosa*\n\nTodos nuestros productos son elaborados *sin lactosa*.\n\nSi tienes alguna alergia específica (gluten, frutos secos…), escribe *"hablar"* y te informamos en detalle 🙏`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: TIEMPO DE ENTREGA
    // ──────────────────────────────────────────────────────────────
    if (/cuanto tarda|cuánto tarda|tiempo de entrega|tiempo estimado|rapido|rápido|en cuanto|a partir de cuando/.test(n)) {
      return `⏱️ El tiempo habitual de entrega es de *30–45 minutos* desde que confirmas el pedido.\n\nTe mantenemos informado aquí mismo en todo momento 🍓\n\n👉 *${WEB_URL}*`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: PEDIDO MÍNIMO / GASTOS DE ENVÍO
    // ──────────────────────────────────────────────────────────────
    if (/minimo|mínimo|pedido minimo|gastos de envio|gastos envio|hay minimo/.test(n)) {
      return `📦 ¡No tenemos pedido mínimo! 🎉\n\nPuedes pedir lo que quieras en:\n👉 *${WEB_URL}*`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: QUEJA / PROBLEMA
    // ──────────────────────────────────────────────────────────────
    if (/queja|reclamacion|reclamación|problema|llego mal|llegó mal|faltaba|estaba mal|no llegó|frio|frío|derramado|roto|equivocado|mal estado/.test(n)) {
      await saveConversation(phone, 'escalated', 'Queja/problema con pedido', text)
      await notifyAdmin(`🚨 *QUEJA — CarmoCream*\n\n📞 ${phone.replace('@c.us','')}\n💬 "${text.slice(0,200)}"\n\n👉 ${WEB_URL}/admin → Chatbot → Escalaciones`)
      return `😔 Sentimos mucho el problema.\n\nHemos notificado al equipo y alguien te contactará *en menos de 30 minutos* para solucionarlo.\n\nSi es urgente escribe *"hablar"* 🙏\n\n_CarmoCream · Carmona_`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: HABLAR CON HUMANO
    // ──────────────────────────────────────────────────────────────
    if (/hablar|persona|humano|real|agente|operador|encargado|necesito ayuda|ayuda urgente|hola quiero hablar/.test(n)) {
      await saveConversation(phone, 'escalated', 'Cliente solicita atención humana', text)
      await notifyAdmin(`🙋 *ATENCIÓN HUMANA — CarmoCream*\n\n📞 ${phone.replace('@c.us','')}\n💬 "${text.slice(0,200)}"\n\n👉 ${WEB_URL}/admin → Chatbot → Escalaciones`)
      return `¡Claro! 🙋 He notificado al equipo.\n\nAlguien te responderá *en este mismo chat en unos minutos*.\n\n¿Hay algo más en lo que pueda ayudarte mientras? 😊`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: FACTURA / COMPROBANTE
    // ──────────────────────────────────────────────────────────────
    if (/factura|ticket|comprobante|recibo/.test(n)) {
      return `🧾 Actualmente solo emitimos comprobante de pago digital al completar el pedido en la web.\n\nSi necesitas algo específico, escribe *"hablar"* y te ayudamos 🙏`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: AGRADECIMIENTO / SATISFACCIÓN
    // ──────────────────────────────────────────────────────────────
    if (/gracias|muchas gracias|genial|perfecto|excelente|muy bueno|riquísimo|estaba buenísimo|me encantó|me gusto|volveré|volvere|repetire/.test(n)) {
      try {
        await saveConversation(phone, 'happy', null, text, { resolved: true })
      } catch {}
      return `🍓 ¡Muchísimas gracias! Nos alegra un montón saberlo.\n\n` +
        `Si tienes un momento, una reseña en Google nos ayuda muchísimo a llegar a más gente de Carmona:\n` +
        `👉 https://g.page/r/carmocream/review\n\n` +
        `*¿Tienes amigos o familia a los que les podría gustar?* Comparte el enlace 💚\n👉 *${WEB_URL}*\n\n_¡Hasta pronto! @carmocream_`
    }

    // ──────────────────────────────────────────────────────────────
    //  INTENCIÓN: SALUDO / PRIMERA VEZ
    // ──────────────────────────────────────────────────────────────
    if (/^(hola|buenas|buenas tardes|buenos dias|good morning|hello|ey|ei|hey|saludos|holi)$/i.test(n.trim())) {
      const history = await getCustomerHistory(phone)
      const isReturning = history.length > 0
      const firstName = history[0]?.customer_name?.split(' ')[0] || ''
      if (isReturning) {
        return `¡Hola${firstName ? ` ${firstName}` : ''}! 🍓 ¡Qué alegría tenerte de vuelta!\n\n` +
          `¿Hacemos tu pedido de siempre o quieres ver las novedades?\n👉 *${WEB_URL}*\n\n` +
          `Escríbeme si necesitas cualquier cosa 😊`
      }
      return `¡Hola! 👋 Bienvenido/a a *CarmoCream* — Helados y postres artesanales 100% Sin Lactosa 🍓\n\n` +
        `Puedo ayudarte con:\n` +
        `🛒 Ver el menú → escribe *"menú"*\n` +
        `💰 Precios → escribe *"precios"*\n` +
        `📋 Estado de tu pedido → escribe *"mi pedido"*\n` +
        `🕐 Horario → escribe *"horario"*\n\nO haz tu pedido directamente:\n👉 *${WEB_URL}*`
    }

    // ──────────────────────────────────────────────────────────────
    //  REGLAS ESTÁTICAS (personalizables desde el panel admin)
    // ──────────────────────────────────────────────────────────────
    const staticRule = chatbotRules.find(r => {
      if (!r.active) return false
      return r.trigger.split(',')
        .map(t => norm(t.trim()))
        .some(kw => kw && n.includes(kw))
    })
    if (staticRule) return staticRule.response.replace(/\{\{web\}\}/g, WEB_URL)

    // ──────────────────────────────────────────────────────────────
    //  FALLBACK INTELIGENTE
    // ──────────────────────────────────────────────────────────────
    return `👋 ¡Hola! Soy el asistente de *CarmoCream* 🍓\n\n` +
      `Para hacer tu pedido o ver el menú completo:\n👉 *${WEB_URL}*\n\n` +
      `También puedo ayudarte con:\n` +
      `• *"menú"* — Ver productos y precios\n` +
      `• *"mi pedido"* — Estado en tiempo real\n` +
      `• *"cancelar"* — Cancelar pedido\n` +
      `• *"horario"* — Cuándo estamos abiertos\n` +
      `• *"zona"* — Zona de reparto\n` +
      `• *"pago"* — Formas de pago\n` +
      `• *"hablar"* — Hablar con el equipo\n\n` +
      `_CarmoCream · Carmona · Sin Lactosa_ 🍓`
  }

  // ══════════════════════════════════════════════════════════════════
  //  ESCUCHA DE MENSAJES WHATSAPP
  // ══════════════════════════════════════════════════════════════════
  if (client && typeof client.on === 'function') {
    client.on('message', async (msg) => {
      try {
        const chat = await msg.getChat()
        if (chat.isGroup || msg.fromMe || msg.type === 'e2e_notification') return
        const reply = await handleMessage(msg.from, msg.body || '')
        if (!reply) return
        await chat.sendStateTyping()
        await new Promise(r => setTimeout(r, Math.min(1200 + reply.length * 12, 4000)))
        await chat.clearState()
        await msg.reply(reply)
        console.log(`[Chatbot] ✅ ${msg.from}: "${(msg.body||'').slice(0,40)}" → ${reply.slice(0,60)}`)
      } catch (e) { console.error('[Chatbot] Error:', e.message) }
    })
    console.log('[Chatbot] Escucha activada ✅')
  }

  // ══════════════════════════════════════════════════════════════════
  //  ENDPOINTS HTTP
  // ══════════════════════════════════════════════════════════════════
  app.get('/webhook-status', (_, res) => res.json({ ok:true, chatbot:true, version: VERSION }))

  app.get('/chatbot/status', (_, res) =>
    res.json({ ok:true, enabled:chatbotEnabled, rules:chatbotRules.length, conversations:conversations.size, version: VERSION })
  )

  app.post('/chatbot/reload', (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok:false })
    productsCache = []; productsCacheTs = 0 // invalidar cache de productos
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
      conversations.delete(phone)
      console.log(`[Chatbot] Bot reactivado: ${phone}`)
    } else {
      conversations.set(phone, { state: 'admin_takeover', ts: Date.now() })
      console.log(`[Chatbot] Admin takeover: ${phone}`)
    }
    res.json({ ok:true, phone, release })
  })

  // ── POST-ENTREGA: pedir reseña automáticamente ────────────────────
  // Llamado desde el panel admin cuando un pedido pasa a "delivered"
  app.post('/chatbot/review-request', async (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok:false })
    const { phone, customer_name, order_number } = req.body || {}
    if (!phone || !client) return res.status(400).json({ ok:false, error:'No phone or client' })
    try {
      const name = (customer_name||'').split(' ')[0] || 'Cliente'
      const msg = `🍓 ¡Hola ${name}! Esperamos que hayas disfrutado tu pedido *#${order_number}* de CarmoCream.\n\n` +
        `Si tienes un momento, una reseña en Google nos ayuda muchísimo:\n👉 https://g.page/r/carmocream/review\n\n` +
        `¡Hasta pronto! 🙏 *@carmocream_*`
      await client.sendMessage(`${phone.replace(/\D/g,'')}@c.us`, msg)
      console.log(`[Chatbot] Review request enviada a ${phone}`)
      res.json({ ok:true })
    } catch (e) {
      console.error('[Chatbot] review-request:', e.message)
      res.status(500).json({ ok:false, error: e.message })
    }
  })

  // ── BROADCAST: mensaje manual a lista de teléfonos ────────────────
  app.post('/chatbot/broadcast', async (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok:false })
    const { phones, message } = req.body || {}
    if (!phones?.length || !message || !client) return res.status(400).json({ ok:false })
    let sent = 0, errors = 0
    for (const phone of phones.slice(0, 50)) { // máx 50 por seguridad
      try {
        await client.sendMessage(`${phone.replace(/\D/g,'')}@c.us`, message)
        sent++
        await new Promise(r => setTimeout(r, 1500)) // evitar spam ban
      } catch { errors++ }
    }
    res.json({ ok:true, sent, errors })
  })

  // ── Carga inicial y refresco ──────────────────────────────────────
  loadRules()
  setInterval(loadRules, 5 * 60 * 1000)

  // Limpiar conversaciones colgadas > 30 min
  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000
    for (const [phone, conv] of conversations.entries()) {
      if ((conv.ts || 0) < cutoff && conv.state !== 'admin_takeover') conversations.delete(phone)
    }
  }, 10 * 60 * 1000)
}
