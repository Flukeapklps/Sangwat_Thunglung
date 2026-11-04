'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3, ChevronRight, CirclePlus, Download, Edit3, FileUp, ImageOff, LayoutDashboard, Minus, Package,
  PackagePlus, Plus, Search, ShoppingCart, Trash2, Upload, UserRound, X,
} from 'lucide-react'
import {
  type Cart, categoryOf, compressImage, DEFAULT_CATEGORY, formatDateTime, inPeriod, kgCost, mergeRemote, money,
  normalizeOrder, normalizeProduct, num, type Order, type OrderItem, type Period, type Product, readStorage,
  resolveImageUrl, round2, stockOf, summarize, totalStock, type Unit, unitCostOf, unitLabel, unitPrice, withStatus,
  writeStorage,
} from '@/lib/pos'
import { OrderDetailModal } from '@/components/order-detail'

const GAS_URL = 'https://script.google.com/macros/s/AKfycbwzkCcKnFFNy14eRcWJbv2aXXmiol8dK1eJg5r0pMdaKAhYbpgq6ugFoGcLX3K3qKJq/exec'
const LOGO_URL = 'https://hebbkx1anhila5yf.public.blob.vercel-storage.com/sangwat%20logo-QtbMkseg5dRbmauJvFdCVl767RO672.png'
const HIDDEN_STARTER_NAMES = new Set(['ข้าวหอมมะลิ 5 กก.', 'ข้าวขาวเสาไห้ 5 กก.', 'ข้าวเหนียวเขี้ยวงู 5 กก.', 'ข้าวกล้องหอมมะลิ 1 กก.', 'ข้าวไรซ์เบอร์รี่ 1 กก.'])

const KEYS = {
  products: 'sangwat-products',
  overrides: 'sangwat-product-overrides', // legacy – migrated into products on load
  deleted: 'sangwat-deleted-products',
  orders: 'sangwat-orders',
  seller: 'sangwat-current-seller',
}

type Tab = 'overview' | 'products' | 'orders' | 'insights'
type SyncState = 'syncing' | 'online' | 'offline'
type Detail = { order: Order; justCreated?: boolean }

const isVisible = (p: Product) => !!p.name && !HIDDEN_STARTER_NAMES.has(p.name)
const uniqueCategories = (products: Product[]) => [...new Set(products.map(categoryOf))].sort((a, b) => a.localeCompare(b, 'th'))

export default function PosApp() {
  const [hydrated, setHydrated] = useState(false)
  const [tab, setTab] = useState<Tab>('overview')
  const [products, setProducts] = useState<Product[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [deleted, setDeleted] = useState<string[]>([])
  const [cart, setCart] = useState<Cart>({})
  const [customer, setCustomer] = useState('')
  const [seller, setSeller] = useState('')
  const [modal, setModal] = useState<Product | null | false>(false)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [sync, setSync] = useState<SyncState>('syncing')
  const fileRef = useRef<HTMLInputElement>(null)
  const storageWarned = useRef(false)

  // ---- load from localStorage after mount (avoids SSR hydration mismatch), then sync Google Sheet
  useEffect(() => {
    const overrides = readStorage<Record<string, Product>>(KEYS.overrides, {})
    const stored = readStorage<any[]>(KEYS.products, [])
    const byId = new Map<string, Product>()
    for (const raw of Array.isArray(stored) ? stored : []) {
      const p = normalizeProduct(raw)
      byId.set(p.id, p)
    }
    for (const [id, raw] of Object.entries(overrides || {})) byId.set(id, { ...normalizeProduct(raw), updatedAt: Date.now() })
    const local = [...byId.values()].filter(isVisible)
    const deletedIds = readStorage<string[]>(KEYS.deleted, [])
    setProducts(local)
    setDeleted(Array.isArray(deletedIds) ? deletedIds : [])
    const storedOrders = readStorage<any[]>(KEYS.orders, [])
    setOrders((Array.isArray(storedOrders) ? storedOrders : []).map(normalizeOrder))
    setSeller(readStorage<string>(KEYS.seller, ''))
    setHydrated(true)

    let cancelled = false
    fetch(GAS_URL)
      .then((r) => r.json())
      .then((rows: any) => {
        if (cancelled || !Array.isArray(rows)) throw new Error('bad-response')
        const remote = rows.map(normalizeProduct).filter(isVisible)
        setProducts((prev) => mergeRemote(prev, remote, new Set(deletedIds)))
        setSync('online')
      })
      .catch(() => !cancelled && setSync('offline'))
    return () => { cancelled = true }
  }, [])

  // ---- persist (only after the initial load, so we never overwrite stored data with empty state)
  const persist = useCallback((key: string, value: unknown) => {
    if (!writeStorage(key, value) && !storageWarned.current) {
      storageWarned.current = true
      alert('พื้นที่จัดเก็บข้อมูลในเบราว์เซอร์เต็ม กรุณาส่งออกข้อมูลสำรอง หรือใช้รูปภาพขนาดเล็กลง / ใช้ URL รูปแทน')
    }
  }, [])
  useEffect(() => { if (hydrated) { persist(KEYS.products, products); try { localStorage.removeItem(KEYS.overrides) } catch {} } }, [products, hydrated, persist])
  useEffect(() => { if (hydrated) persist(KEYS.orders, orders) }, [orders, hydrated, persist])
  useEffect(() => { if (hydrated) persist(KEYS.deleted, deleted) }, [deleted, hydrated, persist])
  useEffect(() => { if (hydrated) persist(KEYS.seller, seller) }, [seller, hydrated, persist])

  const categories = useMemo(() => uniqueCategories(products), [products])
  const sellers = useMemo(() => [...new Set(orders.map((o) => o.seller))].filter(Boolean), [orders])
  const customers = useMemo(() => [...new Set(orders.map((o) => o.customer))].filter(Boolean), [orders])
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])

  const cartItems: OrderItem[] = useMemo(() => {
    const items: OrderItem[] = []
    for (const [id, q] of Object.entries(cart)) {
      const p = productById.get(id)
      if (!p) continue
      for (const unit of ['bag', 'kg'] as Unit[]) {
        if (q[unit] > 0) items.push({ id, name: p.name, unit, qty: q[unit], price: unitPrice(p, unit), cost: round2(unitCostOf(p, unit)) })
      }
    }
    return items
  }, [cart, productById])
  const cartTotal = cartItems.reduce((s, i) => s + i.price * i.qty, 0)

  const setQty = (p: Product, unit: Unit, value: number) =>
    setCart((c) => {
      const current = c[p.id] || { bag: 0, kg: 0 }
      const qty = Math.max(0, Math.min(stockOf(p, unit), round2(value)))
      const next = { ...current, [unit]: qty }
      const copy = { ...c }
      if (!next.bag && !next.kg) delete copy[p.id]
      else copy[p.id] = next
      return copy
    })

  const customerTotals = (name: string, list = orders) => {
    const own = list.filter((o) => o.customer === name)
    return { orders: own.length, revenue: own.reduce((s, o) => s + o.total, 0), profit: own.reduce((s, o) => s + o.profit, 0) }
  }

  const submitOrder = () => {
    const name = customer.trim()
    const by = seller.trim()
    if (!name) return alert('กรุณาระบุชื่อลูกค้า')
    if (!by) return alert('กรุณาระบุชื่อพนักงานขาย')
    if (!cartItems.length) return alert('กรุณาเลือกสินค้าอย่างน้อย 1 รายการ')
    const shortage = cartItems.find((i) => {
      const p = productById.get(i.id)
      return !p || i.qty > stockOf(p, i.unit)
    })
    if (shortage) return alert(`สต็อก "${shortage.name}" ไม่เพียงพอ`)

    const total = round2(cartItems.reduce((s, i) => s + i.price * i.qty, 0))
    const cost = round2(cartItems.reduce((s, i) => s + i.cost * i.qty, 0))
    const order: Order = { id: `POS-${Date.now()}`, customer: name, seller: by, createdAt: new Date().toISOString(), items: cartItems, total, cost, profit: round2(total - cost) }

    const nextOrders = [order, ...orders]
    setOrders(nextOrders)
    // deduct stock immediately; status flips to "out of stock" automatically when it reaches 0
    setProducts((ps) => ps.map((p) => {
      const q = cart[p.id]
      if (!q) return p
      return withStatus({ ...p, bagStock: p.bagStock - (q.bag || 0), kgStock: p.kgStock - (q.kg || 0), updatedAt: Date.now() })
    }))
    setCart({})
    setCustomer('')
    setDetail({ order, justCreated: true })
  }

  const deleteOrder = (o: Order) => {
    if (!confirm(`ลบออเดอร์ ${o.id} ของ ${o.customer} หรือไม่?`)) return
    const restock = confirm('คืนสินค้าในออเดอร์นี้กลับเข้าสต็อกด้วยหรือไม่?')
    setOrders((xs) => xs.filter((x) => x.id !== o.id))
    if (restock) {
      setProducts((ps) => ps.map((p) => {
        const items = o.items.filter((i) => i.id === p.id)
        if (!items.length) return p
        const bag = items.filter((i) => i.unit === 'bag').reduce((s, i) => s + i.qty, 0)
        const kg = items.filter((i) => i.unit === 'kg').reduce((s, i) => s + i.qty, 0)
        return withStatus({ ...p, bagStock: p.bagStock + bag, kgStock: p.kgStock + kg, updatedAt: Date.now() })
      }))
    }
    setDetail(null)
  }

  const saveProduct = (p: Product) => {
    const saved = withStatus({ ...p, category: categoryOf(p), updatedAt: Date.now() })
    setProducts((xs) => (xs.some((x) => x.id === saved.id) ? xs.map((x) => (x.id === saved.id ? saved : x)) : [saved, ...xs]))
    setDeleted((d) => d.filter((id) => id !== saved.id))
    setModal(false)
  }

  const deleteProduct = (p: Product) => {
    if (!confirm(`ลบสินค้า "${p.name}" หรือไม่?`)) return
    setProducts((xs) => xs.filter((x) => x.id !== p.id))
    setDeleted((d) => [...new Set([...d, p.id])])
    setCart((c) => { const copy = { ...c }; delete copy[p.id]; return copy })
  }

  const exportData = () => {
    const blob = new Blob([JSON.stringify({ products, orders }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sangwat-pos-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const importData = (file: File) => {
    const r = new FileReader()
    r.onload = () => {
      try {
        const d = JSON.parse(String(r.result))
        if (!Array.isArray(d.products) && !Array.isArray(d.orders)) throw new Error('invalid')
        if (Array.isArray(d.products)) setProducts(d.products.map((x: any) => ({ ...normalizeProduct(x), updatedAt: Date.now() })).filter(isVisible))
        if (Array.isArray(d.orders)) setOrders(d.orders.map(normalizeOrder))
        alert('นำเข้าข้อมูลเรียบร้อย')
      } catch {
        alert('ไฟล์สำรองไม่ถูกต้อง')
      }
    }
    r.readAsText(file)
  }

  const clearToday = () => {
    if (confirm('ล้างออเดอร์ของวันนี้ทั้งหมดหรือไม่? (สต็อกจะไม่ถูกคืน)')) setOrders((xs) => xs.filter((o) => !inPeriod(o.createdAt, 'today')))
  }

  const openOrder = (o: Order) => setDetail({ order: o })

  const titles: Record<Tab, string> = { overview: 'ภาพรวมร้านค้า', products: 'สินค้า & สต็อก', orders: 'สร้างออเดอร์', insights: 'ยอดขาย & กำไร' }
  const nav: [Tab, string, typeof LayoutDashboard][] = [
    ['overview', 'ภาพรวม', LayoutDashboard],
    ['products', 'สินค้า & สต็อก', Package],
    ['orders', 'สร้างออเดอร์', ShoppingCart],
    ['insights', 'ยอดขาย & กำไร', BarChart3],
  ]
  const syncText = sync === 'syncing' ? 'กำลังเชื่อมต่อ Google Sheet' : sync === 'online' ? 'เชื่อมต่อ Google Sheet แล้ว' : 'เชื่อมต่อ Google Sheet ไม่สำเร็จ'

  return (
    <div className="pos-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src={LOGO_URL} alt="Sangwat แสงวัฒน์ ทุ่งลุง" />
          <div><strong>Sangwat</strong><small>แสงวัฒน์ ทุ่งลุง</small></div>
        </div>
        <nav>
          {nav.map(([id, label, Icon]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)} title={label}><Icon size={19} />{label}</button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className={`connection ${sync}`}><i /> {syncText}</span>
          <button onClick={exportData}><Download size={16} /> ส่งออกข้อมูล</button>
          <button onClick={() => fileRef.current?.click()}><FileUp size={16} /> นำเข้าข้อมูล</button>
          <input ref={fileRef} hidden type="file" accept=".json,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (f) importData(f); e.target.value = '' }} />
        </div>
      </aside>
      <main className="main">
        <header>
          <div>
            <p className="eyebrow">{hydrated ? new Intl.DateTimeFormat('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date()) : ' '}</p>
            <h1>{titles[tab]}</h1>
          </div>
          <div className="header-actions">
            {seller && <span className="seller-chip"><UserRound size={13} /> {seller}</span>}
            <button className="avatar" title={seller || 'พนักงานขาย'} onClick={() => setTab('orders')}>{(seller || 'ส')[0]}</button>
          </div>
        </header>

        {!hydrated ? <p className="empty">กำลังโหลดข้อมูล...</p> : <>
          {tab === 'overview' && <Overview orders={orders} products={products} sync={sync} go={setTab} onAddProduct={() => { setTab('products'); setModal(null) }} onOpenOrder={openOrder} clearToday={clearToday} />}
          {tab === 'products' && <Products products={products} categories={categories} onAdd={() => setModal(null)} onEdit={setModal} onDelete={deleteProduct} />}
          {tab === 'orders' && <Orders products={products} categories={categories} cart={cart} cartItems={cartItems} cartTotal={cartTotal} setQty={setQty} customer={customer} setCustomer={setCustomer} seller={seller} setSeller={setSeller} sellers={sellers} customers={customers} clearCart={() => setCart({})} submit={submitOrder} />}
          {tab === 'insights' && <Insights orders={orders} onOpenOrder={openOrder} />}
        </>}
      </main>
      {modal !== false && <ProductModal value={modal || undefined} categories={categories} onClose={() => setModal(false)} onSave={saveProduct} />}
      {detail && <OrderDetailModal order={detail.order} justCreated={detail.justCreated} customerTotals={customerTotals(detail.order.customer)} onClose={() => setDetail(null)} onDelete={detail.justCreated ? undefined : deleteOrder} />}
    </div>
  )
}

// ---------------------------------------------------------------- shared bits

function Stat({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return <div className="stat-card"><div className="stat-top"><span>{label}</span><b style={{ background: accent }} /></div><strong>{value}</strong><small>{sub}</small></div>
}

function ProductImage({ src, size = 32 }: { src?: string; size?: number }) {
  const url = resolveImageUrl(src)
  const [failed, setFailed] = useState<string | null>(null)
  if (!url) return <Package size={size} />
  if (failed === url) return <ImageOff size={size} />
  return <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(url)} />
}

function CategoryTabs({ categories, value, onChange, counts }: { categories: string[]; value: string; onChange: (c: string) => void; counts: Record<string, number> }) {
  return (
    <div className="category-tabs" role="tablist">
      {['all', ...categories].map((c) => (
        <button key={c} role="tab" aria-selected={value === c} className={value === c ? 'active' : ''} onClick={() => onChange(c)}>
          {c === 'all' ? 'ทั้งหมด' : c}<span>{c === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[c] || 0}</span>
        </button>
      ))}
    </div>
  )
}

function useCategoryFilter(products: Product[], categories: string[]) {
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  // if the selected category disappears (last product deleted / renamed) fall back to "all"
  const active = category === 'all' || categories.includes(category) ? category : 'all'
  const counts = useMemo(() => products.reduce<Record<string, number>>((a, p) => { const c = categoryOf(p); a[c] = (a[c] || 0) + 1; return a }, {}), [products])
  const q = query.trim().toLowerCase()
  const filtered = products.filter((p) => (active === 'all' || categoryOf(p) === active) && (!q || `${p.name} ${p.brand || ''}`.toLowerCase().includes(q)))
  return { category: active, setCategory, query, setQuery, counts, filtered }
}

function OrderRow({ o, onOpen }: { o: Order; onOpen: (o: Order) => void }) {
  return (
    <button className="feed-item clickable" onClick={() => onOpen(o)}>
      <span className="feed-avatar">{o.customer[0]}</span>
      <span><b>{o.customer}</b><small>{o.items.length} รายการ · {o.seller} · {formatDateTime(o.createdAt)}</small></span>
      <span className="feed-amount"><strong>฿{money(o.total)}</strong><small className={o.profit >= 0 ? 'positive' : 'negative'}>กำไร ฿{money(o.profit)}</small></span>
      <ChevronRight size={16} />
    </button>
  )
}

// ---------------------------------------------------------------- overview

function Overview({ orders, products, sync, go, onAddProduct, onOpenOrder, clearToday }: {
  orders: Order[]; products: Product[]; sync: SyncState; go: (t: Tab) => void; onAddProduct: () => void; onOpenOrder: (o: Order) => void; clearToday: () => void
}) {
  const today = orders.filter((o) => inPeriod(o.createdAt, 'today'))
  const todayRevenue = today.reduce((s, o) => s + o.total, 0)
  const todayProfit = today.reduce((s, o) => s + o.profit, 0)
  const outOfStock = products.filter((p) => p.status === 'out_of_stock').length
  return <>
    <section className="hero">
      <div>
        <span className="hero-label">สรุปวันนี้</span>
        <h2>จัดการร้านให้ง่ายขึ้น<br /><em>เห็นทุกอย่างในที่เดียว</em></h2>
        <p>{sync === 'online' ? 'เชื่อมต่อ Google Sheet แล้ว ข้อมูลสินค้าจะอัปเดตอัตโนมัติ' : sync === 'syncing' ? 'กำลังโหลดข้อมูลสินค้าจาก Google Sheet...' : 'ไม่สามารถเชื่อมต่อ Google Sheet ได้ กำลังใช้ข้อมูลที่บันทึกไว้'}</p>
      </div>
      <div className="hero-art"><div className="rice">✦</div><span>STOCK<br /><b>READY</b></span></div>
    </section>
    <div className="stats">
      <Stat label="ยอดขายวันนี้" value={`฿${money(todayRevenue)}`} sub={`${today.length} ออเดอร์`} accent="#d6a84a" />
      <Stat label="กำไรวันนี้" value={`฿${money(todayProfit)}`} sub="ยอดขาย - ต้นทุน" accent="#55aa73" />
      <Stat label="ยอดขายรวม" value={`฿${money(orders.reduce((s, o) => s + o.total, 0))}`} sub={`กำไรรวม ฿${money(orders.reduce((s, o) => s + o.profit, 0))}`} accent="#e8c875" />
      <Stat label="สินค้าทั้งหมด" value={products.length.toString()} sub={outOfStock ? `สินค้าหมด ${outOfStock} รายการ` : 'มีสินค้าครบ'} accent="#8a9aa8" />
    </div>
    <div className="section-row">
      <div className="panel">
        <div className="panel-title"><div><span className="section-kicker">QUICK ACTIONS</span><h3>เริ่มต้นใช้งาน</h3></div></div>
        <div className="quick-grid">
          <button onClick={onAddProduct}><CirclePlus /><span><b>เพิ่มสินค้าใหม่</b><small>สร้างรายการสินค้าและสต็อก</small></span><ChevronRight /></button>
          <button onClick={() => go('orders')}><ShoppingCart /><span><b>สร้างออเดอร์</b><small>รับออเดอร์จากลูกค้า</small></span><ChevronRight /></button>
        </div>
      </div>
      <div className="panel feed">
        <div className="panel-title">
          <div><span className="section-kicker">RECENT ORDERS</span><h3>ออเดอร์ล่าสุด</h3></div>
          <div className="panel-actions">
            <button onClick={() => go('insights')} className="text-link">ดูทั้งหมด</button>
            {today.length > 0 && <button onClick={clearToday} className="text-link danger">ล้างวันนี้</button>}
          </div>
        </div>
        {orders.slice(0, 4).map((o) => <OrderRow key={o.id} o={o} onOpen={onOpenOrder} />)}
        {!orders.length && <p className="empty">ยังไม่มีออเดอร์</p>}
      </div>
    </div>
  </>
}

// ---------------------------------------------------------------- products

function Products({ products, categories, onAdd, onEdit, onDelete }: {
  products: Product[]; categories: string[]; onAdd: () => void; onEdit: (p: Product) => void; onDelete: (p: Product) => void
}) {
  const f = useCategoryFilter(products, categories)
  return <>
    <div className="toolbar">
      <label className="search"><Search size={15} /><input value={f.query} onChange={(e) => f.setQuery(e.target.value)} placeholder="ค้นหาสินค้า" /></label>
      <button className="primary" onClick={onAdd}><Plus size={18} /> เพิ่มสินค้า</button>
    </div>
    <CategoryTabs categories={categories} value={f.category} onChange={f.setCategory} counts={f.counts} />
    <div className="product-grid">
      {f.filtered.map((p) => {
        const out = p.status === 'out_of_stock'
        return (
          <div className={`product-card ${out ? 'is-out' : ''}`} key={p.id}>
            <div className="product-image">
              <ProductImage src={p.img} />
              <span className={out ? 'out-stock' : 'in-stock'}>{out ? 'สินค้าหมด' : 'มีสินค้า'}</span>
            </div>
            <div className="product-body">
              <div className="product-actions">
                <span className="muted">{p.brand || 'SANGWAT'}</span>
                <div>
                  <button onClick={() => onEdit(p)} aria-label="แก้ไข"><Edit3 size={15} /></button>
                  <button onClick={() => onDelete(p)} aria-label="ลบ"><Trash2 size={15} /></button>
                </div>
              </div>
              <h3>{p.name}</h3>
              <small className="category-label">{categoryOf(p)}</small>
              <div className="price-row"><b>฿{money(p.bagPrice)}</b><span>/ ถุง</span><b>฿{money(p.kgPrice)}</b><span>/ กก.</span></div>
              <div className="stock-row">
                <span className={p.bagStock <= 0 ? 'zero' : ''}>สต็อกถุง <b>{money(p.bagStock)}</b></span>
                <span className={p.kgStock <= 0 ? 'zero' : ''}>สต็อกกก. <b>{money(p.kgStock)}</b></span>
              </div>
              {out && <button className="restock" onClick={() => onEdit(p)}><PackagePlus size={15} /> เติมสต็อก</button>}
            </div>
          </div>
        )
      })}
    </div>
    {!f.filtered.length && <p className="empty">{products.length ? 'ไม่พบสินค้าในหมวดหมู่นี้' : 'ยังไม่มีสินค้า กด "เพิ่มสินค้า" เพื่อเริ่มต้น'}</p>}
  </>
}

// ---------------------------------------------------------------- orders

function QtyControl({ value, max, onChange, disabled }: { value: number; max: number; onChange: (v: number) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <div className={`qty ${disabled ? 'disabled' : ''}`}>
      <button onClick={() => onChange(value - 1)} disabled={disabled || value <= 0} aria-label="ลด"><Minus size={15} /></button>
      <input
        inputMode="decimal"
        value={draft ?? (value ? String(value) : '0')}
        disabled={disabled}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ''))}
        onBlur={() => { if (draft !== null) onChange(Math.min(max, num(draft))); setDraft(null) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
      <button onClick={() => onChange(value + 1)} disabled={disabled || value + 1 > max} aria-label="เพิ่ม"><Plus size={15} /></button>
    </div>
  )
}

function Orders({ products, categories, cart, cartItems, cartTotal, setQty, customer, setCustomer, seller, setSeller, sellers, customers, clearCart, submit }: {
  products: Product[]; categories: string[]; cart: Cart; cartItems: OrderItem[]; cartTotal: number; setQty: (p: Product, u: Unit, v: number) => void
  customer: string; setCustomer: (v: string) => void; seller: string; setSeller: (v: string) => void; sellers: string[]; customers: string[]; clearCart: () => void; submit: () => void
}) {
  const f = useCategoryFilter(products, categories)
  const cartCost = cartItems.reduce((s, i) => s + i.cost * i.qty, 0)
  return (
    <div className="order-layout">
      <section>
        <div className="customer-field two">
          <label>ชื่อลูกค้า<input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="เช่น นาย A" list="customer-list" /></label>
          <label>พนักงานขาย<input value={seller} onChange={(e) => setSeller(e.target.value)} placeholder="ชื่อผู้ขาย" list="seller-list" /></label>
          <datalist id="customer-list">{customers.map((c) => <option key={c} value={c} />)}</datalist>
          <datalist id="seller-list">{sellers.map((s) => <option key={s} value={s} />)}</datalist>
        </div>
        <label className="search wide"><Search size={15} /><input value={f.query} onChange={(e) => f.setQuery(e.target.value)} placeholder="ค้นหาสินค้า" /></label>
        <CategoryTabs categories={categories} value={f.category} onChange={f.setCategory} counts={f.counts} />
        <div className="order-products">
          {f.filtered.map((p) => {
            const out = p.status === 'out_of_stock'
            return (
              <div className={`order-product ${out ? 'is-out' : ''}`} key={p.id}>
                <div className="mini-product"><ProductImage src={p.img} size={22} /></div>
                <div className="order-info">
                  <b>{p.name} {out && <em className="badge-out">สินค้าหมด</em>}</b>
                  <small>{categoryOf(p)} · ถุง ฿{money(p.bagPrice)} · กก. ฿{money(p.kgPrice)}</small>
                </div>
                {(['bag', 'kg'] as Unit[]).map((u) => (
                  <div className="unit-qty" key={u}>
                    <small>{u === 'bag' ? 'ถุง' : 'กิโลกรัม'} · เหลือ {money(stockOf(p, u))}</small>
                    <QtyControl value={cart[p.id]?.[u] || 0} max={stockOf(p, u)} disabled={stockOf(p, u) <= 0} onChange={(v) => setQty(p, u, v)} />
                  </div>
                ))}
              </div>
            )
          })}
          {!f.filtered.length && <p className="empty">{products.length ? 'ไม่พบสินค้าในหมวดหมู่นี้' : 'ยังไม่มีสินค้า'}</p>}
        </div>
      </section>
      <aside className="cart-panel">
        <div className="cart-header"><h3>สรุปออเดอร์</h3><span>{cartItems.length} รายการ {cartItems.length > 0 && <button className="text-link danger" onClick={clearCart}>ล้าง</button>}</span></div>
        {cartItems.map((i) => (
          <div className="cart-line" key={`${i.id}-${i.unit}`}>
            <span>{i.name}<small>{money(i.qty)} {unitLabel(i.unit)} × ฿{money(i.price)}</small></span>
            <b>฿{money(i.qty * i.price)}</b>
          </div>
        ))}
        {!cartItems.length && <p className="empty">ยังไม่ได้เลือกสินค้า</p>}
        <div className="cart-total"><span>ยอดรวม</span><strong>฿{money(cartTotal)}</strong></div>
        {cartItems.length > 0 && <div className="cart-profit"><span>กำไรโดยประมาณ</span><b>฿{money(cartTotal - cartCost)}</b></div>}
        <button className="primary full" onClick={submit} disabled={!cartItems.length}>ส่งออเดอร์ <ShoppingCart size={17} /></button>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------- insights

function Insights({ orders, onOpenOrder }: { orders: Order[]; onOpenOrder: (o: Order) => void }) {
  const [period, setPeriod] = useState<Period>('all')
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null)
  const list = useMemo(() => orders.filter((o) => inPeriod(o.createdAt, period)), [orders, period])
  const revenue = list.reduce((s, o) => s + o.total, 0)
  const cost = list.reduce((s, o) => s + o.cost, 0)
  const profit = revenue - cost
  const byCustomer = useMemo(() => summarize(list, (o) => o.customer), [list])
  const bySeller = useMemo(() => summarize(list, (o) => o.seller), [list])
  const maxCustomer = Math.max(1, ...byCustomer.map((c) => c.revenue))
  const maxSeller = Math.max(1, ...bySeller.map((c) => c.revenue))
  const history = selectedCustomer ? list.filter((o) => o.customer === selectedCustomer) : list
  const periodLabel: Record<Period, string> = { all: 'ทุกช่วงเวลา', today: 'วันนี้', week: '7 วันล่าสุด', month: 'เดือนนี้' }

  return <>
    <div className="toolbar">
      <p className="muted">แสดงข้อมูล: {periodLabel[period]} · {list.length} ออเดอร์</p>
      <select className="period-select" value={period} onChange={(e) => { setPeriod(e.target.value as Period); setSelectedCustomer(null) }}>
        {(Object.keys(periodLabel) as Period[]).map((p) => <option key={p} value={p}>{periodLabel[p]}</option>)}
      </select>
    </div>
    <div className="stats">
      <Stat label="ยอดขายรวม" value={`฿${money(revenue)}`} sub={periodLabel[period]} accent="#d6a84a" />
      <Stat label="ต้นทุนรวม" value={`฿${money(cost)}`} sub="จากรายการขาย" accent="#e8c875" />
      <Stat label="กำไรสุทธิ" value={`฿${money(profit)}`} sub={`อัตรากำไร ${money(revenue ? (profit / revenue) * 100 : 0)}%`} accent="#55aa73" />
      <Stat label="จำนวนออเดอร์" value={String(list.length)} sub={`เฉลี่ย ฿${money(list.length ? revenue / list.length : 0)} / ออเดอร์`} accent="#8a9aa8" />
    </div>
    <div className="insights-grid">
      <div className="panel insights-panel">
        <div className="panel-title"><div><span className="section-kicker">SALESPERSON PERFORMANCE</span><h3>สรุปตามพนักงานขาย</h3></div></div>
        {bySeller.length > 0 && <div className="insight-head"><span>พนักงาน</span><span>ออเดอร์</span><span>ยอดขาย</span><span>กำไร</span></div>}
        {bySeller.map((s) => (
          <div className="insight-row seller" key={s.key}>
            <span className="feed-avatar">{s.key[0]}</span>
            <span className="insight-name"><b>{s.key}</b><span className="bar"><i style={{ width: `${(s.revenue / maxSeller) * 100}%` }} /></span></span>
            <span className="insight-num">{s.orders}</span>
            <strong className="insight-num">฿{money(s.revenue)}</strong>
            <strong className={`insight-num ${s.profit >= 0 ? 'positive' : 'negative'}`}>฿{money(s.profit)}</strong>
          </div>
        ))}
        {!list.length && <p className="empty">ข้อมูลสรุปจะแสดงเมื่อมีออเดอร์</p>}
      </div>
      <div className="panel insights-panel">
        <div className="panel-title"><div><span className="section-kicker">CUSTOMER SUMMARY</span><h3>สรุปตามลูกค้า</h3></div></div>
        {byCustomer.length > 0 && <div className="insight-head"><span>ลูกค้า</span><span>ออเดอร์</span><span>ยอดขาย</span><span>กำไร</span></div>}
        {byCustomer.map((c) => (
          <button className={`insight-row clickable ${selectedCustomer === c.key ? 'selected' : ''}`} key={c.key} onClick={() => setSelectedCustomer(selectedCustomer === c.key ? null : c.key)}>
            <span className="feed-avatar">{c.key[0]}</span>
            <span className="insight-name"><b>{c.key}</b><span className="bar"><i style={{ width: `${(c.revenue / maxCustomer) * 100}%` }} /></span></span>
            <span className="insight-num">{c.orders}</span>
            <strong className="insight-num">฿{money(c.revenue)}</strong>
            <strong className={`insight-num ${c.profit >= 0 ? 'positive' : 'negative'}`}>฿{money(c.profit)}</strong>
          </button>
        ))}
        {!list.length && <p className="empty">ข้อมูลสรุปจะแสดงเมื่อมีออเดอร์</p>}
      </div>
    </div>
    <div className="panel insights-panel history">
      <div className="panel-title">
        <div><span className="section-kicker">ORDER HISTORY</span><h3>{selectedCustomer ? `ออเดอร์ของ ${selectedCustomer}` : 'ประวัติออเดอร์'}</h3></div>
        {selectedCustomer && <button className="text-link" onClick={() => setSelectedCustomer(null)}><X size={12} /> แสดงทั้งหมด</button>}
      </div>
      <p className="muted">คลิกที่ออเดอร์เพื่อดูรายละเอียดและดาวน์โหลดบิล PDF</p>
      {history.map((o) => <OrderRow key={o.id} o={o} onOpen={onOpenOrder} />)}
      {!history.length && <p className="empty">ไม่มีออเดอร์ในช่วงเวลานี้</p>}
    </div>
  </>
}

// ---------------------------------------------------------------- product modal

const NUMBER_FIELDS = ['cost', 'labor', 'freight', 'kgPerBag', 'bagPrice', 'kgPrice', 'bagStock', 'kgStock'] as const
type NumberField = (typeof NUMBER_FIELDS)[number]
type TextField = 'name' | 'brand' | 'category' | 'img'

function ProductModal({ value, categories, onClose, onSave }: { value?: Product; categories: string[]; onClose: () => void; onSave: (p: Product) => void }) {
  const base: Product = value || { id: `p-${Date.now()}`, name: '', brand: '', category: DEFAULT_CATEGORY, img: '', cost: 0, labor: 0, freight: 0, unitCost: 0, kgPerBag: 0, bagPrice: 0, kgPrice: 0, bagStock: 0, kgStock: 0 }
  const [text, setText] = useState<Record<TextField, string>>({ name: base.name || '', brand: base.brand || '', category: base.category || '', img: base.img || '' })
  // numbers are edited as strings so values like "12.5" can be typed naturally
  const [nums, setNums] = useState<Record<NumberField, string>>(() => Object.fromEntries(NUMBER_FIELDS.map((k) => [k, num(base[k]) ? String(base[k]) : ''])) as Record<NumberField, string>)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const setT = (k: TextField, v: string) => setText((x) => ({ ...x, [k]: v }))
  const setN = (k: NumberField, v: string) => setNums((x) => ({ ...x, [k]: v.replace(/[^\d.]/g, '') }))

  const draft: Product = {
    ...base,
    name: text.name.trim(),
    brand: text.brand.trim(),
    category: text.category.trim() || DEFAULT_CATEGORY,
    img: text.img.trim(),
    ...(Object.fromEntries(NUMBER_FIELDS.map((k) => [k, Math.max(0, num(nums[k]))])) as Record<NumberField, number>),
  }
  draft.unitCost = round2(draft.cost + draft.labor + draft.freight)

  const uploadImage = async (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return alert('กรุณาเลือกไฟล์รูปภาพ')
    setUploading(true)
    try {
      setT('img', await compressImage(file))
    } catch {
      alert('ไม่สามารถอ่านไฟล์รูปนี้ได้')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = '' // allow choosing the same file again
    }
  }

  const save = () => {
    if (!draft.name) return alert('กรุณากรอกชื่อสินค้า')
    onSave(draft)
  }

  const numberInput = (k: NumberField, label: string) => (
    <label>{label}<input inputMode="decimal" value={nums[k]} onChange={(e) => setN(k, e.target.value)} placeholder="0" /></label>
  )

  const isDataUrl = text.img.startsWith('data:')
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div><span className="section-kicker">PRODUCT MANAGER</span><h2>{value ? 'แก้ไขสินค้า' : 'เพิ่มสินค้าใหม่'}</h2></div>
          <button onClick={onClose} aria-label="ปิด"><X /></button>
        </div>
        <div
          className={`image-upload wide ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); uploadImage(e.dataTransfer.files?.[0]) }}
        >
          <div className="upload-preview"><ProductImage src={text.img} size={28} /></div>
          <div>
            <b>รูปสินค้า</b>
            <p>อัปโหลดจากเครื่อง ลากไฟล์มาวาง หรือใช้ URL / ลิงก์ Google Drive</p>
            <div className="upload-actions">
              <button type="button" className="upload-button" onClick={() => fileRef.current?.click()} disabled={uploading}><Upload size={15} /> {uploading ? 'กำลังอ่านรูป...' : 'เลือกไฟล์รูป'}</button>
              {text.img && <button type="button" className="text-link danger" onClick={() => setT('img', '')}>ลบรูป</button>}
            </div>
            <input ref={fileRef} hidden type="file" accept="image/*" onChange={(e) => uploadImage(e.target.files?.[0])} />
          </div>
        </div>
        <div className="form-grid">
          <label className="wide">ชื่อสินค้า<input value={text.name} onChange={(e) => setT('name', e.target.value)} placeholder="เช่น ข้าวหอมมะลิ 5 กก." /></label>
          <label>แบรนด์<input value={text.brand} onChange={(e) => setT('brand', e.target.value)} /></label>
          <label>หมวดหมู่<input value={text.category} onChange={(e) => setT('category', e.target.value)} placeholder="เช่น ข้าวเหนียว" list="category-list" /></label>
          <datalist id="category-list">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          <label className="wide">รูปภาพ URL / Drive<input value={isDataUrl ? '(รูปที่อัปโหลดจากเครื่อง)' : text.img} readOnly={isDataUrl} onChange={(e) => setT('img', e.target.value)} placeholder="https://..." /></label>
          {numberInput('cost', 'ราคาทุน / ถุง')}
          {numberInput('labor', 'ค่าคนงาน / ถุง')}
          {numberInput('freight', 'ค่าบรรทุก / ถุง')}
          <label>ต้นทุนรวม / ถุง<input value={money(draft.unitCost)} readOnly /></label>
          {numberInput('kgPerBag', 'น้ำหนัก (กก. / ถุง)')}
          <label>ต้นทุน / กก.<input value={money(kgCost(draft))} readOnly /></label>
          {numberInput('bagPrice', 'ราคาขาย / ถุง')}
          {numberInput('kgPrice', 'ราคาขาย / กก.')}
          {numberInput('bagStock', 'สต็อก / ถุง')}
          {numberInput('kgStock', 'สต็อก / กก.')}
        </div>
        <p className={`stock-status ${totalStock(draft) > 0 ? 'positive' : 'negative'}`}>สถานะ: {totalStock(draft) > 0 ? 'มีสินค้า' : 'สินค้าหมด'} (คำนวณอัตโนมัติจากสต็อก)</p>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>ยกเลิก</button>
          <button className="primary" onClick={save} disabled={uploading}><Upload size={17} /> บันทึกสินค้า</button>
        </div>
      </div>
    </div>
  )
}
