'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3, CalendarDays, ChevronLeft, ChevronRight, CirclePlus, Cloud, Download, Edit3, FileSpreadsheet, FileUp, ImageOff,
  LayoutDashboard, Minus, Package, PackagePlus, Plus, RefreshCw, Search, Settings, ShoppingCart, Store, Trash2, Upload, X,
} from 'lucide-react'
import {
  type Cart, categoryOf, compressImage, dailySummary, type DateRange, DEFAULT_CATEGORY, formatDateKey, formatDateTime,
  inRange, kgCost, mergeRemote, money, normalizeOrder, normalizeProduct, num, type Order, type OrderItem, type Product,
  readStorage, resolveImageUrl, round2, shiftDays, stockOf, summarize, todayKey, totalStock, type Unit, unitCostOf,
  unitLabel, unitPrice, withStatus, writeStorage,
} from '@/lib/pos'
import { fetchSheet, postSheet, type SheetAction, type SheetData, type SheetMode, SheetRejected, withDate } from '@/lib/sync'
import { OrderDetailModal } from '@/components/order-detail'

// the shop's shared Google Sheet – every device connects here automatically
const DEFAULT_SHEET_URL = 'https://script.google.com/macros/s/AKfycbxF0l9Njl_DsAZOwyfvh80cRFBron_v-SvsMrkpA1ERQrSQ6RXA68ljqAUFanGcW88WDg/exec'
// earlier sheet URLs: devices still pointing at these are moved to the default automatically
const RETIRED_SHEET_URLS = ['https://script.google.com/macros/s/AKfycbwzkCcKnFFNy14eRcWJbv2aXXmiol8dK1eJg5r0pMdaKAhYbpgq6ugFoGcLX3K3qKJq/exec']
const SETUP_GUIDE_URL = 'https://github.com/Flukeapklps/Sangwat_Thunglung/blob/main/google-apps-script/README.md'
const LOGO_URL = 'https://hebbkx1anhila5yf.public.blob.vercel-storage.com/sangwat%20logo-QtbMkseg5dRbmauJvFdCVl767RO672.png'
const HIDDEN_STARTER_NAMES = new Set(['ข้าวหอมมะลิ 5 กก.', 'ข้าวขาวเสาไห้ 5 กก.', 'ข้าวเหนียวเขี้ยวงู 5 กก.', 'ข้าวกล้องหอมมะลิ 1 กก.', 'ข้าวไรซ์เบอร์รี่ 1 กก.'])

const KEYS = {
  products: 'sangwat-products',
  overrides: 'sangwat-product-overrides', // legacy – migrated into products on load
  deleted: 'sangwat-deleted-products',
  orders: 'sangwat-orders',
  sheetUrl: 'sangwat-sheet-url',
  outbox: 'sangwat-sheet-outbox',
  linked: 'sangwat-sheet-linked', // url of the sheet that already received the local data
}

type Tab = 'overview' | 'products' | 'orders' | 'insights'
type SyncState = 'syncing' | 'online' | 'readonly' | 'pending' | 'offline'
type Detail = { order: Order; justCreated?: boolean }
type DeleteRequest = { orders: Order[]; title: string }

const isVisible = (p: Product) => !!p.name && !HIDDEN_STARTER_NAMES.has(p.name)
const uniqueCategories = (products: Product[]) => [...new Set(products.map(categoryOf))].sort((a, b) => a.localeCompare(b, 'th'))
const SYNC_TEXT: Record<SyncState, string> = {
  syncing: 'กำลังซิงก์กับ Google Sheet...',
  online: 'ซิงก์กับ Google Sheet แล้ว',
  readonly: 'Google Sheet: อ่านสินค้าได้อย่างเดียว (ยังไม่ได้ติดตั้งสคริปต์ใหม่)',
  pending: 'มีข้อมูลรอส่งขึ้น Google Sheet',
  offline: 'เชื่อมต่อ Google Sheet ไม่สำเร็จ (ใช้ข้อมูลในเครื่อง)',
}

function returnStock(products: Product[], orders: Order[]) {
  const back = new Map<string, { bag: number; kg: number }>()
  for (const o of orders) for (const i of o.items) {
    const b = back.get(i.id) || { bag: 0, kg: 0 }
    b[i.unit] += i.qty
    back.set(i.id, b)
  }
  return products.map((p) => {
    const b = back.get(p.id)
    return b ? withStatus({ ...p, bagStock: p.bagStock + b.bag, kgStock: p.kgStock + b.kg, updatedAt: Date.now() }) : p
  })
}

export default function PosApp() {
  const [hydrated, setHydrated] = useState(false)
  const [tab, setTab] = useState<Tab>('overview')
  const [products, setProducts] = useState<Product[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [deleted, setDeleted] = useState<string[]>([])
  const [cart, setCart] = useState<Cart>({})
  const [customer, setCustomer] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [modal, setModal] = useState<Product | null | false>(false)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null)
  const [sync, setSync] = useState<SyncState>('syncing')
  const [sheetUrl, setSheetUrl] = useState(DEFAULT_SHEET_URL)
  const [lastSynced, setLastSynced] = useState<Date | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const storageWarned = useRef(false)

  // sync bookkeeping lives in refs so async code always sees the latest values
  const outbox = useRef<SheetAction[]>([])
  const mode = useRef<SheetMode | null>(null)
  const imageMigrations = useRef(new Set<string>())
  const flushing = useRef(false)
  const urlRef = useRef(DEFAULT_SHEET_URL)
  const deletedRef = useRef<string[]>([])
  deletedRef.current = deleted

  // ---- persist (only after the initial load, so we never overwrite stored data with empty state)
  const persist = useCallback((key: string, value: unknown) => {
    if (!writeStorage(key, value) && !storageWarned.current) {
      storageWarned.current = true
      alert('พื้นที่จัดเก็บข้อมูลในเบราว์เซอร์เต็ม กรุณาสำรองข้อมูล หรือใช้รูปภาพขนาดเล็กลง / ใช้ URL รูปแทน')
    }
  }, [])
  useEffect(() => { if (hydrated) { persist(KEYS.products, products); try { localStorage.removeItem(KEYS.overrides) } catch {} } }, [products, hydrated, persist])
  useEffect(() => { if (hydrated) persist(KEYS.orders, orders) }, [orders, hydrated, persist])
  useEffect(() => { if (hydrated) persist(KEYS.deleted, deleted) }, [deleted, hydrated, persist])

  // ---- Google Sheet sync
  const applyFull = useCallback((data: SheetData) => {
    const remote = data.products.map(normalizeProduct).filter(isVisible)
    setProducts((prev) => {
      const local = new Map(prev.map((p) => [p.id, p]))
      // the sheet does not store photos uploaded from the device, keep them locally
      return remote.map((r) => { const l = local.get(r.id); return withStatus({ ...r, img: r.img || l?.img || '' }) })
    })
    setOrders(data.orders.map(normalizeOrder).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    setDeleted([])
  }, [])

  const saveOutbox = useCallback(() => {
    writeStorage(KEYS.outbox, outbox.current)
  }, [])

  const flush = useCallback(async () => {
    if (flushing.current || mode.current !== 'full') return
    flushing.current = true
    let last: SheetData | null = null
    try {
      while (outbox.current.length) {
        setSync('syncing')
        try {
          last = await postSheet(urlRef.current, outbox.current[0])
        } catch (e) {
          // the script refused this action: drop it so it cannot block everything queued after it
          if (!(e instanceof SheetRejected)) throw e
          console.warn('Google Sheet rejected', outbox.current[0].type, e.message)
        }
        outbox.current = outbox.current.slice(1)
        saveOutbox()
      }
      if (last) applyFull(last)
      setSync('online')
      setLastSynced(new Date())
    } catch {
      setSync(outbox.current.length ? 'pending' : 'offline')
    } finally {
      flushing.current = false
    }
  }, [applyFull, saveOutbox])

  const enqueue = useCallback((action: SheetAction) => {
    if (mode.current === 'readonly') return // old script cannot store anything
    outbox.current = [...outbox.current, action]
    saveOutbox()
    void flush()
  }, [flush, saveOutbox])

  const syncNow = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (flushing.current) return
    if (!opts.silent) setSync('syncing')
    try {
      const url = urlRef.current
      const data = await fetchSheet(url)
      mode.current = data.mode
      if (data.mode === 'readonly') {
        outbox.current = []
        saveOutbox()
        const remote = data.products.map(normalizeProduct).filter(isVisible)
        setProducts((prev) => mergeRemote(prev, remote, new Set(deletedRef.current)))
        setSync('readonly')
        setLastSynced(new Date())
        return
      }
      // first connection to this sheet: upload what was recorded on this device so nothing is lost
      if (readStorage<string>(KEYS.linked, '') !== url) {
        const remoteOrderIds = new Set(data.orders.map((o: any) => String(o.id)))
        const localOrders = readStorage<any[]>(KEYS.orders, []).map(normalizeOrder).filter((o) => !remoteOrderIds.has(o.id))
        // only add products the sheet does not have yet – never overwrite or delete shared data from one device
        const remoteProductIds = new Set(data.products.map((p: any) => String(p.id)))
        const remoteNames = new Set(data.products.map((p: any) => String(p.name ?? '').trim()))
        const localProducts = readStorage<any[]>(KEYS.products, []).map(normalizeProduct)
          .filter((p) => isVisible(p) && !remoteProductIds.has(p.id) && !remoteNames.has(p.name) && !deletedRef.current.includes(p.id))
        const first: SheetAction[] = [
          ...localProducts.map((p) => ({ type: 'saveProduct' as const, product: p })),
          ...(localOrders.length ? [{ type: 'upsertOrders' as const, orders: localOrders.map(withDate), deductStock: false }] : []),
        ]
        outbox.current = [...first, ...outbox.current]
        saveOutbox()
        writeStorage(KEYS.linked, url)
      }
      // photos uploaded on this device before the sheet could store them: send them to Google Drive (script v3+)
      if (data.version >= 3) {
        const remoteImg = new Map(data.products.map((p: any) => [String(p.id), String(p.img ?? '').trim()]))
        for (const p of readStorage<any[]>(KEYS.products, []).map(normalizeProduct)) {
          if (p.img?.startsWith('data:') && remoteImg.has(p.id) && !remoteImg.get(p.id) && !imageMigrations.current.has(p.id)) {
            imageMigrations.current.add(p.id)
            outbox.current = [...outbox.current, { type: 'setProductImage', id: p.id, img: p.img }]
          }
        }
        saveOutbox()
      }
      if (outbox.current.length) {
        await flush()
        if (outbox.current.length) return
        applyFull(await fetchSheet(url))
      } else {
        applyFull(data)
      }
      setSync('online')
      setLastSynced(new Date())
    } catch {
      setSync(outbox.current.length ? 'pending' : 'offline')
    }
  }, [applyFull, flush, saveOutbox])

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
    setProducts([...byId.values()].filter(isVisible))
    const deletedIds = readStorage<string[]>(KEYS.deleted, [])
    setDeleted(Array.isArray(deletedIds) ? deletedIds : [])
    deletedRef.current = Array.isArray(deletedIds) ? deletedIds : []
    const storedOrders = readStorage<any[]>(KEYS.orders, [])
    setOrders((Array.isArray(storedOrders) ? storedOrders : []).map(normalizeOrder))
    const storedUrl = readStorage<string>(KEYS.sheetUrl, "")
    const url = storedUrl && !RETIRED_SHEET_URLS.includes(storedUrl) ? storedUrl : DEFAULT_SHEET_URL
    if (storedUrl && url !== storedUrl) { try { localStorage.removeItem(KEYS.sheetUrl) } catch {} }
    urlRef.current = url
    setSheetUrl(url)
    const box = readStorage<SheetAction[]>(KEYS.outbox, [])
    outbox.current = Array.isArray(box) ? box : []
    setHydrated(true)
    // ask the browser not to evict our saved data (helps on iOS / Android)
    try { void navigator.storage?.persist?.() } catch {}
    void syncNow()
    // keep several devices in step: refresh every minute while the page is visible
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && mode.current === 'full' && !outbox.current.length) void syncNow({ silent: true })
    }, 60000)
    const online = () => void syncNow()
    window.addEventListener('online', online)
    return () => { window.clearInterval(timer); window.removeEventListener('online', online) }
  }, [syncNow])

  const changeSheetUrl = async (url: string) => {
    const clean = url.trim() || DEFAULT_SHEET_URL
    urlRef.current = clean
    setSheetUrl(clean)
    if (clean === DEFAULT_SHEET_URL) { try { localStorage.removeItem(KEYS.sheetUrl) } catch {} } else writeStorage(KEYS.sheetUrl, clean)
    mode.current = null
    await syncNow()
  }

  const categories = useMemo(() => uniqueCategories(products), [products])
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
    if (!name) return alert('กรุณาระบุชื่อลูกค้า')
    if (!cartItems.length) return alert('กรุณาเลือกสินค้าอย่างน้อย 1 รายการ')
    const shortage = cartItems.find((i) => {
      const p = productById.get(i.id)
      return !p || i.qty > stockOf(p, i.unit)
    })
    if (shortage) return alert(`สต็อก "${shortage.name}" ไม่เพียงพอ`)

    const total = round2(cartItems.reduce((s, i) => s + i.price * i.qty, 0))
    const cost = round2(cartItems.reduce((s, i) => s + i.cost * i.qty, 0))
    const order: Order = { id: `POS-${Date.now()}`, customer: name, createdAt: new Date().toISOString(), items: cartItems, total, cost, profit: round2(total - cost) }

    setOrders((xs) => [order, ...xs])
    // deduct stock immediately; status flips to "out of stock" automatically when it reaches 0
    setProducts((ps) => ps.map((p) => {
      const q = cart[p.id]
      if (!q) return p
      return withStatus({ ...p, bagStock: p.bagStock - (q.bag || 0), kgStock: p.kgStock - (q.kg || 0), updatedAt: Date.now() })
    }))
    enqueue({ type: 'upsertOrders', orders: [withDate(order)], deductStock: true })
    setCart({})
    setCustomer('')
    setDetail({ order, justCreated: true })
  }

  const deleteOrders = (list: Order[], restock: boolean) => {
    const ids = new Set(list.map((o) => o.id))
    setOrders((xs) => xs.filter((x) => !ids.has(x.id)))
    if (restock) setProducts((ps) => returnStock(ps, list))
    enqueue({ type: 'deleteOrders', ids: [...ids], restock })
    setDeleteRequest(null)
    setDetail(null)
  }

  const saveProduct = (p: Product) => {
    const saved = withStatus({ ...p, category: categoryOf(p), updatedAt: Date.now() })
    setProducts((xs) => (xs.some((x) => x.id === saved.id) ? xs.map((x) => (x.id === saved.id ? saved : x)) : [saved, ...xs]))
    setDeleted((d) => d.filter((id) => id !== saved.id))
    enqueue({ type: 'saveProduct', product: saved })
    setModal(false)
  }

  const deleteProduct = (p: Product) => {
    if (!confirm(`ลบสินค้า "${p.name}" หรือไม่?`)) return
    setProducts((xs) => xs.filter((x) => x.id !== p.id))
    setDeleted((d) => [...new Set([...d, p.id])])
    setCart((c) => { const copy = { ...c }; delete copy[p.id]; return copy })
    enqueue({ type: 'deleteProduct', id: p.id })
  }

  const backupData = () => {
    const blob = new Blob([JSON.stringify({ products, orders }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sangwat-backup-${todayKey()}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const downloadReport = async (list: Order[] = orders, label = `all-${todayKey()}`) => {
    try {
      const { downloadExcelReport } = await import('@/lib/report')
      await downloadExcelReport(list, products, label)
    } catch (e) {
      console.error(e)
      alert('ไม่สามารถสร้างไฟล์ Excel ได้ กรุณาลองใหม่')
    }
  }

  const importData = (file: File) => {
    const r = new FileReader()
    r.onload = () => {
      try {
        const d = JSON.parse(String(r.result))
        if (!Array.isArray(d.products) && !Array.isArray(d.orders)) throw new Error('invalid')
        if (Array.isArray(d.products)) {
          const list: Product[] = d.products.map((x: any) => ({ ...normalizeProduct(x), updatedAt: Date.now() })).filter(isVisible)
          setProducts(list)
          list.forEach((p) => enqueue({ type: 'saveProduct', product: p }))
        }
        if (Array.isArray(d.orders)) {
          const list: Order[] = d.orders.map(normalizeOrder)
          setOrders(list)
          if (list.length) enqueue({ type: 'upsertOrders', orders: list.map(withDate), deductStock: false })
        }
        alert('นำเข้าข้อมูลเรียบร้อย')
      } catch {
        alert('ไฟล์สำรองไม่ถูกต้อง')
      }
    }
    r.readAsText(file)
  }

  const askDelete = (list: Order[], title: string) => {
    if (!list.length) return alert('ไม่มีออเดอร์ให้ลบ')
    setDeleteRequest({ orders: list, title })
  }

  const openOrder = (o: Order) => setDetail({ order: o })

  const titles: Record<Tab, string> = { overview: 'ภาพรวมร้านค้า', products: 'สินค้า & สต็อก', orders: 'สร้างออเดอร์', insights: 'ยอดขาย & กำไร' }
  const nav: [Tab, string, typeof LayoutDashboard][] = [
    ['overview', 'ภาพรวม', LayoutDashboard],
    ['products', 'สินค้า & สต็อก', Package],
    ['orders', 'สร้างออเดอร์', ShoppingCart],
    ['insights', 'ยอดขาย & กำไร', BarChart3],
  ]
  const syncText = SYNC_TEXT[sync]

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
          <button onClick={() => downloadReport()}><FileSpreadsheet size={16} /> ดาวน์โหลดรายงาน Excel</button>
          <button onClick={() => setSheetOpen(true)}><Cloud size={16} /> ตั้งค่า Google Sheet</button>
        </div>
        <input ref={fileRef} hidden type="file" accept=".json,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (f) importData(f); e.target.value = '' }} />
      </aside>
      <main className="main">
        <header>
          <div>
            <p className="eyebrow">{hydrated ? new Intl.DateTimeFormat('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date()) : ' '}</p>
            <h1>{titles[tab]}</h1>
          </div>
          <div className="header-actions">
            <ShopMenu
              open={menuOpen}
              setOpen={setMenuOpen}
              sync={sync}
              syncText={syncText}
              productCount={products.length}
              orderCount={orders.length}
              onSync={() => syncNow()}
              onSheet={() => setSheetOpen(true)}
              onReport={() => downloadReport()}
              onBackup={backupData}
              onImport={() => fileRef.current?.click()}
            />
          </div>
        </header>

        {hydrated && (sync === 'readonly' || sync === 'offline') && (
          <div className="local-warning" role="status">
            <Cloud size={18} />
            <div>
              <b>ตอนนี้ข้อมูลถูกเก็บไว้ในเบราว์เซอร์นี้เท่านั้น</b>
              <small>คนอื่นที่เปิดลิงก์จะไม่เห็นออเดอร์ และข้อมูลอาจหายถ้าเปิดผ่านแอป LINE / Facebook หรือโหมดไม่ระบุตัวตน
                ติดตั้งสคริปต์ Google Sheet เพื่อให้ทุกเครื่องเห็นข้อมูลเดียวกันและไม่หาย</small>
            </div>
            <button className="secondary" onClick={() => setSheetOpen(true)}>ตั้งค่า Google Sheet</button>
          </div>
        )}
        {!hydrated ? <p className="empty">กำลังโหลดข้อมูล...</p> : <>
          {tab === 'overview' && <Overview orders={orders} products={products} sync={sync} go={setTab} onAddProduct={() => { setTab('products'); setModal(null) }} onOpenOrder={openOrder} clearToday={() => askDelete(orders.filter((o) => inRange(o.createdAt, { from: todayKey(), to: todayKey() })), `ออเดอร์วันนี้ (${formatDateKey(todayKey())})`)} />}
          {tab === 'products' && <Products products={products} categories={categories} onAdd={() => setModal(null)} onEdit={setModal} onDelete={deleteProduct} />}
          {tab === 'orders' && <Orders products={products} categories={categories} cart={cart} cartItems={cartItems} cartTotal={cartTotal} setQty={setQty} customer={customer} setCustomer={setCustomer} customers={customers} clearCart={() => setCart({})} submit={submitOrder} />}
          {tab === 'insights' && <Insights orders={orders} onOpenOrder={openOrder} onDelete={askDelete} onReport={downloadReport} />}
        </>}
      </main>
      {modal !== false && <ProductModal value={modal || undefined} categories={categories} onClose={() => setModal(false)} onSave={saveProduct} />}
      {detail && <OrderDetailModal order={detail.order} justCreated={detail.justCreated} customerTotals={customerTotals(detail.order.customer)} onClose={() => setDetail(null)} onDelete={detail.justCreated ? undefined : (o) => askDelete([o], `ออเดอร์ ${o.id} (${o.customer})`)} />}
      {deleteRequest && <DeleteOrdersModal request={deleteRequest} onCancel={() => setDeleteRequest(null)} onConfirm={(restock) => deleteOrders(deleteRequest.orders, restock)} />}
      {sheetOpen && <SheetSettingsModal url={sheetUrl} defaultUrl={DEFAULT_SHEET_URL} sync={sync} syncText={syncText} lastSynced={lastSynced} onClose={() => setSheetOpen(false)} onSave={changeSheetUrl} onSync={() => syncNow()} />}
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
      <span><b>{o.customer}</b><small>{o.items.length} รายการ · {formatDateTime(o.createdAt)}</small></span>
      <span className="feed-amount"><strong>฿{money(o.total)}</strong><small className={o.profit >= 0 ? 'positive' : 'negative'}>กำไร ฿{money(o.profit)}</small></span>
      <ChevronRight size={16} />
    </button>
  )
}

function ShopMenu({ open, setOpen, sync, syncText, productCount, orderCount, onSync, onSheet, onReport, onBackup, onImport }: {
  open: boolean; setOpen: (v: boolean) => void; sync: SyncState; syncText: string; productCount: number; orderCount: number
  onSync: () => void; onSheet: () => void; onReport: () => void; onBackup: () => void; onImport: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, setOpen])
  const run = (fn: () => void) => () => { setOpen(false); fn() }
  return (
    <div className="shop-menu" ref={ref}>
      <button className="avatar" aria-haspopup="menu" aria-expanded={open} title="ข้อมูลร้าน" onClick={() => setOpen(!open)}>ส</button>
      {open && (
        <div className="shop-menu-pop" role="menu">
          <div className="shop-menu-head">
            <Store size={18} />
            <div><b>แสงวัฒน์ ทุ่งลุง</b><small>สินค้า {productCount} รายการ · ออเดอร์ {orderCount} รายการ</small></div>
          </div>
          <span className={`connection ${sync}`}><i /> {syncText}</span>
          <button role="menuitem" onClick={run(onSync)}><RefreshCw size={16} /> ซิงก์กับ Google Sheet ตอนนี้</button>
          <button role="menuitem" onClick={run(onSheet)}><Settings size={16} /> ตั้งค่า Google Sheet</button>
          <button role="menuitem" onClick={run(onReport)}><FileSpreadsheet size={16} /> ดาวน์โหลดรายงาน Excel</button>
          <button role="menuitem" onClick={run(onBackup)}><Download size={16} /> สำรองข้อมูล (ไฟล์ .json)</button>
          <button role="menuitem" onClick={run(onImport)}><FileUp size={16} /> กู้คืนจากไฟล์สำรอง</button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- overview

function Overview({ orders, products, sync, go, onAddProduct, onOpenOrder, clearToday }: {
  orders: Order[]; products: Product[]; sync: SyncState; go: (t: Tab) => void; onAddProduct: () => void; onOpenOrder: (o: Order) => void; clearToday: () => void
}) {
  const today = orders.filter((o) => inRange(o.createdAt, { from: todayKey(), to: todayKey() }))
  const todayRevenue = today.reduce((s, o) => s + o.total, 0)
  const todayProfit = today.reduce((s, o) => s + o.profit, 0)
  const outOfStock = products.filter((p) => p.status === 'out_of_stock').length
  return <>
    <section className="hero">
      <div>
        <span className="hero-label">สรุปวันนี้</span>
        <h2>จัดการร้านให้ง่ายขึ้น<br /><em>เห็นทุกอย่างในที่เดียว</em></h2>
        <p>{sync === 'online' ? 'ซิงก์กับ Google Sheet แล้ว ออเดอร์และสต็อกจะบันทึกลงชีตอัตโนมัติ' : SYNC_TEXT[sync]}</p>
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
                {/* brand is the headline; product name sits underneath */}
                <h3 className="product-brand">{p.brand?.trim() || p.name}</h3>
                <div>
                  <button onClick={() => onEdit(p)} aria-label="แก้ไข"><Edit3 size={15} /></button>
                  <button onClick={() => onDelete(p)} aria-label="ลบ"><Trash2 size={15} /></button>
                </div>
              </div>
              {p.brand?.trim() && <p className="product-name">{p.name}</p>}
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

function Orders({ products, categories, cart, cartItems, cartTotal, setQty, customer, setCustomer, customers, clearCart, submit }: {
  products: Product[]; categories: string[]; cart: Cart; cartItems: OrderItem[]; cartTotal: number; setQty: (p: Product, u: Unit, v: number) => void
  customer: string; setCustomer: (v: string) => void; customers: string[]; clearCart: () => void; submit: () => void
}) {
  const f = useCategoryFilter(products, categories)
  const cartCost = cartItems.reduce((s, i) => s + i.cost * i.qty, 0)
  return (
    <div className="order-layout">
      <section>
        <div className="customer-field">
          <label>ชื่อลูกค้า<input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="เช่น นาย A" list="customer-list" /></label>
          <datalist id="customer-list">{customers.map((c) => <option key={c} value={c} />)}</datalist>
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

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'all'
const PRESET_LABEL: Record<Preset, string> = { today: 'วันนี้', yesterday: 'เมื่อวาน', week: '7 วันล่าสุด', month: 'เดือนนี้', all: 'ทั้งหมด' }
function presetRange(p: Preset): DateRange {
  const t = todayKey()
  if (p === 'today') return { from: t, to: t }
  if (p === 'yesterday') return { from: shiftDays(t, -1), to: shiftDays(t, -1) }
  if (p === 'week') return { from: shiftDays(t, -6), to: t }
  if (p === 'month') return { from: `${t.slice(0, 8)}01`, to: t }
  return { from: '', to: '' }
}
function rangeLabel(r: DateRange) {
  if (!r.from && !r.to) return 'ทุกวัน'
  if (r.from && r.from === r.to) return formatDateKey(r.from, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  return `${r.from ? formatDateKey(r.from) : 'เริ่มต้น'} – ${r.to ? formatDateKey(r.to) : 'ล่าสุด'}`
}

function Insights({ orders, onOpenOrder, onDelete, onReport }: {
  orders: Order[]; onOpenOrder: (o: Order) => void; onDelete: (list: Order[], title: string) => void; onReport: (list: Order[], label: string) => void
}) {
  const [range, setRange] = useState<DateRange>(() => presetRange('today'))
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null)
  const list = useMemo(() => orders.filter((o) => inRange(o.createdAt, range)), [orders, range])
  const revenue = list.reduce((s, o) => s + o.total, 0)
  const cost = list.reduce((s, o) => s + o.cost, 0)
  const profit = revenue - cost
  const days = useMemo(() => dailySummary(list), [list])
  const byCustomer = useMemo(() => summarize(list, (o) => o.customer), [list])
  const maxCustomer = Math.max(1, ...byCustomer.map((c) => c.revenue))
  const maxDay = Math.max(1, ...days.map((d) => d.revenue))
  const history = selectedCustomer ? list.filter((o) => o.customer === selectedCustomer) : list
  const singleDay = !!range.from && range.from === range.to
  const activePreset = (Object.keys(PRESET_LABEL) as Preset[]).find((p) => { const r = presetRange(p); return r.from === range.from && r.to === range.to })
  const label = rangeLabel(range)
  const setDay = (key: string) => { setRange({ from: key, to: key }); setSelectedCustomer(null) }
  const fileLabel = !range.from && !range.to ? `all-${todayKey()}` : singleDay ? range.from : `${range.from || 'start'}_to_${range.to || todayKey()}`

  return <>
    <div className="panel date-panel">
      <div className="date-presets">
        <CalendarDays size={16} />
        {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => (
          <button key={p} className={activePreset === p ? 'active' : ''} onClick={() => { setRange(presetRange(p)); setSelectedCustomer(null) }}>{PRESET_LABEL[p]}</button>
        ))}
      </div>
      <div className="date-inputs">
        {singleDay && <button className="icon-btn" aria-label="วันก่อนหน้า" onClick={() => setDay(shiftDays(range.from, -1))}><ChevronLeft size={16} /></button>}
        <label>ตั้งแต่<input type="date" value={range.from} max={range.to || undefined} onChange={(e) => setRange((r) => ({ from: e.target.value, to: r.to && e.target.value > r.to ? e.target.value : r.to }))} /></label>
        <label>ถึง<input type="date" value={range.to} min={range.from || undefined} onChange={(e) => setRange((r) => ({ from: r.from && e.target.value < r.from ? e.target.value : r.from, to: e.target.value }))} /></label>
        {singleDay && <button className="icon-btn" aria-label="วันถัดไป" onClick={() => setDay(shiftDays(range.from, 1))} disabled={range.from >= todayKey()}><ChevronRight size={16} /></button>}
      </div>
      <div className="date-summary">
        <b>{label}</b>
        <div className="date-actions">
          <button className="secondary" onClick={() => onReport(list, fileLabel)} disabled={!list.length}><FileSpreadsheet size={15} /> ดาวน์โหลด Excel</button>
          <button className="secondary danger" onClick={() => onDelete(list, `ออเดอร์ช่วง ${label}`)} disabled={!list.length}><Trash2 size={15} /> ลบออเดอร์ในช่วงนี้ ({list.length})</button>
        </div>
      </div>
    </div>

    <div className="stats">
      <Stat label="ยอดขายรวม" value={`฿${money(revenue)}`} sub={label} accent="#d6a84a" />
      <Stat label="ต้นทุนรวม" value={`฿${money(cost)}`} sub="จากรายการขาย" accent="#e8c875" />
      <Stat label="กำไรสุทธิ" value={`฿${money(profit)}`} sub={`อัตรากำไร ${money(revenue ? (profit / revenue) * 100 : 0)}%`} accent="#55aa73" />
      <Stat label="จำนวนออเดอร์" value={String(list.length)} sub={`เฉลี่ย ฿${money(list.length ? revenue / list.length : 0)} / ออเดอร์`} accent="#8a9aa8" />
    </div>

    <div className="insights-grid">
      <div className="panel insights-panel">
        <div className="panel-title"><div><span className="section-kicker">DAILY SUMMARY</span><h3>สรุปรายวัน</h3></div></div>
        {days.length > 0 && <div className="insight-head day"><span>วันที่</span><span>ออเดอร์</span><span>ยอดขาย</span><span>กำไร</span><span /></div>}
        {days.map((d) => (
          <div className={`insight-row day ${singleDay && range.from === d.key ? 'selected' : ''}`} key={d.key}>
            <button className="day-link" onClick={() => setDay(d.key)} title="ดูออเดอร์ของวันนี้">
              <b>{formatDateKey(d.key)}</b><span className="bar"><i style={{ width: `${(d.revenue / maxDay) * 100}%` }} /></span>
            </button>
            <span className="insight-num">{d.orders}</span>
            <strong className="insight-num">฿{money(d.revenue)}</strong>
            <strong className={`insight-num ${d.profit >= 0 ? 'positive' : 'negative'}`}>฿{money(d.profit)}</strong>
            <button className="icon-btn danger" aria-label={`ลบออเดอร์วันที่ ${d.key}`} title="ลบออเดอร์ของวันนี้" onClick={() => onDelete(list.filter((o) => inRange(o.createdAt, { from: d.key, to: d.key })), `ออเดอร์วันที่ ${formatDateKey(d.key)}`)}><Trash2 size={14} /></button>
          </div>
        ))}
        {!list.length && <p className="empty">ไม่มีออเดอร์ในช่วงวันที่นี้</p>}
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
        {!list.length && <p className="empty">ไม่มีออเดอร์ในช่วงวันที่นี้</p>}
      </div>
    </div>
    <div className="panel insights-panel history">
      <div className="panel-title">
        <div><span className="section-kicker">ORDER HISTORY</span><h3>{selectedCustomer ? `ออเดอร์ของ ${selectedCustomer}` : 'รายการออเดอร์'} · {label}</h3></div>
        {selectedCustomer && <button className="text-link" onClick={() => setSelectedCustomer(null)}><X size={12} /> แสดงทุกลูกค้า</button>}
      </div>
      <p className="muted">คลิกที่ออเดอร์เพื่อดูรายละเอียด ดาวน์โหลดบิล PDF หรือลบออเดอร์</p>
      {history.map((o) => <OrderRow key={o.id} o={o} onOpen={onOpenOrder} />)}
      {!history.length && <p className="empty">ไม่มีออเดอร์ในช่วงวันที่นี้</p>}
    </div>
  </>
}

// ---------------------------------------------------------------- dialogs

function DeleteOrdersModal({ request, onCancel, onConfirm }: { request: DeleteRequest; onCancel: () => void; onConfirm: (restock: boolean) => void }) {
  const [restock, setRestock] = useState(false)
  const total = request.orders.reduce((s, o) => s + o.total, 0)
  const items = request.orders.reduce((s, o) => s + o.items.length, 0)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-small" role="alertdialog" aria-modal="true">
        <div className="modal-head">
          <div><span className="section-kicker">DELETE ORDERS</span><h2>ลบออเดอร์</h2></div>
          <button onClick={onCancel} aria-label="ปิด"><X /></button>
        </div>
        <p className="delete-summary">{request.title}<br /><b>{request.orders.length} ออเดอร์</b> · {items} รายการสินค้า · ยอดขาย <b>฿{money(total)}</b></p>
        <label className="check">
          <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
          <span><b>คืนสินค้ากลับเข้าสต็อก</b><small>เลือกเมื่อออเดอร์ถูกยกเลิก / ลูกค้าไม่ได้รับของจริง ถ้าแค่ล้างข้อมูลเก่าที่ขายไปแล้ว ไม่ต้องเลือก</small></span>
        </label>
        <p className="muted">ยอดขายและกำไรของออเดอร์เหล่านี้จะถูกลบออกจากรายงานด้วย และย้อนกลับไม่ได้ (แนะนำให้ดาวน์โหลด Excel เก็บไว้ก่อน)</p>
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>ยกเลิก</button>
          <button className="primary danger-fill" onClick={() => onConfirm(restock)}><Trash2 size={16} /> ลบ {request.orders.length} ออเดอร์</button>
        </div>
      </div>
    </div>
  )
}

function SheetSettingsModal({ url, defaultUrl, sync, syncText, lastSynced, onClose, onSave, onSync }: {
  url: string; defaultUrl: string; sync: SyncState; syncText: string; lastSynced: Date | null; onClose: () => void; onSave: (url: string) => Promise<void>; onSync: () => void
}) {
  const [value, setValue] = useState(url)
  const [busy, setBusy] = useState(false)
  const valid = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/.test(value.trim())
  const save = async () => {
    if (!valid) return alert('URL ต้องเป็นลิงก์ Web app ของ Apps Script เช่น https://script.google.com/macros/s/xxxx/exec')
    setBusy(true)
    try { await onSave(value) } finally { setBusy(false) }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div><span className="section-kicker">GOOGLE SHEET</span><h2>เชื่อมต่อ Google Sheet</h2></div>
          <button onClick={onClose} aria-label="ปิด"><X /></button>
        </div>
        <div className={`sheet-status ${sync}`}>
          <span className={`connection ${sync}`}><i /> {syncText}</span>
          {lastSynced && <small>ซิงก์ล่าสุด {lastSynced.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small>}
        </div>
        {sync === 'readonly' && (
          <p className="notice">สคริปต์ที่เชื่อมอยู่ตอนนี้ส่งรายการสินค้าให้แอปได้อย่างเดียว ออเดอร์ สต็อก และยอดขายจึงยังไม่ถูกบันทึกลงชีต
            ติดตั้งสคริปต์ใหม่ตามคู่มือด้านล่าง แล้วนำ URL ใหม่มาวางที่นี่</p>
        )}
        <div className="form-grid">
          <label className="wide">URL ของ Apps Script (Web app)<input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://script.google.com/macros/s/.../exec" /></label>
        </div>
        <ol className="sheet-steps">
          <li>เปิด Google Sheet ของร้าน → เมนู <b>ส่วนขยาย → Apps Script</b></li>
          <li>ลบโค้ดเดิม แล้ววางโค้ดจากไฟล์ <code>google-apps-script/Code.gs</code> → กดบันทึก → เลือกฟังก์ชัน <b>setup</b> แล้วกด <b>เรียกใช้</b> (กดอนุญาตสิทธิ์)</li>
          <li><b>การทำให้ใช้งานได้ → การทำให้ใช้งานได้รายการใหม่ → เว็บแอป</b> · เรียกใช้ในฐานะ: <b>ฉัน</b> · ผู้มีสิทธิ์เข้าถึง: <b>ทุกคน</b></li>
          <li>คัดลอก URL ที่ลงท้ายด้วย <code>/exec</code> มาวางด้านบน แล้วกดบันทึก</li>
        </ol>
        <a className="text-link" href={SETUP_GUIDE_URL} target="_blank" rel="noreferrer">เปิดคู่มือและโค้ดสคริปต์ฉบับเต็ม →</a>
        <p className="muted sheet-note">เมื่อเชื่อมสำเร็จครั้งแรก ข้อมูลสินค้าและออเดอร์ที่บันทึกไว้ในเครื่องนี้จะถูกส่งขึ้นชีตให้อัตโนมัติ
          หลังจากนั้นทุกออเดอร์จะตัดสต็อกในชีต และอัปเดตชีต "สรุปรายวัน" กับ "สรุปตามลูกค้า" ให้ทันที</p>
        <div className="modal-actions">
          {value.trim() !== defaultUrl && <button className="secondary" onClick={() => setValue(defaultUrl)}>ใช้ URL เดิม</button>}
          <button className="secondary" onClick={onSync} disabled={busy}><RefreshCw size={15} /> ซิงก์ตอนนี้</button>
          <button className="primary" onClick={save} disabled={busy || value.trim() === url}><Cloud size={16} /> {busy ? 'กำลังเชื่อมต่อ...' : 'บันทึกและเชื่อมต่อ'}</button>
        </div>
      </div>
    </div>
  )
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
