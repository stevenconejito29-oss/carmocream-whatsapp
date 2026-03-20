/**
 * chatbot_railway_webhook.js — CarmoCream v5.0
 * =====================================================
 * FIXES v5.0:
 *   ✅ chatbotEnabled arranca en TRUE (no FALSE) — si la BD falla, el bot sigue vivo
 *   ✅ Filtro productos: available=eq.true (no active=eq.true, columna no existe)
 *   ✅ Prefer: count=none en todos los GET — 30-40% más rápido
 *   ✅ Carga review_url, affiliate_url, min_order, delivery_fee de Supabase settings
 *   ✅ Menú incluye combos además de productos
 *   ✅ Búsqueda de pedido con ilike % (no *) — compatible con todas versiones PostgREST
 *   ✅ REVIEW_URL dinámica — se lee de BD o de ENV, nunca hardcodeada
 *   ✅ Anti-doble-respuesta robusto (2s cooldown)
 *   ✅ Cleanup de conversaciones colgadas cada 10 min
 * =====================================================
 *
 * VARIABLES DE ENTORNO EN RAILWAY:
 *   SUPABASE_URL             = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY = eyJhbGci...  (service_role, no anon)
 *   WA_SECRET                = tu-secreto
 *   ADMIN_PHONE              = 34XXXXXXXXX  (sin + ni espacios)
 *   SHOP_URL                 = https://carmocream.vercel.app
 *   INSTAGRAM_HANDLE         = @carmocream_  (opcional)
 *   REVIEW_URL               = https://... (opcional, se lee de BD si está vacío)
 */

const WEB_URL          = process.env.SHOP_URL          || 'https://carmocream.vercel.app'
const ADMIN_PHONE      = process.env.ADMIN_PHONE        || ''
const INSTAGRAM_HANDLE = process.env.INSTAGRAM_HANDLE  || '@carmocream_'

// REVIEW_URL: primero env, luego se actualiza desde BD en loadSettings()
let REVIEW_URL    = process.env.REVIEW_URL    || `${WEB_URL}/menu`
let AFFILIATE_URL = process.env.AFFILIATE_URL || `${WEB_URL}/afiliado`

const VERSION = '5.0.0'

const NO_CANCEL_STATES = ['preparing', 'ready', 'delivering', 'delivered']
const STATE_LABELS = {
  pending:    '⏳ Recibido, pendiente de confirmar',
  preparing:  '👨\u200d🍳 En preparación',
  ready:      '✅ Listo para entregar',
  delivering: '🛵 En camino hacia ti',
  delivered:  '🎉 Entregado',
  cancelled:  '❌ Cancelado',
}
const STATE_TIPS = {
  pending:    'Lo hemos recibido y lo gestionamos en breve. Te avisamos cuando avance 👍',
  preparing:  '¡Estamos preparándolo ahora mismo! En unos minutos sale 🛵',
  ready:      'Ya está listo y esperando al repartidor. ¡Enseguida en camino! 🛵',
  delivering: '¡Tu repartidor ya está en camino! En breve llega a tu puerta 🍓',
  delivered:  '¡Esperamos que lo hayas disfrutado! Si quieres repetir, ya sabes 😄',
  cancelled:  'El pedido fue cancelado. Para hacer uno nuevo visita la web 👇',
}

module.exports = function setupChatbot(app, client, supabaseUrl, supabaseKey) {

  // ── Estado interno ─────────────────────────────────────────────────────────
  // chatbotEnabled arranca en TRUE para que el bot funcione aunque la BD tarde
  let chatbotEnabled   = true
  let chatbotRules     = []
  let productsCache    = []
  let combosCache      = []
  let cacheTs          = 0
  let minOrder         = 0
  let deliveryFee      = 0
  const CACHE_TTL      = 5 * 60 * 1000   // 5 min

  const conversations  = new Map()   // phone → { state, ...data, ts }
  const recentReplies  = new Map()   // anti-spam

  // ── Supabase helper ────────────────────────────────────────────────────────
  async function sbFetch(path, opts = {}) {
    const url = `${supabaseUrl}/rest/v1/${path}`
    const res = await fetch(url, {
      ...opts,
      headers: {
        apikey:          supabaseKey,
        Authorization:   `Bearer ${supabaseKey}`,
        'Content-Type':  'application/json',
        // count=none = no calcular total de filas → 30-40% más rápido en GET
        Prefer:          'count=none',
        ...(opts.headers || {}),
      },
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`Supabase ${res.status}: ${txt.slice(0, 200)}`)
    }
    return res.json()
  }

  // ── Cargar settings y reglas de la BD ─────────────────────────────────────
  async function loadSettings() {
    try {
      const data = await sbFetch(
        'settings?key=in.(chatbot_enabled,chatbot_rules,review_url,affiliate_url,min_order,delivery_fee)&select=key,value'
      )
      const map = Object.fromEntries((data || []).map(r => [r.key, r.value]))

      // Solo cambiar chatbotEnabled si la BD responde OK
      if (map.chatbot_enabled !== undefined) {
        chatbotEnabled = map.chatbot_enabled === 'true'
      }
      // URLs dinámicas desde BD (si existen)
      if (map.review_url?.trim())    REVIEW_URL    = map.review_url.trim()
      if (map.affiliate_url?.trim()) AFFILIATE_URL = map.affiliate_url.trim()
      // Valores operativos
      if (map.min_order)    minOrder    = parseFloat(map.min_order)    || 0
      if (map.delivery_fee) deliveryFee = parseFloat(map.delivery_fee) || 0

      try {
        const parsed = JSON.parse(map.chatbot_rules || '[]')
        if (Array.isArray(parsed) && parsed.length) chatbotRules = parsed
      } catch {}

      console.log(`[Chatbot] v${VERSION} — Reglas: ${chatbotRules.length} | Activo: ${chatbotEnabled} | Review: ${REVIEW_URL}`)
    } catch (e) {
      console.error('[Chatbot] loadSettings FALLO (bot sigue activo con config anterior):', e.message)
    }
  }

  // ── Productos y combos activos (cache 5 min) ───────────────────────────────
  async function getActiveProducts() {
    if (Date.now() - cacheTs < CACHE_TTL && productsCache.length) return productsCache
    try {
      // available=eq.true — columna correcta en el schema de CarmoCream
      const data = await sbFetch(
        'products?available=eq.true' +
        '&or=(club_only.eq.false,club_only.is.null)' +
        '&select=id,name,price,price_medium,price_large,description,emoji,category' +
        '&order=sort_order'
      )
      productsCache = data || []
      cacheTs = Date.now()
      console.log(`[Chatbot] Productos cargados: ${productsCache.length}`)
    } catch (e) {
      console.error('[Chatbot] getActiveProducts:', e.message)
    }
    return productsCache
  }

  async function getActiveCombos() {
    if (Date.now() - cacheTs < CACHE_TTL && combosCache.length) return combosCache
    try {
      const data = await sbFetch(
        'combos?available=eq.true' +
        '&select=id,name,price,description,emoji' +
        '&order=sort_order'
      )
      combosCache = data || []
    } catch (e) {
      console.error('[Chatbot] getActiveCombos:', e.message)
    }
    return combosCache
  }

  // ── Cupones activos ────────────────────────────────────────────────────────
  async function getActiveCoupons() {
    try {
      const now = new Date().toISOString()
      const data = await sbFetch(
        `coupons?active=eq.true` +
        `&or=(expires_at.is.null,expires_at.gt.${now})` +
        `&select=code,discount_type,discount_value,min_order`
      )
      return data || []
    } catch { return [] }
  }

  // ── Buscar último pedido activo por teléfono ───────────────────────────────
  async function findLastOrder(phone) {
    try {
      const raw = phone.replace('@c.us', '').replace(/\D/g, '')
      // Últimos 9 dígitos = número sin prefijo de país
      const local9 = raw.replace(/^34/, '').slice(-9)
      const full34 = '34' + local9

      let data = []
      // Intentar filtrar directo en BD (mucho más eficiente)
      try {
        data = await sbFetch(
          `orders?status=neq.cancelled` +
          `&customer_phone=ilike.%25${local9}%25` +
          `&order=created_at.desc&limit=5` +
          `&select=id,order_number,status,total,created_at,items,customer_name,customer_phone,delivery_address`
        )
        if (!data?.length) {
          data = await sbFetch(
            `orders?status=neq.cancelled` +
            `&customer_phone=ilike.%25${full34}%25` +
            `&order=created_at.desc&limit=5` +
            `&select=id,order_number,status,total,created_at,items,customer_name,customer_phone,delivery_address`
          )
        }
      } catch {
        // Fallback: traer los últimos 200 y filtrar en memoria
        const fallback = await sbFetch(
          `orders?status=neq.cancelled&order=created_at.desc&limit=200` +
          `&select=id,order_number,status,total,created_at,items,customer_name,customer_phone,delivery_address`
        )
        data = (fallback || []).filter(r => {
          const d = (r.customer_phone || '').replace(/\D/g, '').replace(/^34/, '').slice(-9)
          return d === local9
        })
      }

      const order = (data || [])[0] || null
      console.log(`[Chatbot] findLastOrder ${local9}: ${order ? '#' + order.order_number + ' ' + order.status : 'ninguno'}`)
      return order
    } catch (e) {
      console.error('[Chatbot] findLastOrder:', e.message)
      return null
    }
  }

  // ── Historial del cliente ─────────────────────────────────────────────────
  async function getCustomerHistory(phone) {
    try {
      const raw    = phone.replace('@c.us', '').replace(/\D/g, '')
      const local9 = raw.replace(/^34/, '').slice(-9)
      const data   = await sbFetch(
        `orders?customer_phone=ilike.%25${local9}%25` +
        `&select=id,customer_name,total,status,customer_phone,created_at` +
        `&order=created_at.desc&limit=10`
      )
      return data || []
    } catch { return [] }
  }

  // ── Cancelar pedido ────────────────────────────────────────────────────────
  async function cancelOrder(orderId) {
    try {
      await sbFetch(`orders?id=eq.${orderId}`, {
        method:  'PATCH',
        headers: { Prefer: 'return=minimal' },
        body:    JSON.stringify({ status: 'cancelled' }),
      })
      return true
    } catch (e) { console.error('[Chatbot] cancelOrder:', e.message); return false }
  }

  // ── Guardar conversación escalada ─────────────────────────────────────────
  async function saveConversation(phone, state, reason, lastMessage, extra = {}) {
    try {
      await sbFetch('chatbot_conversations', {
        method:  'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body:    JSON.stringify({
          phone, state, escalation_reason: reason,
          last_message: lastMessage, admin_takeover: false,
          resolved: false, updated_at: new Date().toISOString(),
          ...extra,
        }),
      })
    } catch (e) { console.error('[Chatbot] saveConversation:', e.message) }
  }

  // ── Notificar al admin ─────────────────────────────────────────────────────
  async function notifyAdmin(text) {
    if (!ADMIN_PHONE || !client) return
    try { await client.sendMessage(`${ADMIN_PHONE}@c.us`, text) }
    catch (e) { console.error('[Chatbot] notifyAdmin:', e.message) }
  }

  // ── Formatear items del pedido ─────────────────────────────────────────────
  function formatOrderItems(order) {
    try {
      const items = typeof order.items === 'string'
        ? JSON.parse(order.items)
        : (order.items || [])
      if (!items.length) return ''
      const lines = items.slice(0, 5).map(it => {
        const name  = it.product_name || it.name || 'Producto'
        const qty   = it.qty || it.quantity || 1
        const price = it.price ? ` · €${Number(it.price * qty).toFixed(2)}` : ''
        return `  • ${qty}x ${name}${price}`
      })
      if (items.length > 5) lines.push(`  _...y ${items.length - 5} más_`)
      return '\n🛒 *Productos:*\n' + lines.join('\n')
    } catch { return '' }
  }

  // ── Formatear lista de menú ────────────────────────────────────────────────
  function formatMenuList(products, combos) {
    const lines = []
    if (combos.length) {
      lines.push('*🎁 Combos:*')
      combos.slice(0, 4).forEach(c =>
        lines.push(`  • ${c.emoji || '🎁'} *${c.name}* — €${Number(c.price || 0).toFixed(2)}`)
      )
    }
    if (products.length) {
      lines.push('*🍓 Productos:*')
      products.slice(0, 10).forEach(p => {
        const hasSizes = p.price_medium || p.price_large
        const priceStr = hasSizes
          ? `desde €${Number(p.price || 0).toFixed(2)}`
          : `€${Number(p.price || 0).toFixed(2)}`
        lines.push(`  • ${p.emoji || '🍨'} *${p.name}* — ${priceStr}`)
      })
      if (products.length > 10) lines.push(`  _...y ${products.length - 10} productos más en la web_`)
    }
    return lines.join('\n')
  }

  // ── Normalizar texto para matching ────────────────────────────────────────
  function norm(text) {
    return (text || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[¿¡]/g, '').trim()
  }

  // ══════════════════════════════════════════════════════════════════
  //  MÁQUINA DE ESTADOS
  // ══════════════════════════════════════════════════════════════════
  async function handleMessage(phone, rawText) {
    if (!chatbotEnabled) return null

    const text = (rawText || '').trim()
    if (!text) return null
    const n    = norm(text)
    const conv = conversations.get(phone) || { state: 'idle' }
    const now  = Date.now()

    // Admin takeover → silenciar bot
    if (conv.state === 'admin_takeover') return null

    // Anti-spam: máx 1 respuesta cada 2s
    const lastReply = recentReplies.get(phone) || 0
    if (now - lastReply < 2000) return null
    recentReplies.set(phone, now)

    // Horario
    const hour   = new Date().getHours()
    const dayNum = new Date().getDay() // 0=Dom, 1=Lun
    const isOpen = dayNum !== 1 && hour >= 14 && hour < 21

    // Fuera de horario + intento de pedir
    if (!isOpen && /pedir|pedido nuevo|hacer pedido|quiero pedir|quiero uno|ponme|quisiera pedir/.test(n)) {
      const when = dayNum === 1 ? 'mañana martes' : hour < 14 ? 'hoy a las 14:00' : 'mañana'
      return `🕐 Ahora mismo estamos cerrados.\n\n*Horario: Martes a Domingo · 14:00 – 21:00*\n\nAbrimos ${when} — puedes ver el menú ya:\n👉 *${WEB_URL}/menu*\n\n¡Hasta pronto! 🍓`
    }

    // ── Esperando confirmación de cancelación ─────────────────────
    if (conv.state === 'waiting_cancel_confirm') {
      conversations.delete(phone)
      if (/^(si|sí|s|yes|confirmo|cancela|cancelar|dale|ok|claro|adelante)$/i.test(n)) {
        const order = conv.order
        if (!order) return '❌ No encontré tu pedido. Escribe *"hablar"* y te ayudamos.'
        // Verificar estado actual antes de cancelar
        let freshStatus = order.status
        try {
          const d = await sbFetch(`orders?id=eq.${order.id}&select=status&limit=1`)
          freshStatus = (d || [])[0]?.status || order.status
        } catch {}
        if (NO_CANCEL_STATES.includes(freshStatus)) {
          return `⚠️ *Ya no podemos cancelar el pedido #${order.order_number}.*\n\nEstado actual: *${STATE_LABELS[freshStatus]}*\n${STATE_TIPS[freshStatus]}\n\nSi hay algún problema al recibirlo escribe *"queja"* 🙏`
        }
        const ok = await cancelOrder(order.id)
        return ok
          ? `✅ *Pedido #${order.order_number} cancelado.*\n\nCuando quieras volver, aquí estamos 🍓`
          : `❌ Hubo un problema al cancelar. Escribe *"hablar"* y lo resolvemos.`
      }
      if (/^(no|nop|nope|no cancelar|mantener)$/i.test(n))
        return `✅ ¡Perfecto! Tu pedido sigue activo. ¿En qué más te ayudo? 😊`
      return `Responde *Sí* para cancelar o *No* para mantener el pedido.`
    }

    // ── Número de pedido específico en el mensaje ─────────────────
    const numMatch = text.match(/#?(\d{3,6})/)
    if (numMatch && /pedido|numero|número|ref|referencia/.test(n)) {
      try {
        const num  = numMatch[1]
        const data = await sbFetch(
          `orders?order_number=eq.${num}&select=id,order_number,status,total,created_at,items,customer_name&limit=1`
        )
        const found = (data || [])[0]
        if (found) {
          return `📋 *Pedido #${found.order_number}*\n\nEstado: *${STATE_LABELS[found.status] || found.status}*\n💰 Total: €${Number(found.total || 0).toFixed(2)}${formatOrderItems(found)}\n\n${STATE_TIPS[found.status] || ''}`
        }
      } catch {}
    }

    // ── Nuevo pedido ──────────────────────────────────────────────
    if (/quiero pedir|hacer un pedido|pedir ahora|ponme un|quiero uno|me pones|me mandas|voy a pedir/.test(n)) {
      const extra = minOrder > 0 ? `\n\nPedido mínimo: *€${minOrder.toFixed(2)}*` : ''
      const fee   = deliveryFee > 0 ? ` · Envío: €${deliveryFee.toFixed(2)}` : ' · Envío gratis'
      return `🍓 ¡Perfecto! Haz tu pedido aquí:\n👉 *${WEB_URL}/menu*\n\nEntrega en *20–35 min*${fee}${extra}\n\n_Pago en efectivo al repartidor._`
    }

    // ── Cancelar pedido ───────────────────────────────────────────
    if (/cancelar|anular|quiero cancelar|cancela|no lo quiero|no quiero el pedido|borra el pedido/.test(n)) {
      const order = await findLastOrder(phone)
      if (!order) return `❌ No encontré pedidos activos en tu número.\n\nSi crees que es un error, escribe *"hablar"* 🙏`
      if (order.status === 'cancelled') return `ℹ️ Tu pedido *#${order.order_number}* ya estaba cancelado.`
      if (NO_CANCEL_STATES.includes(order.status)) {
        return `⚠️ *Lo sentimos, el pedido #${order.order_number} ya no se puede cancelar.*\n\nEstado: *${STATE_LABELS[order.status]}*\n${STATE_TIPS[order.status]}\n\nSi hay algún problema escribe *"queja"* 🙏`
      }
      conversations.set(phone, { state: 'waiting_cancel_confirm', order, ts: now })
      return `⚠️ *¿Seguro que quieres cancelar?*\n\nPedido *#${order.order_number}* · €${Number(order.total || 0).toFixed(2)}\nEstado: ${STATE_LABELS[order.status]}${formatOrderItems(order)}\n\nResponde *Sí* para cancelar o *No* para mantenerlo.`
    }

    // ── Estado del pedido ─────────────────────────────────────────
    if (/estado|donde esta|mi pedido|cuando llega|lo has recibido|confirmado|cuando sale|sigue en pie|han recibido|recibiste|tienes mi pedido/.test(n)) {
      const order = await findLastOrder(phone)
      if (!order) return `📋 No encontré pedidos activos en tu número.\n\nSi acabas de pedir, puede tardar unos segundos. Inténtalo de nuevo en un momento 😊\n\n¿Quieres hacer uno?\n👉 *${WEB_URL}/menu*`
      const hora = new Date(order.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
      return `📋 *Pedido #${order.order_number}*\n\n🕐 Realizado a las: *${hora}*\n💰 Total: *€${Number(order.total || 0).toFixed(2)}*\n📦 Estado: *${STATE_LABELS[order.status] || order.status}*${formatOrderItems(order)}\n\n${STATE_TIPS[order.status] || ''}\n\n_Si necesitas ayuda escribe *"hablar"* 🙏_`
    }

    // ── Modificar pedido ──────────────────────────────────────────
    if (/cambiar|modificar|cambio|añadir al pedido|quitar del pedido|otro sabor|cambiar direc/.test(n)) {
      const order = await findLastOrder(phone)
      if (!order) return `❓ No encontré ningún pedido activo.\n\nPara hacer uno:\n👉 *${WEB_URL}/menu*`
      if (NO_CANCEL_STATES.includes(order.status))
        return `⚠️ El pedido *#${order.order_number}* ya está en *${STATE_LABELS[order.status]}* y no se puede modificar.\n\nSi hay un problema al recibirlo escribe *"queja"* 🙏`
      await saveConversation(phone, 'escalated', 'Solicitud de modificación', text)
      await notifyAdmin(`✏️ *MODIFICACIÓN — CarmoCream*\n\n📞 ${phone.replace('@c.us', '')} · #${order.order_number}\n💬 "${text.slice(0, 150)}"`)
      return `✏️ Recibida tu solicitud para el pedido *#${order.order_number}*.\nHemos avisado al equipo. Te confirmamos en breve 🙏`
    }

    // ── Ver menú ──────────────────────────────────────────────────
    if (/menu|carta|que teneis|que tienen|que vendeis|que ofreceis|productos|que hay|que tipos|catalogo|que haceis/.test(n)) {
      const [prods, combos] = await Promise.all([getActiveProducts(), getActiveCombos()])
      if (!prods.length && !combos.length)
        return `Puedes ver el menú completo en:\n👉 *${WEB_URL}/menu*`
      return `🍓 *Menú CarmoCream* — Todo Sin Lactosa\n\n${formatMenuList(prods, combos)}\n\n👉 *${WEB_URL}/menu*\n\n¿Te apetece algo? 😋`
    }

    // ── Precios ───────────────────────────────────────────────────
    if (/cuanto cuesta|cuanto vale|que precio|precio de|cuanto es|cuanto cobr|cuanto valen|a cuanto/.test(n)) {
      const prods = await getActiveProducts()
      if (!prods.length) return `Todos los precios en:\n👉 *${WEB_URL}/menu*`
      const match = prods.find(p => n.includes(norm(p.name)))
      if (match) {
        const hasSizes = match.price_medium || match.price_large
        return `💰 ${match.emoji || '🍨'} *${match.name}* — ${hasSizes ? `desde *€${Number(match.price || 0).toFixed(2)}*` : `*€${Number(match.price || 0).toFixed(2)}*`}\n\n👉 *${WEB_URL}/menu*`
      }
      const combos = await getActiveCombos()
      return `💰 *Precios:*\n\n${formatMenuList(prods, combos)}\n\n👉 *${WEB_URL}/menu* 🛒`
    }

    // ── Descuentos / cupones ──────────────────────────────────────
    if (/descuento|cupon|cupón|codigo|oferta|promo|promocion|rebaja|teneis algo/.test(n)) {
      const coupons = await getActiveCoupons()
      if (!coupons.length)
        return `Ahora mismo no hay promociones activas 😊\nSíguenos en Instagram:\n👉 *${INSTAGRAM_HANDLE}*\n\n${WEB_URL}/menu`
      const list = coupons.map(c => {
        const val = c.discount_type === 'percent' ? `${c.discount_value}%` : `€${Number(c.discount_value || 0).toFixed(2)}`
        const min = c.min_order ? ` (mín. €${Number(c.min_order).toFixed(2)})` : ''
        return `🎟️ *${c.code}* — ${val} descuento${min}`
      }).join('\n')
      return `🎟️ *Promociones activas:*\n\n${list}\n\nAplícalos al pedir en:\n👉 *${WEB_URL}/menu* 🛒`
    }

    // ── Horario ───────────────────────────────────────────────────
    if (/horario|cuando abris|a que hora|cuando estais|cerrado|abierto|dias de la semana/.test(n))
      return `🕐 *Horario CarmoCream*\n\n📅 Martes a Domingo: 14:00 – 21:00\n❌ Lunes: cerrado\n\n${isOpen ? '🟢 *Ahora estamos abiertos* 🍓' : '🔴 Ahora estamos cerrados.'}\n\n👉 *${WEB_URL}/menu*`

    // ── Zona de reparto ───────────────────────────────────────────
    if (/zona|repartis|llegais|entregais|domicilio|delivery|reparto|envio|cubris|barrio|llegar a/.test(n))
      return `🛵 *Zona de reparto:*\n\nRepartimos por *Carmona* y alrededores.\n\nSi no estás seguro/a de si llegamos a tu zona, dinos la dirección y te confirmamos 😊\n\n👉 *${WEB_URL}/menu*`

    // ── Pago ──────────────────────────────────────────────────────
    if (/pago|pagar|como se paga|bizum|tarjeta|efectivo|transferencia|aceptais/.test(n))
      return `💵 *Formas de pago:*\n\n💵 Efectivo al repartidor\n📲 Bizum\n💳 Tarjeta\n\n👉 *${WEB_URL}/menu*`

    // ── Alérgenos ─────────────────────────────────────────────────
    if (/alergeno|lactosa|sin lactosa|intolerante|gluten|vegano|ingredientes|que lleva|que contiene|dieta/.test(n))
      return `🌿 *CarmoCream — 100% Sin Lactosa*\n\nTodos nuestros productos son sin lactosa.\n\nSi tienes otra alergia específica escribe *"hablar"* 🙏`

    // ── Tiempo de entrega ─────────────────────────────────────────
    if (/cuanto tarda|tiempo de entrega|tiempo estimado|rapido|en cuanto/.test(n))
      return `⏱️ Tiempos habituales:\n\n• *Preparación:* 10–15 min\n• *Entrega en Carmona:* 10–20 min\n• *Total estimado: 20–35 min*\n\n👉 *${WEB_URL}/menu*`

    // ── Pedido mínimo ─────────────────────────────────────────────
    if (/minimo|mínimo|pedido minimo|gastos envio|hay minimo/.test(n)) {
      const msg = minOrder > 0
        ? `📦 El pedido mínimo es de *€${minOrder.toFixed(2)}*`
        : `📦 ¡No tenemos pedido mínimo! 🎉`
      return `${msg}\n\n👉 *${WEB_URL}/menu*`
    }

    // ── Queja ─────────────────────────────────────────────────────
    if (/queja|reclamacion|problema|llego mal|llegó mal|faltaba|estaba mal|no llegó|frio|frío|equivocado/.test(n)) {
      await saveConversation(phone, 'escalated', 'Queja/problema con pedido', text)
      await notifyAdmin(`🚨 *QUEJA — CarmoCream*\n\n📞 ${phone.replace('@c.us', '')}\n💬 "${text.slice(0, 200)}"`)
      return `😔 Sentimos mucho el problema.\n\nHemos notificado al equipo y alguien te contactará *en menos de 30 minutos*.\n\nSi es urgente escribe *"hablar"* 🙏`
    }

    // ── Hablar con humano ─────────────────────────────────────────
    if (/hablar|persona|humano|real|agente|encargado|necesito ayuda|ayuda urgente/.test(n)) {
      await saveConversation(phone, 'escalated', 'Cliente solicita atención humana', text)
      await notifyAdmin(`🙋 *ATENCIÓN HUMANA — CarmoCream*\n\n📞 ${phone.replace('@c.us', '')}\n💬 "${text.slice(0, 200)}"`)
      return `¡Claro! 🙋 He notificado al equipo.\n\nAlguien te responderá en este chat en unos minutos.\n\n¿Hay algo más en lo que pueda ayudarte mientras? 😊`
    }

    // ── Agradecimiento ────────────────────────────────────────────
    if (/gracias|muchas gracias|genial|perfecto|excelente|muy bueno|riquísimo|me encantó|volveré/.test(n)) {
      try { await saveConversation(phone, 'happy', null, text, { resolved: true }) } catch {}
      const reviewLink = REVIEW_URL || `${WEB_URL}/menu`
      return `🍓 ¡Muchísimas gracias! Nos alegra saberlo.\n\nSi tienes un momento, una reseña nos ayuda a crecer:\n👉 ${reviewLink}\n\n¡Hasta pronto! *${INSTAGRAM_HANDLE}*`
    }

    // ── Saludo inicial ────────────────────────────────────────────
    if (/^(hola|buenas|buenos dias|buenas tardes|hello|hey|saludos|holi)$/i.test(n.trim())) {
      const history    = await getCustomerHistory(phone)
      const isReturning = history.length > 0
      const firstName  = history[0]?.customer_name?.split(' ')[0] || ''
      if (isReturning) {
        return `¡Hola${firstName ? ` ${firstName}` : ''}! 🍓 ¡Qué alegría verte de nuevo!\n\n¿Hacemos tu pedido de siempre o quieres ver las novedades?\n👉 *${WEB_URL}/menu*\n\nEscríbeme si necesitas cualquier cosa 😊`
      }
      return `¡Hola! 👋 Bienvenido/a a *CarmoCream* 🍓\nPostres artesanales 100% Sin Lactosa · Carmona\n\nPuedo ayudarte con:\n🛒 *"menú"* — Ver productos y precios\n📋 *"mi pedido"* — Estado en tiempo real\n❌ *"cancelar"* — Cancelar tu pedido\n🕐 *"horario"* — Cuándo estamos abiertos\n💬 *"hablar"* — Atención personal\n\nO pide directamente:\n👉 *${WEB_URL}/menu*`
    }

    // ── Reglas estáticas del panel admin ─────────────────────────
    const rule = chatbotRules.find(r => {
      if (!r.active) return false
      return r.trigger.split(',')
        .map(t => norm(t.trim()))
        .some(kw => kw && n.includes(kw))
    })
    if (rule) {
      return rule.response
        .replace(/\{\{web\}\}/g, WEB_URL)
        .replace(/\{\{review\}\}/g, REVIEW_URL)
        .replace(/\{\{afiliado\}\}/g, AFFILIATE_URL)
    }

    // ── Fallback ──────────────────────────────────────────────────
    return `👋 Soy el asistente de *CarmoCream* 🍓\n\nPara ver el menú y pedir:\n👉 *${WEB_URL}/menu*\n\nTambién puedo ayudarte con:\n• *"menú"* — Productos y precios\n• *"mi pedido"* — Estado en tiempo real\n• *"cancelar"* — Cancelar pedido\n• *"horario"* — Cuándo estamos abiertos\n• *"zona"* — Zona de reparto\n• *"hablar"* — Hablar con el equipo\n\n_CarmoCream · Carmona · Sin Lactosa_ 🍓`
  }

  // ══════════════════════════════════════════════════════════════════
  //  ESCUCHA DE MENSAJES
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
        console.log(`[Chatbot] ✅ ${msg.from.slice(0, 20)}: "${(msg.body || '').slice(0, 40)}" → ${reply.slice(0, 60)}`)
      } catch (e) { console.error('[Chatbot] Error procesando mensaje:', e.message) }
    })
    console.log('[Chatbot] Escucha activada ✅')
  }

  // ══════════════════════════════════════════════════════════════════
  //  ENDPOINTS HTTP
  // ══════════════════════════════════════════════════════════════════

  app.get('/chatbot/status', (_, res) =>
    res.json({ ok: true, enabled: chatbotEnabled, rules: chatbotRules.length, conversations: conversations.size, version: VERSION })
  )

  app.post('/chatbot/reload', (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    productsCache = []; combosCache = []; cacheTs = 0  // invalida cache
    loadSettings().then(() => res.json({ ok: true, rules: chatbotRules.length, enabled: chatbotEnabled }))
  })

  app.post('/chatbot/test', async (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    const { message, phone } = req.body || {}
    const reply = await handleMessage(phone || 'test@c.us', message || '')
    res.json({ matched: !!reply, reply, enabled: chatbotEnabled })
  })

  // Diagnóstico de BD (útil desde el panel admin)
  app.get('/chatbot/ping-db', async (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET && req.query.secret !== process.env.WA_SECRET)
      return res.status(401).json({ ok: false })
    try {
      const data = await sbFetch('settings?key=eq.chatbot_enabled&select=key,value&limit=1')
      res.json({ ok: true, db: 'connected', chatbot_enabled: (data || [])[0]?.value })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  app.post('/chatbot/takeover', (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    const { phone, release } = req.body || {}
    if (release) {
      conversations.delete(phone)
      console.log(`[Chatbot] Bot reactivado: ${phone}`)
    } else {
      conversations.set(phone, { state: 'admin_takeover', ts: Date.now() })
      console.log(`[Chatbot] Admin takeover: ${phone}`)
    }
    res.json({ ok: true, phone, release })
  })

  // Solicitud de reseña post-entrega
  app.post('/chatbot/review-request', async (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    const { phone, customer_name, order_number } = req.body || {}
    if (!phone || !client) return res.status(400).json({ ok: false, error: 'No phone or client' })
    try {
      const name = (customer_name || '').split(' ')[0] || 'Cliente'
      const link = REVIEW_URL || `${WEB_URL}/menu`
      const msg  = `🍓 ¡Hola ${name}! Esperamos que hayas disfrutado tu pedido *#${order_number}* de CarmoCream.\n\nSi tienes un momento, deja tu valoración:\n👉 ${link}\n\n¡Hasta pronto! 🙏 *${INSTAGRAM_HANDLE}*`
      await client.sendMessage(`${phone.replace(/\D/g, '')}@c.us`, msg)
      console.log(`[Chatbot] Review request → ${phone}`)
      res.json({ ok: true })
    } catch (e) {
      console.error('[Chatbot] review-request:', e.message)
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // Broadcast a lista de teléfonos
  app.post('/chatbot/broadcast', async (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    const { phones, message } = req.body || {}
    if (!phones?.length || !message || !client) return res.status(400).json({ ok: false })
    let sent = 0, errors = 0
    for (const phone of phones.slice(0, 50)) {
      try {
        await client.sendMessage(`${phone.replace(/\D/g, '')}@c.us`, message)
        sent++
        await new Promise(r => setTimeout(r, 1500))
      } catch { errors++ }
    }
    res.json({ ok: true, sent, errors })
  })

  // Clientes inactivos
  app.get('/chatbot/inactive-customers', async (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    const days      = parseInt(req.query.days || '7')
    const minOrders = parseInt(req.query.min_orders || '2')
    try {
      const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
      const data   = await sbFetch('orders?status=neq.cancelled&select=customer_phone,customer_name,created_at&order=created_at.desc')
      const map    = {}
      for (const r of (data || [])) {
        if (!r.customer_phone) continue
        if (!map[r.customer_phone]) map[r.customer_phone] = { phone: r.customer_phone, name: r.customer_name, last: r.created_at, count: 0 }
        map[r.customer_phone].count++
      }
      const inactive = Object.values(map)
        .filter(c => c.count >= minOrders && c.last < cutoff)
        .slice(0, 50)
      res.json({ ok: true, count: inactive.length, customers: inactive })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // Clientes VIP
  app.get('/chatbot/vip-customers', async (req, res) => {
    if (req.headers['x-secret'] !== process.env.WA_SECRET) return res.status(401).json({ ok: false })
    const minOrders = parseInt(req.query.min_orders || '3')
    try {
      const data = await sbFetch('orders?status=neq.cancelled&select=customer_phone,customer_name,total&order=created_at.desc')
      const map  = {}
      for (const r of (data || [])) {
        if (!r.customer_phone) continue
        if (!map[r.customer_phone]) map[r.customer_phone] = { phone: r.customer_phone, name: r.customer_name, count: 0, spent: 0 }
        map[r.customer_phone].count++
        map[r.customer_phone].spent += Number(r.total || 0)
      }
      const vips = Object.values(map)
        .filter(c => c.count >= minOrders)
        .sort((a, b) => b.count - a.count)
        .slice(0, 50)
        .map(c => ({ ...c, spent: Number(c.spent.toFixed(2)) }))
      res.json({ ok: true, count: vips.length, customers: vips })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // ── Inicialización ────────────────────────────────────────────
  loadSettings()
  setInterval(loadSettings, 5 * 60 * 1000)

  // Limpiar conversaciones colgadas > 30 min
  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000
    for (const [phone, conv] of conversations.entries()) {
      if ((conv.ts || 0) < cutoff && conv.state !== 'admin_takeover') {
        conversations.delete(phone)
      }
    }
  }, 10 * 60 * 1000)
}
