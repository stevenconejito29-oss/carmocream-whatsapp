import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from '../lib/useSettings'
import { useMenuData } from '../lib/useMenuData'
import { supabase } from '../lib/supabase'
import { useCart } from '../lib/useCart'
import { useStoreStatus } from '../lib/useStoreStatus'
import Cart from '../components/Cart'
import ProductModal from '../components/ProductModal'
import ComboModal from '../components/ComboModal'
import PostOrderScreen from '../components/PostOrderScreen'
import ProductAccessCard from '../components/menu/ProductAccessCard'
import ComboAccessCard from '../components/menu/ComboAccessCard'
import LoyaltyWidget from '../components/LoyaltyWidget'
import { useLoyalty } from '../lib/useLoyalty'
import { buildClubAccessMeta, buildClubUnlocks } from '../lib/clubAccess'
import {
  createReviewRewardCoupon,
  fetchReviews,
  flushScheduledReviewRequests,
  saveReviewFromOrderLink,
} from '../lib/reviewUtils'
// Supabase se usa solo para recuperar cupones y reenvios ya existentes.
import styles from './Menu.module.css'

// Detectar el navegador interno de Instagram (WKWebView recortado)
const IS_INSTAGRAM = typeof navigator !== 'undefined' && /Instagram/i.test(navigator.userAgent)

const CATEGORY_ICONS = {
  default: '\u{1F368}',
  combos: '\u{1F381}',
  clasicos: '\u{1F353}',
  tropicales: '\u{1F334}',
  temporada: '\u2600\uFE0F',
  bebidas: '\u{1F964}',
  especiales: '\u2728',
  postres: '\u{1F368}',
  helados: '\u{1F366}',
  smoothies: '\u{1F353}',
  ensaladas: '\u{1F96D}',
}
const CATEGORY_LABELS = {
  clasicos: 'CL\u00C1SICOS',
  tropicales: 'TROPICALES',
  temporada: 'TEMPORADA',
  bebidas: 'BEBIDAS',
  especiales: 'ESPECIALES',
  postres: 'POSTRES',
  helados: 'HELADOS',
  smoothies: 'SMOOTHIES',
  ensaladas: 'ENSALADAS',
  reviews: 'RESE\u00D1AS',
}
const DEFAULT_CATEGORY_ID = 'postres'
const REVIEW_CATEGORY_ID = 'reviews'
const CATEGORY_SORT_ORDER = ['clasicos', 'tropicales', 'temporada', 'bebidas', 'especiales', 'postres', 'helados', 'smoothies', 'ensaladas']

function normalizeCategoryId(category) {
  if (typeof category !== 'string') return DEFAULT_CATEGORY_ID
  const normalized = category.trim().toLowerCase()
  return normalized || DEFAULT_CATEGORY_ID
}

function resolveCategoryLabel(n) {
  return CATEGORY_LABELS[n?.toLowerCase()] || String(n || DEFAULT_CATEGORY_ID).toUpperCase()
}

function canAccessClubItem(item, loyalty) {
  if (!item?.club_only) return true

  const levels = Array.isArray(loyalty?.levels) ? loyalty.levels : []
  const currentLevel = loyalty?.currentLevel || null
  if (!currentLevel) return false

  if (item.club_only_level) {
    const requiredLevel = levels.find(level => level.id === item.club_only_level)
    if (!requiredLevel) return currentLevel.exclusive_menu === true
    return Number(currentLevel.min_orders || 0) >= Number(requiredLevel.min_orders || 0)
  }

  return currentLevel.exclusive_menu === true
}

function buildProjectedLoyaltySnapshot(loyaltyState) {
  const levels = Array.isArray(loyaltyState?.levels) ? [...loyaltyState.levels] : []
  const sortedLevels = levels.sort((a, b) => Number(a.min_orders || 0) - Number(b.min_orders || 0))
  const projectedOrderCount = Number(loyaltyState?.orderCount || 0) + 1
  const projectedCurrentLevel = [...sortedLevels]
    .reverse()
    .find(level => projectedOrderCount >= Number(level.min_orders || 0))
    || loyaltyState?.currentLevel
    || null
  const projectedNextLevel = sortedLevels.find(level => projectedOrderCount < Number(level.min_orders || 0)) || null

  return {
    ...loyaltyState,
    orderCount: projectedOrderCount,
    currentLevel: projectedCurrentLevel,
    nextLevel: projectedNextLevel,
  }
}

const SECTION_FRUITS = {
  combos: ['\u{1F381}', '\u{1F353}', '\u{1F352}', '\u{1F34D}', '\u{1F96D}', '\u2728'],
  products: ['\u{1F353}', '\u{1F34D}', '\u{1F96D}', '\u{1F352}', '\u{1F34B}', '\u{1F95D}', '\u{1F34A}', '\u{1F366}'],
  reviews: ['\u2B50', '\u{1F353}', '\u{1F352}', '\u{1F34D}', '\u2728'],
}
// ─── Tema del header: color elegido → blanco ───────────────────────────────
// El color se usa tal cual — el degradado va del color a blanco en CSS.
// Las sombras de texto garantizan legibilidad sobre la zona clara.
function deriveHeroTheme(color) {
  const base = (color && /^#[0-9A-Fa-f]{3,6}$/.test(color)) ? color : '#E8607A'
  return { base }
}

function SectionFruitRain({ type = 'products' }) {
  const fruits = SECTION_FRUITS[type] || SECTION_FRUITS.products
  // En Instagram reducimos los clones para no saturar el WebView
  const pieces = useMemo(() => (
    fruits.flatMap((fruit, index) => {
      const normalClones = type === 'products' ? 5 : 4
      const clones = IS_INSTAGRAM ? 1 : normalClones
      return Array.from({ length: clones }, (_, cloneIndex) => {
        const seed = (index + 1) * 37 + cloneIndex * 29 + type.length * 19
        const left = 2 + ((seed * 11) % 96)
        const delay = -((seed * 0.41) % 13.5)
        // En Instagram duraciones más largas = menos fps necesarios = menos carga
        const baseDuration = IS_INSTAGRAM ? 18 : 8.8
        const durationRange = IS_INSTAGRAM ? 10 : 12.4
        const duration = baseDuration + ((seed * 0.23) % durationRange)
        const size = 0.92 + ((seed % 9) * 0.19)
        const drift = -58 + ((seed * 7) % 116)
        const top = -12 - ((seed * 5) % 34)
        const sway = -20 + ((seed * 3) % 40)
        const rotate = -32 + ((seed * 9) % 64)
        const opacity = 0.2 + (((seed * 5) % 32) / 100)
        return {
          id: `${type}-${fruit}-${index}-${cloneIndex}`,
          fruit,
          left,
          delay,
          duration,
          size,
          drift,
          top,
          sway,
          rotate,
          opacity,
        }
      })
    })
  ), [fruits, type])

  return (
    <div className={styles.sectionFruitRain} aria-hidden="true">
      {pieces.map(piece => (
        <span
          key={piece.id}
          className={styles.sectionFruit}
          style={{
            '--section-fruit-left': `${piece.left}%`,
            '--section-fruit-delay': `${piece.delay}s`,
            '--section-fruit-duration': `${piece.duration}s`,
            '--section-fruit-size': `${piece.size}rem`,
            '--section-fruit-drift': `${piece.drift}px`,
            '--section-fruit-top': `${piece.top}%`,
            '--section-fruit-sway': `${piece.sway}px`,
            '--section-fruit-rotate': `${piece.rotate}deg`,
            '--section-fruit-opacity': piece.opacity,
          }}
        >
          {piece.fruit}
        </span>
      ))}
    </div>
  )
}

const DEFAULT_REVIEWS = [
  { id:'d1', customer_name:'Marta',  text:'Llegó en 18 min, fresquísimo. El de fresa sin lactosa es otro nivel.', rating:5 },
  { id:'d2', customer_name:'Laura',  text:'Pedí por Instagram y me lo trajeron a casa. Sabor artesanal de verdad.', rating:5 },
  { id:'d3', customer_name:'Javier', text:'Sin local y mejor que muchos con tienda. Club CarmoCream 👌', rating:5 },
]

export default function Menu() {
  const { settings } = useSettings()
  const { products, combos, toppingCategories, loading } = useMenuData()
  const { isOpen } = useStoreStatus(settings)

 /*  Reseñas reales  */
  const [reviews, setReviews] = useState(DEFAULT_REVIEWS)
  useEffect(() => {
    fetchReviews({ approved: true, limit: 6 })
      .then(data => {
        if (data.length > 0) setReviews(data)
      })
      .catch(() => {})
  }, [])

 /*  Club CarmoCream  */
  const [customerPhone, setCustomerPhone] = useState(
    () => { try { return JSON.parse(localStorage.getItem('carmocream_customer') || '{}').phone || null } catch { return null } }
  )
  const loyalty = useLoyalty({ phone: customerPhone })

 /*  Carrito  */
  const { cart, cartCount, cartTotal, addToCart, updateQty, removeItem, updateItem, clearCart, comboReachedLimit } = useCart()

  const [selectedProduct, setSelectedProduct] = useState(null)
  const [selectedCombo,   setSelectedCombo]   = useState(null)
  const [showCart,        setShowCart]        = useState(false)
  const [confirmedOrder,  setConfirmedOrder]  = useState(null)
  const [activeCategory,  setActiveCategory]  = useState('combos')
  const [clubPanelOpen,   setClubPanelOpen]   = useState(false)
  const [savedCustomer,   setSavedCustomer]   = useState(() => {
    try { const v = localStorage.getItem('carmocream_customer'); return v ? JSON.parse(v) : null } catch { return null }
  })
  const sectionRefs = useRef({})
  const manualCategoryNavigationUntilRef = useRef(0)
  const cartBackdropCloseArmedRef = useRef(false)

  /* Deep-link de resena: se abre cuando el cliente llega desde ?review=NUMERO_PEDIDO */
  const [reviewOrderNum, setReviewOrderNum] = useState(null)
  const [reviewRating,   setReviewRating]   = useState(0)
  const [reviewText,     setReviewText]     = useState('')
  const [reviewSent,     setReviewSent]     = useState(false)
  const [reviewSending,  setReviewSending]  = useState(false)
  const [reviewCoupon,   setReviewCoupon]   = useState(null)
  const [reviewError,    setReviewError]    = useState('')

  useEffect(() => {
    flushScheduledReviewRequests().catch(() => {})
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const rev = params.get('review')
    if (rev) {
      setReviewOrderNum(rev)
      // Limpiar el parámetro de la URL sin recargar
      const url = new URL(window.location.href)
      url.searchParams.delete('review')
      window.history.replaceState({}, '', url.toString())
    }
  }, [])

  async function submitReviewFromLink() {
    if (reviewRating === 0) return
    setReviewSending(true)
    setReviewError('')
    try {
      const { orderNumber: normalizedOrderNum, isNew } = await saveReviewFromOrderLink({
        orderNumber: reviewOrderNum,
        rating: reviewRating,
        text: reviewText,
        customerName: savedCustomer?.name || 'Cliente',
        customerPhone: savedCustomer?.phone || null,
      })

      // Cupón: solo en review nueva. En actualizaciones devuelve el cupón ya emitido si existe.
      try {
        if (isNew) {
          const coupon = await createReviewRewardCoupon(normalizedOrderNum)
          if (coupon) setReviewCoupon(coupon)
        } else {
          // Intentar recuperar cupón existente para este pedido
          const { data } = await supabase
            .from('coupons')
            .select('code')
            .eq('description', `Review reward #${normalizedOrderNum}`)
            .maybeSingle()
          if (data?.code) setReviewCoupon(data.code)
        }
      } catch {
        setReviewCoupon(null)
      }

      setReviewSent(true)
      // Recargar reseñas aprobadas por si hay nuevas
      fetchReviews({ approved: true, limit: 6 }).then(data => { if (data.length > 0) setReviews(data) }).catch(() => {})
    } catch (error) {
      setReviewError(error?.message || 'No pudimos guardar tu rese\u00f1a. Int\u00e9ntalo de nuevo en unos segundos.')
    }
    setReviewSending(false)
  }

  /* Lock scroll cuando hay sheet abierta */
  useEffect(() => {
    const open = Boolean(showCart || selectedProduct || selectedCombo || confirmedOrder)
    if (!open) return
    const y = window.scrollY
    Object.assign(document.body.style, { position:'fixed', top:`-${y}px`, left:'0', right:'0', width:'100%' })
    return () => {
      Object.assign(document.body.style, { position:'', top:'', left:'', right:'', width:'' })
      window.scrollTo(0, y)
    }
  }, [confirmedOrder, selectedCombo, selectedProduct, showCart])

  /* Categorías agrupadas */
  const visibleProducts = useMemo(
    () => products.filter(product => canAccessClubItem(product, loyalty)),
    [products, loyalty.currentLevel, loyalty.levels]
  )

  const visibleCombos = useMemo(
    () => combos.filter(combo => canAccessClubItem(combo, loyalty)),
    [combos, loyalty.currentLevel, loyalty.levels]
  )

  const clubUnlocks = useMemo(
    () => buildClubUnlocks({
      currentLevel: loyalty.currentLevel,
      levels: loyalty.levels,
      products,
      combos,
      maxItems: 6,
    }),
    [loyalty.currentLevel, loyalty.levels, products, combos]
  )

  const productCategories = useMemo(() => {
    const grouped = {}
    visibleProducts.forEach(product => {
      const categoryId = normalizeCategoryId(product?.category)
      if (!grouped[categoryId]) grouped[categoryId] = []
      grouped[categoryId].push(product)
    })
    return grouped
  }, [visibleProducts])

  const orderedProductCategoryIds = useMemo(() => {
    return Object.keys(productCategories).sort((categoryA, categoryB) => {
      const indexA = CATEGORY_SORT_ORDER.indexOf(categoryA)
      const indexB = CATEGORY_SORT_ORDER.indexOf(categoryB)

      if (indexA === -1 && indexB === -1) return categoryA.localeCompare(categoryB)
      if (indexA === -1) return 1
      if (indexB === -1) return -1
      return indexA - indexB
    })
  }, [productCategories])

  const navigationCategories = useMemo(() => {
    const items = []
    if (visibleCombos.length > 0) items.push({ id:'combos', label:'COMBOS', icon:CATEGORY_ICONS.combos })
    orderedProductCategoryIds.forEach(categoryId => {
      items.push({ id:categoryId, label:resolveCategoryLabel(categoryId), icon:CATEGORY_ICONS[categoryId] || '🍦' })
    })
    items.push({ id:REVIEW_CATEGORY_ID, label:resolveCategoryLabel(REVIEW_CATEGORY_ID), icon:CATEGORY_ICONS.reviews })
    return items
  }, [orderedProductCategoryIds, visibleCombos.length])

  useEffect(() => {
    if (!navigationCategories.find(i => i.id === activeCategory))
      setActiveCategory(navigationCategories[0]?.id || DEFAULT_CATEGORY_ID)
  }, [activeCategory, navigationCategories])

  useEffect(() => {
    const validIds = new Set(navigationCategories.map(category => category.id))
    Object.keys(sectionRefs.current).forEach(id => {
      if (!validIds.has(id)) delete sectionRefs.current[id]
    })
  }, [navigationCategories])

 /* IntersectionObserver activa tab del nav al hacer scroll por la página */
  useEffect(() => {
    if (!navigationCategories.length || loading) return
    const obs = new IntersectionObserver(
      entries => {
        if (Date.now() < manualCategoryNavigationUntilRef.current) return
        const visible = entries.filter(e => e.isIntersecting)
        if (!visible.length) return
        // El primero visible desde arriba gana
        const topEntry = visible.reduce((a, b) =>
          a.boundingClientRect.top < b.boundingClientRect.top ? a : b
        )
        const id = topEntry.target.dataset.categoryId
        if (id) setActiveCategory(id)
      },
      { rootMargin: '-20% 0px -55% 0px', threshold: 0 }
    )
    const refs = sectionRefs.current
    Object.entries(refs).forEach(([id, el]) => {
      if (el) { el.dataset.categoryId = id; obs.observe(el) }
    })
    return () => obs.disconnect()
  }, [loading, navigationCategories])

 /* Handlers  */
  function handleProductAdd(item) {
    if (selectedProduct?._editIndex !== undefined) { updateItem(selectedProduct._editIndex, item); setShowCart(true) }
    else { addToCart(item); if (selectedProduct?._fromCart) setShowCart(true) }
    setSelectedProduct(null)
  }
  function handleComboAdd(item) {
    if (selectedCombo?._editIndex !== undefined) { updateItem(selectedCombo._editIndex, item); setShowCart(true) }
    else { addToCart(item); if (selectedCombo?._fromCart) setShowCart(true) }
    setSelectedCombo(null)
  }
  function handleConfirmed(payload) {
    const loyaltySnapshot = buildProjectedLoyaltySnapshot(loyalty)
    setConfirmedOrder({ ...payload, loyaltySnapshot }); setShowCart(false); clearCart()
    loyalty.trackOrder(payload.total, savedCustomer?.phone || customerPhone)
  }
  function handleCustomerSaved(data) {
    try { localStorage.setItem('carmocream_customer', JSON.stringify(data)) } catch {}
    setSavedCustomer(data)
    if (data?.phone) { setCustomerPhone(data.phone); loyalty.linkPhone(data.phone) }
  }
  function armCartBackdropClose(event) {
    cartBackdropCloseArmedRef.current = event.target === event.currentTarget
  }
  function maybeCloseCartFromBackdrop(event) {
    const shouldClose = cartBackdropCloseArmedRef.current && event.target === event.currentTarget
    cartBackdropCloseArmedRef.current = false
    if (shouldClose) setShowCart(false)
  }
  function resetCartBackdropClose() {
    cartBackdropCloseArmedRef.current = false
  }
  function handleEditCartItem(index, item) {
    setShowCart(false)
    if (item.isCombo) {
      const combo = combos.find(c => c.id === item.comboId) || { id:item.comboId, name:item.product_name, combo_slots:[], max_items:item.combo_items?.length||2, price:item.price, emoji:item.emoji, image_url:item.image_url }
      setSelectedCombo({ ...combo, _editIndex:index, _editItem:item }); return
    }
    const product = products.find(p => p.id === item.id) || { id:item.id, name:item.product_name, price:item.price, emoji:item.emoji, image_url:item.image_url, price_medium:item.price_medium??null, price_large:item.price_large??null, discount_percent:0 }
    setSelectedProduct({ ...product, _editIndex:index, _editItem:item })
  }

  useEffect(() => {
    if (!showCart) return
    const onKeyDown = event => {
      if (event.key === 'Escape') setShowCart(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showCart])

  // En Instagram usamos 4 frutas ligeras en vez de 12 para no saturar el WebView
  const fruitItems = useMemo(() => IS_INSTAGRAM ? [
    { emoji: '\u{1F353}', left: '8%',  size: '1.6rem', duration: '18s', delay: '-3s',  drift: '-14px' },
    { emoji: '\u{1F34D}', left: '36%', size: '1.8rem', duration: '22s', delay: '-11s', drift: '18px'  },
    { emoji: '\u{1F352}', left: '62%', size: '1.6rem', duration: '20s', delay: '-7s',  drift: '-12px' },
    { emoji: '\u{1F96D}', left: '88%', size: '1.5rem', duration: '24s', delay: '-15s', drift: '14px'  },
  ] : [
    { emoji: '\u{1F353}', left: '3%',  size: '1.7rem', duration: '14s', delay: '-2s',  drift: '-18px' },
    { emoji: '\u{1F34D}', left: '10%', size: '2rem',   duration: '18s', delay: '-9s',  drift: '22px'  },
    { emoji: '\u{1F352}', left: '18%', size: '1.5rem', duration: '15s', delay: '-5s',  drift: '-12px' },
    { emoji: '\u{1F96D}', left: '27%', size: '2.2rem', duration: '20s', delay: '-11s', drift: '28px'  },
    { emoji: '\u{1F34B}', left: '35%', size: '1.8rem', duration: '16s', delay: '-4s',  drift: '-20px' },
    { emoji: '\u{1F34A}', left: '44%', size: '2.3rem', duration: '19s', delay: '-14s', drift: '18px'  },
    { emoji: '\u{1F366}', left: '53%', size: '1.9rem', duration: '17s', delay: '-7s',  drift: '-24px' },
    { emoji: '\u{1F334}', left: '61%', size: '1.75rem',duration: '13s', delay: '-6s',  drift: '14px'  },
    { emoji: '\u{1F95D}', left: '69%', size: '2.1rem', duration: '21s', delay: '-16s', drift: '-16px' },
    { emoji: '\u{1F352}', left: '78%', size: '2.25rem',duration: '18s', delay: '-10s', drift: '24px'  },
    { emoji: '\u{1F381}', left: '86%', size: '1.85rem',duration: '15s', delay: '-12s', drift: '-10px' },
    { emoji: '\u2728',    left: '94%', size: '1.65rem',duration: '12s', delay: '-8s',  drift: '16px'  },
  ], [])

  const minimumOrder     = parseFloat(settings.min_order    || '0') || 0
  const deliveryFee      = parseFloat(settings.delivery_fee || '0') || 0
  const businessName     = settings.business_name || 'CarmoCream'
  const tagline          = settings.tagline || 'Postres artesanales \u00B7 Carmona'
  const storeMessage     = String(settings.store_message || '').trim()
  const emergencyMessage = String(settings.emergency_msg || '').trim()
  const reviewPublicLimit = Math.max(1, Number(settings.review_public_limit || '3') || 3)
  const reviewRewardPercent = Math.max(0, Number(settings.review_reward_percent || '10') || 10)
  const heroTheme = deriveHeroTheme(loyalty.currentLevel?.color || null)
  const promoEnabled = settings.ad_enabled === 'true' && Boolean(settings.ad_text || settings.ad_cta || settings.ad_url)
  const promoImage   = settings.ad_image || null
  const promoHref = settings.ad_url || '/afiliado'
  const promoText = settings.ad_text || 'Solicita ser afiliado y convierte tu codigo en un ingreso extra.'
  const promoCta = settings.ad_cta || 'Quiero ser afiliado'
  const promoTag = settings.ad_type === 'banner' ? 'Aviso rapido' : 'Novedad activa'

  return (
    <div className={styles.page}>

      {/* Lluvia de frutas de fondo */}
      <div className={styles.fruitCanvas} aria-hidden="true">
        {fruitItems.map((fruit, i) => (
          <span
            key={`${fruit.emoji}-${i}`}
            className={styles.fruit}
            style={{
              '--fruit-left': fruit.left,
              '--fruit-size': fruit.size,
              '--fruit-duration': fruit.duration,
              '--fruit-delay': fruit.delay,
              '--fruit-drift': fruit.drift,
            }}
          >
            {fruit.emoji}
          </span>
        ))}
      </div>

 {/*  POST-ORDER SCREEN  */}
      {confirmedOrder && (
        <PostOrderScreen order={confirmedOrder} savedCustomer={savedCustomer}
          loyalty={confirmedOrder.loyaltySnapshot || loyalty} onClose={() => setConfirmedOrder(null)} />
      )}

 {/* 
          HEADER / HERO
      {/* ══════════════════════════════════════════ */}
      <header className={styles.hero} style={{ '--hero-base': heroTheme.base }}>
        {(emergencyMessage || storeMessage) && (
          <div className={styles.heroAlerts}>
            {emergencyMessage && (
              <div className={`${styles.heroAlert} ${styles.heroAlertEmergency}`}>
                {emergencyMessage}
              </div>
            )}
            {storeMessage && (
              <div className={`${styles.heroAlert} ${styles.heroAlertStore}`}>
                {storeMessage}
              </div>
            )}
          </div>
        )}
        <div className={styles.heroTop}>
          <img src="/logo.png" alt={businessName} className={styles.heroLogo}
            onError={e => { e.currentTarget.style.display='none'; e.currentTarget.nextSibling.style.display='flex' }} />
          <div className={styles.heroLogoFallback} style={{ display:'none' }}>CC</div>

          <div className={styles.heroInfo}>
            <h1 className={styles.heroBusinessName}>{businessName}</h1>
            <p className={styles.heroTagline}>{tagline}</p>
          </div>

          <div className={styles.heroActionRow}>
            <span className={`${styles.heroStatusBadge} ${isOpen ? styles.heroStatusOpen : styles.heroStatusClosed}`}>
              {isOpen ? '● Abierto' : '● Cerrado'}
            </span>
            <LoyaltyWidget phone={savedCustomer?.phone || customerPhone}
              open={clubPanelOpen} onClose={() => setClubPanelOpen(false)} loyalty={loyalty}
              clubUnlocks={clubUnlocks} />
            <a href="https://www.instagram.com/carmocream_" target="_blank" rel="noopener noreferrer" className={styles.heroSocialPill}>
              IG @carmocream_
            </a>
          </div>
        </div>

        <div className={styles.heroMeta}>
          <div className={styles.metricBox}>
            <strong className={styles.metricValue}>100%</strong>
            <span className={styles.metricLabel}>Sin lactosa</span>
          </div>
          <div className={styles.metricBox}>
            <strong className={styles.metricValue}>0</strong>
            <span className={styles.metricLabel}>Conservantes</span>
          </div>
          <div className={styles.metricBox}>
            <strong className={styles.metricValue}>🛵</strong>
            <span className={styles.metricLabel}>Delivery</span>
          </div>
          <div className={styles.metricBox}>
            <strong className={styles.metricValue}>⚡</strong>
            <span className={styles.metricLabel}>Al momento</span>
          </div>
        </div>

        <div className={styles.heroRibbon}>
          <span>Carmona · Sevilla</span>
          <span className={styles.ribbonDot} />
          <span>Recién preparado</span>
        </div>

      </header>

 {/* 
          CONTENIDO PRINCIPAL
      {/* ══════════════════════════════════════════ */}
      <main className={styles.main}>

        {promoEnabled && (
          <section className={styles.promoPanel} style={{ '--promo-color': settings.ad_color || '#E8607A' }}>
            {promoImage && (
              <img
                src={promoImage}
                alt=""
                className={styles.promoImage}
                onError={e => { e.currentTarget.style.display = 'none' }}
              />
            )}
            <p className={styles.promoKicker}>{promoTag}</p>
            <h2 className={styles.promoTitle}>{promoText}</h2>
            <div className={styles.promoActions}>
              <span className={styles.promoTag}>Menu vivo - novedades - afiliados</span>
              <a href={promoHref} className={styles.promoButton} target={promoHref.startsWith('http') ? '_blank' : undefined} rel={promoHref.startsWith('http') ? 'noopener noreferrer' : undefined}>
                {promoCta}
              </a>
            </div>
          </section>
        )}



        {/* SECCION COMBOS */}
        {visibleCombos.length > 0 && (
          <section ref={el => { sectionRefs.current.combos = el }} className={styles.sectionShell}>
            <SectionFruitRain type="combos" />
            <div className={styles.section}>
              <div className={styles.sectionHead}>
                <div className={styles.sectionHeadLeft}>
                  <span className={styles.sectionKicker}>{CATEGORY_ICONS.combos}</span>
                  <h2 className={styles.sectionTitle}>Combos</h2>
                </div>
                <span className={`${styles.sectionTypeBadge} ${styles.sectionTypeBadgeCombo}`}>
                  {visibleCombos.length} combos
                </span>
              </div>
            <div className={styles.grid}>
              {visibleCombos.map(combo => (
                <ComboAccessCard key={combo.id} combo={combo} isStoreOpen={isOpen}
                  clubAccess={buildClubAccessMeta(combo, loyalty.currentLevel, loyalty.levels)}
                  isLimitReached={comboReachedLimit(combo) || combo.has_reached_daily_limit} onOpen={setSelectedCombo} />
              ))}
            </div>
            </div>
          </section>
        )}

 {/*  SECCIONES DE PRODUCTOS  */}
        {loading ? (
          <section className={styles.section}>
            <div className={styles.grid}>
              {Array.from({ length: 6 }, (_, i) => <div key={i} className={styles.skeletonCard} />)}
            </div>
          </section>
        ) : (
          orderedProductCategoryIds.map(cat => {
            const prods = productCategories[cat] || []
            return (
            <section key={cat} ref={el => { sectionRefs.current[cat] = el }} className={styles.sectionShell}>
              <SectionFruitRain type="products" />
              <div className={styles.section}>
                <div className={styles.sectionHead}>
                  <div className={styles.sectionHeadLeft}>
                    <span className={styles.sectionKicker}>{CATEGORY_ICONS[cat] || '\u{1F370}'}</span>
                    <h2 className={styles.sectionTitle}>{resolveCategoryLabel(cat)}</h2>
                  </div>
                  <span className={`${styles.sectionTypeBadge} ${styles.sectionTypeBadgeProduct}`}>
                    {prods.length} {prods.length === 1 ? 'plato' : 'platos'}
                  </span>
                </div>
                <div className={styles.grid}>
                  {prods.map(product => (
                    <ProductAccessCard key={product.id} product={product}
                      clubAccess={buildClubAccessMeta(product, loyalty.currentLevel, loyalty.levels)}
                      isStoreOpen={isOpen} onAdd={setSelectedProduct} />
                  ))}
                </div>
              </div>
            </section>
            )
          })
        )}

 {/*  RESEÑAS  debajo de los productos  */}
        <section ref={el => { sectionRefs.current[REVIEW_CATEGORY_ID] = el }} className={styles.reviewsSection}>
          <SectionFruitRain type="reviews" />
          <div className={styles.reviewsHeading}>
            <p className={styles.reviewsKicker}>Lo que dicen nuestros clientes</p>
            <h2 className={styles.reviewsTitle}>De nuestro taller a tu mesa</h2>
          </div>
          <div className={styles.reviewsGrid}>
            {reviews.slice(0, reviewPublicLimit).map(r => (
              <div key={r.id} className={styles.reviewCard}>
                <div className={styles.reviewCardHeader}>
                  <div className={styles.reviewAvatar}>{(r.customer_name||'C')[0].toUpperCase()}</div>
                  <div>
                    <p className={styles.reviewName}>{r.customer_name || 'Cliente'}</p>
                    <span className={styles.reviewStars}>{String.fromCharCode(9733).repeat(r.rating || 5)}</span>
                  </div>
                </div>
                <p className={styles.reviewText}>{r.text}</p>
                <span className={styles.reviewMeta}>Carmona - Cliente verificado</span>
              </div>
            ))}
          </div>
        </section>

      </main>

 {/* 
          PIE DE PÁGINA
      {/* ══════════════════════════════════════════ */}
      <footer className={styles.footer}>
        <img src="/logo.png" alt={businessName} className={styles.footerLogo}
          onError={e => { e.currentTarget.style.display='none'; e.currentTarget.nextSibling.style.display='flex' }} />
        <div className={styles.footerLogoFallback} style={{ display:'none' }}>🍦</div>

        <p className={styles.footerName}>{businessName}</p>

        <div className={styles.footerLinks}>
          <a href="https://www.instagram.com/carmocream_" target="_blank" rel="noopener noreferrer"
            className={styles.footerLink}>
            📸 @carmocream_
          </a>
          <span className={styles.footerDivider} />
          <a href={`https://wa.me/${(settings.whatsapp||'34600000000').replace(/\D/g,'')}`}
            target="_blank" rel="noopener noreferrer" className={styles.footerLink}>
            💬 WhatsApp
          </a>
          <span className={styles.footerDivider} />
          <span className={styles.footerLink}>📍 Carmona</span>
        </div>

        <p className={styles.footerCopy}>
          © {new Date().getFullYear()} CarmoCream · Hecho con ❤️ en Carmona, Sevilla
        </p>
      </footer>

 {/* 
          BOTTOM NAV
      {/* ══════════════════════════════════════════ */}
      <nav className={styles.bottomNav} aria-label="Navegación principal">
        <button type="button" className={styles.bottomNavItem}
          onClick={() => window.scrollTo({ top:0, behavior:'smooth' })} aria-label="Menú">
          <span className={styles.bottomNavIcon}>🏠</span>
          <span className={styles.bottomNavLabel}>Menu</span>
        </button>
        <button type="button" className={styles.bottomNavItem}
          onClick={() => setShowCart(true)} aria-label={`Carrito ${cartCount}`}>
          <span className={styles.bottomNavIcon}>🛒</span>
          <span className={styles.bottomNavLabel}>Carrito</span>
          {cartCount > 0 && <span className={styles.bottomNavBadge}>{cartCount}</span>}
        </button>
        <button type="button" className={styles.bottomNavItem}
          onClick={() => { window.scrollTo({top:0,behavior:'smooth'}); setClubPanelOpen(true) }}
          aria-label="Club CarmoCream">
          <span className={styles.bottomNavIcon}>⭐</span>
          <span className={styles.bottomNavLabel}>Club</span>
        </button>
      </nav>

 {/* FAB carrito  ELIMINADO */}
      {false && <button type="button"
        className={`${styles.cartTrigger} ${cartCount > 0 ? styles.cartTriggerVisible : ''}`}
        onClick={() => setShowCart(true)} aria-label={`Ver carrito ${cartCount}`}>
        <span>🛒 Ver pedido · €{cartTotal.toFixed(2)}</span>
        <strong aria-hidden="true">{cartCount}</strong>
      </button>}

 {/* 
          CART SHEET
      {/* ══════════════════════════════════════════ */}
      {showCart && (
        <div className={styles.cartOverlay}
          onPointerDown={armCartBackdropClose}
          onPointerUp={maybeCloseCartFromBackdrop}
          onPointerCancel={resetCartBackdropClose}>
          <div className={styles.cartSheet}>
            <div className={styles.cartSheetHead}>
              <h2 className={styles.cartSheetTitle}>Tu pedido</h2>
              <button type="button" className={styles.cartSheetClose}
                onClick={() => setShowCart(false)} aria-label="Cerrar carrito">Cerrar</button>
            </div>
            <div style={{flex:1, minHeight:0, overflowY:'auto', overflowX:'hidden', WebkitOverflowScrolling:'touch', overscrollBehavior:'contain', display:'flex', flexDirection:'column'}}>
            <Cart items={cart} onUpdateQty={updateQty} onRemove={removeItem}
              onClear={() => { clearCart(); setShowCart(false) }}
              isOpen={isOpen} onConfirmed={handleConfirmed} onEditItem={handleEditCartItem}
              savedCustomer={savedCustomer} onCustomerSaved={handleCustomerSaved}
              minOrder={minimumOrder} deliveryFee={deliveryFee}
              products={visibleProducts} combos={visibleCombos}
              catalogProducts={products} catalogCombos={combos}
              onRequestProduct={(item, isCombo) => {
                setShowCart(false)
                if (isCombo) setSelectedCombo({ ...item, _fromCart: true })
                else setSelectedProduct({ ...item, _fromCart: true })
              }}
              loyaltyDiscount={loyalty.discountPercent}
              loyaltyLevel={loyalty.currentLevel}
              loyaltyOrderCount={loyalty.orderCount} />
            </div>{/* fin scroll wrapper */}
          </div>
        </div>
      )}

      {/* MODALES */}
      {selectedProduct && (() => {
        const catIds      = Array.isArray(selectedProduct.topping_category_ids) ? selectedProduct.topping_category_ids : []
        const allowedIds  = Array.isArray(selectedProduct.allowed_topping_ids)  ? selectedProduct.allowed_topping_ids  : []
        const filteredCats = catIds.length > 0
          ? toppingCategories
              .filter(c => catIds.includes(c.id))
              .map(c => ({ ...c, toppings: (c.toppings||[]).filter(t => allowedIds.length===0 || allowedIds.includes(t.id)) }))
              .filter(c => c.toppings.length > 0)
          : []
        return (
          <ProductModal product={selectedProduct} categories={filteredCats}
            loyaltyLevel={loyalty.currentLevel}
            onAdd={handleProductAdd}
            onClose={() => {
              if (selectedProduct._editIndex !== undefined || selectedProduct._fromCart) setShowCart(true)
              setSelectedProduct(null)
            }}
            editMode={selectedProduct._editIndex !== undefined}
            initialItem={selectedProduct._editItem} />
        )
      })()}

      {selectedCombo && (
        <ComboModal combo={selectedCombo} products={visibleProducts} categories={toppingCategories}
          loyaltyLevel={loyalty.currentLevel}
          onAdd={handleComboAdd}
          onClose={() => {
            if (selectedCombo._editIndex !== undefined || selectedCombo._fromCart) setShowCart(true)
            setSelectedCombo(null)
          }}
          editMode={selectedCombo._editIndex !== undefined}
          initialItem={selectedCombo._editItem}
          hideExtraPrices={true} />
      )}

      {/* Modal de resena postpedido */}



      {reviewOrderNum && !reviewSent && (
        <div style={{
          position:'fixed', inset:0, zIndex:9500,
          background:'rgba(0,0,0,0.70)', backdropFilter:'blur(8px)', WebkitBackdropFilter:'blur(8px)',
          display:'flex', alignItems:'flex-end', justifyContent:'center',
        }} onClick={e => e.target === e.currentTarget && setReviewOrderNum(null)}>
          <div style={{
            width:'100%', maxWidth:480,
            background:'#FFFBF5', borderRadius:'24px 24px 0 0',
            borderTop:'3px solid #E8607A',
            padding:'0 0 calc(24px + env(safe-area-inset-bottom,0px))',
            animation:'revSlideUp .35s cubic-bezier(0.16,1,0.3,1)',
            fontFamily:"'Nunito',sans-serif",
          }}>
            <style>{`@keyframes revSlideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>

            {/* Handle */}
            <div style={{width:40,height:4,borderRadius:50,background:'rgba(0,0,0,.12)',margin:'10px auto 0'}} />

            <div style={{padding:'20px 20px 0'}}>
              {/* Encabezado */}
              <div style={{textAlign:'center', marginBottom:20}}>
                <div style={{fontSize:'2.8rem', marginBottom:8}}>{'\u2B50'}</div>
                <div style={{
                  display:'inline-block', background:'#E8607A', color:'white',
                  padding:'3px 14px', borderRadius:50,
                  fontSize:'0.60rem', fontWeight:900, letterSpacing:'0.12em', marginBottom:10,
                }}>PEDIDO #{reviewOrderNum}</div>
                <h2 style={{fontSize:'1.35rem', fontWeight:900, color:'#1C3829', margin:'0 0 6px', lineHeight:1.2}}>
                  {'\u00bfC\u00f3mo estuvo tu CarmoCream?'}
                </h2>
                <p style={{color:'#6B7280', fontSize:'0.80rem', margin:0, lineHeight:1.5}}>
                  {'Tu opini\u00f3n nos ayuda a mejorar y llegar a m\u00e1s personas'}
                </p>
              </div>

              {/* Estrellas */}
              <div style={{
                background:'#FFF3E4', border:'1.5px solid #FFD9B3',
                borderRadius:20, padding:'18px 16px', marginBottom:14,
              }}>
                <p style={{fontSize:'0.70rem', fontWeight:900, color:'#E8607A', letterSpacing:'.10em', margin:'0 0 12px', textAlign:'center'}}>
                  VALORA TU EXPERIENCIA
                </p>
                <div style={{display:'flex', gap:10, justifyContent:'center', marginBottom:14}}>
                  {[1,2,3,4,5].map(s => (
                    <button key={s} onClick={() => setReviewRating(s)} style={{
                      fontSize:'2.2rem', background:'none', border:'none', cursor:'pointer',
                      opacity: s <= reviewRating ? 1 : 0.25,
                      transform: s <= reviewRating ? 'scale(1.15)' : 'scale(1)',
                      transition:'all .15s', padding:0,
                    }}>{String.fromCharCode(9733)}</button>
                  ))}
                </div>

                {reviewRating > 0 && (
                  <>
                    <p style={{fontSize:'0.72rem', fontWeight:700, color:'#6B7280', margin:'0 0 8px', textAlign:'center'}}>
                      {reviewRating === 5 ? 'Perfecto. Cu\u00e9ntanos m\u00e1s (opcional)' :
                       reviewRating >= 3 ? 'Cu\u00e9ntanos qu\u00e9 podemos mejorar (opcional)' :
                       '\u00bfQu\u00e9 fall\u00f3? Tu feedback es muy valioso'}
                    </p>
                    <textarea
                      value={reviewText}
                      onChange={e => setReviewText(e.target.value)}
                      placeholder="Escribe aqu\u00ed tu comentario..."
                      rows={3}
                      style={{
                        width:'100%', boxSizing:'border-box',
                        padding:'10px 12px', borderRadius:12,
                        border:'1.5px solid #FFD9B3', background:'white',
                        fontSize:'16px', fontFamily:"'Nunito',sans-serif",
                        color:'#1C3829', outline:'none', resize:'none',
                      }}
                    />
                  </>
                )}
              </div>

              {reviewError && (
                <div style={{
                  marginBottom: 12, padding: '10px 12px', borderRadius: 12,
                  background: '#FFF1F2', border: '1.5px solid #F4A7B9',
                  color: '#9F1239', fontSize: '0.76rem', fontWeight: 800, lineHeight: 1.45,
                  display: 'flex', gap: 8, alignItems: 'flex-start',
                }}>
                  <span style={{ flexShrink: 0 }}>Aviso</span>
                  <div style={{ flex: 1 }}>
                    {reviewError}
                    <button
                      onClick={() => { setReviewError(''); submitReviewFromLink() }}
                      style={{
                        display: 'block', marginTop: 6, background: 'none', border: 'none',
                        color: '#9F1239', fontWeight: 900, fontSize: '0.72rem',
                        cursor: 'pointer', padding: 0, textDecoration: 'underline',
                        fontFamily: "'Nunito',sans-serif",
                      }}
                    >
                      Reintentar env\u00edo
                    </button>
                  </div>
                </div>
              )}

              {/* Botones */}
              <button
                onClick={submitReviewFromLink}
                disabled={reviewRating === 0 || reviewSending}
                style={{
                  width:'100%', padding:'15px', borderRadius:14,
                  background: reviewRating > 0 ? '#E8607A' : '#E5E7EB',
                  color: reviewRating > 0 ? 'white' : '#9CA3AF',
                  border:'none', fontWeight:900, fontSize:'0.92rem',
                  cursor: reviewRating > 0 ? 'pointer' : 'not-allowed',
                  fontFamily:"'Nunito',sans-serif",
                  marginBottom:10, transition:'background .2s',
                }}>
                {reviewSending ? 'Enviando...' : reviewRating === 0 ? 'Selecciona una valoraci\u00f3n' : 'Enviar rese\u00f1a'}
              </button>
              <button
                onClick={() => setReviewOrderNum(null)}
                style={{
                  width:'100%', padding:'13px', borderRadius:14,
                  background:'transparent', color:'#9CA3AF',
                  border:'1.5px solid #E5E7EB', fontWeight:700,
                  fontSize:'0.84rem', cursor:'pointer',
                  fontFamily:"'Nunito',sans-serif",
                }}>
                Ahora no
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmacion resena enviada */}
      {reviewSent && reviewOrderNum && (
        <div style={{
          position:'fixed', inset:0, zIndex:9500,
          background:'rgba(0,0,0,0.60)', backdropFilter:'blur(6px)', WebkitBackdropFilter:'blur(6px)',
          display:'flex', alignItems:'center', justifyContent:'center', padding:20,
        }} onClick={() => { setReviewSent(false); setReviewOrderNum(null) }}>
          <div style={{
            background:'#FFFBF5', borderRadius:24, padding:'32px 24px',
            maxWidth:360, width:'100%', textAlign:'center',
            border:'3px solid #E8607A',
            animation:'revSlideUp .35s cubic-bezier(0.16,1,0.3,1)',
          }}>
            <div style={{fontSize:'3rem', marginBottom:12}}>OK</div>
            <h2 style={{fontSize:'1.4rem', fontWeight:900, color:'#1C3829', margin:'0 0 8px'}}>
              Gracias por tu resena
            </h2>
            <p style={{color:'#6B7280', fontSize:'0.84rem', margin:'0 0 20px', lineHeight:1.5}}>
              Tu opinion nos ayuda a mejorar CarmoCream cada dia
            </p>
            {reviewCoupon && (
              <div style={{
                background:'#FFF3E4',
                border:'2px solid #FFD9B3',
                borderRadius:16,
                padding:'14px 16px',
                margin:'0 0 18px',
              }}>
                <div style={{fontSize:'0.66rem', fontWeight:900, color:'#E8607A', letterSpacing:'.12em', marginBottom:6}}>
                  CUPON DESBLOQUEADO
                </div>
                <div style={{fontSize:'1.1rem', fontWeight:900, color:'#1C3829', marginBottom:4}}>
                  {reviewCoupon}
                </div>
                <div style={{ fontSize:'0.76rem', color:'#6B7280', lineHeight:1.45 }}>
                  {reviewRewardPercent}% de descuento para tu proximo pedido. Tu resena aparecera en el menu cuando la verifiquemos.
                </div>
              </div>
            )}
            <button
              onClick={() => { setReviewSent(false); setReviewOrderNum(null); setReviewCoupon(null) }}
              style={{
                width:'100%', padding:'14px', borderRadius:14,
                background:'#1C3829', color:'white', border:'none',
                fontWeight:900, fontSize:'0.92rem', cursor:'pointer',
                fontFamily:"'Nunito',sans-serif",
              }}>
              Volver al menu
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

