// Shared types and pure helpers for the Sangwat POS.

export type Unit = 'bag' | 'kg'
export type StockStatus = 'in_stock' | 'out_of_stock'

export type Product = {
  id: string
  name: string
  brand?: string
  category?: string
  img?: string
  cost: number
  labor: number
  freight: number
  /** cost per bag = cost + labor + freight */
  unitCost: number
  /** kilograms in one bag – used to work out the cost of selling by kg */
  kgPerBag?: number
  bagPrice: number
  kgPrice: number
  bagStock: number
  kgStock: number
  status?: StockStatus
  /** set whenever the product is changed in this app (edit, stock deduction…) */
  updatedAt?: number
}

export type OrderItem = {
  id: string
  name: string
  unit: Unit
  qty: number
  /** selling price per unit */
  price: number
  /** cost per unit */
  cost: number
}

export type Order = {
  id: string
  customer: string
  createdAt: string
  items: OrderItem[]
  total: number
  cost: number
  profit: number
}

export type Cart = Record<string, { bag: number; kg: number }>

export const DEFAULT_CATEGORY = 'ทั่วไป'

export const unitLabel = (u: Unit) => (u === 'bag' ? 'ถุง' : 'กก.')

export function money(value: number) {
  return new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0)
}

export const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

export const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export const categoryOf = (p: Pick<Product, 'category'>) => p.category?.trim() || DEFAULT_CATEGORY

export const totalStock = (p: Product) => num(p.bagStock) + num(p.kgStock)

/** Status is always derived from the stock so it can never get out of sync. */
export function withStatus(p: Product): Product {
  const bagStock = Math.max(0, round2(num(p.bagStock)))
  const kgStock = Math.max(0, round2(num(p.kgStock)))
  return { ...p, bagStock, kgStock, status: bagStock + kgStock > 0 ? 'in_stock' : 'out_of_stock' }
}

/** Cost of one kilogram. Uses kg-per-bag if known, otherwise the bag/kg price ratio. */
export function kgCost(p: Product) {
  if (num(p.kgPerBag) > 0) return num(p.unitCost) / num(p.kgPerBag)
  if (num(p.bagPrice) > 0 && num(p.kgPrice) > 0) return (num(p.unitCost) * num(p.kgPrice)) / num(p.bagPrice)
  return 0
}

export const unitPrice = (p: Product, u: Unit) => (u === 'bag' ? num(p.bagPrice) : num(p.kgPrice))
export const unitCostOf = (p: Product, u: Unit) => (u === 'bag' ? num(p.unitCost) : kgCost(p))
export const stockOf = (p: Product, u: Unit) => (u === 'bag' ? num(p.bagStock) : num(p.kgStock))

export function normalizeProduct(raw: any): Product {
  const cost = num(raw.cost ?? raw.baseCost)
  const labor = num(raw.labor ?? raw.laborCost)
  const freight = num(raw.freight ?? raw.transportCost)
  const rawUnitCost = raw.unitCost ?? raw.totalCost
  return withStatus({
    id: String(raw.id ?? '').trim() || `gs-${String(raw.name ?? raw.productName ?? '').trim()}`,
    name: String(raw.name ?? raw.productName ?? '').trim(),
    brand: String(raw.brand ?? ''),
    category: String(raw.category ?? raw.type ?? '').trim() || DEFAULT_CATEGORY,
    img: String(raw.img ?? raw.imageUrl ?? ''),
    cost,
    labor,
    freight,
    // an empty / zero unitCost column falls back to cost + labor + freight
    unitCost: num(rawUnitCost) > 0 ? num(rawUnitCost) : cost + labor + freight,
    kgPerBag: num(raw.kgPerBag ?? raw.bagSize ?? raw.weight),
    bagPrice: num(raw.bagPrice ?? raw.retailPrice),
    kgPrice: num(raw.kgPrice ?? raw.pricePerKg),
    bagStock: num(raw.bagStock ?? raw.stockBags ?? raw.stock),
    kgStock: num(raw.kgStock ?? raw.stockKg),
    updatedAt: raw.updatedAt ? num(raw.updatedAt) : undefined,
  })
}

export function normalizeOrder(raw: any): Order {
  const items: OrderItem[] = (Array.isArray(raw.items) ? raw.items : []).map((i: any) => ({
    id: String(i.id ?? ''),
    name: String(i.name ?? ''),
    unit: i.unit === 'kg' ? 'kg' : 'bag',
    qty: num(i.qty),
    price: num(i.price),
    cost: num(i.cost),
  }))
  const total = raw.total !== undefined ? num(raw.total) : items.reduce((s, i) => s + i.price * i.qty, 0)
  const cost = raw.cost !== undefined ? num(raw.cost) : items.reduce((s, i) => s + i.cost * i.qty, 0)
  return {
    id: String(raw.id ?? `POS-${Date.now()}`),
    customer: String(raw.customer ?? '').trim() || 'ลูกค้าทั่วไป',
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    items,
    total: round2(total),
    cost: round2(cost),
    profit: round2(total - cost),
  }
}

/**
 * Merge products from Google Sheet with the local list.
 * - products changed in this app (updatedAt set) keep the local version (edits, stock deductions)
 * - products only in this app are kept
 * - products deleted in this app do not come back
 */
export function mergeRemote(local: Product[], remote: Product[], deleted: Set<string>): Product[] {
  const localById = new Map(local.map((p) => [p.id, p]))
  const remoteIds = new Set(remote.map((p) => p.id))
  const merged = remote
    .filter((r) => !deleted.has(r.id))
    .map((r) => {
      const l = localById.get(r.id)
      return l && l.updatedAt ? l : l ? { ...r, img: r.img || l.img } : r
    })
  const localOnly = local.filter((p) => !remoteIds.has(p.id))
  return [...localOnly, ...merged].map(withStatus)
}

/** Turns Google Drive share links into a URL that can be shown in an <img>. */
export function resolveImageUrl(url?: string) {
  const u = (url || '').trim()
  if (!u) return ''
  const m = u.match(/drive\.google\.com\/(?:file\/d\/|open\?(?:.*&)?id=|uc\?(?:.*&)?id=|thumbnail\?(?:.*&)?id=)([\w-]+)/)
  if (m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000`
  return u
}

/** Reads an image file and shrinks it so it fits comfortably in localStorage. */
export function compressImage(file: File, maxSize = 800, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('not-image'))
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const src = String(reader.result)
      const img = new Image()
      img.onerror = () => reject(new Error('decode'))
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return resolve(src)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.src = src
    }
    reader.readAsDataURL(file)
  })
}

export function readStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writeStorage(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export type Summary = { key: string; orders: number; revenue: number; cost: number; profit: number }

export function summarize(orders: Order[], keyOf: (o: Order) => string): Summary[] {
  const map = new Map<string, Summary>()
  for (const o of orders) {
    const key = keyOf(o)
    const s = map.get(key) || { key, orders: 0, revenue: 0, cost: 0, profit: 0 }
    s.orders += 1
    s.revenue += o.total
    s.cost += o.cost
    s.profit += o.profit
    map.set(key, s)
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue)
}

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

// ---------------------------------------------------------------- dates (local time, YYYY-MM-DD)

const pad = (n: number) => String(n).padStart(2, '0')
export const toDateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const dateKeyOf = (iso: string) => toDateKey(new Date(iso))
export const todayKey = () => toDateKey(new Date())
export function shiftDays(key: string, days: number) {
  const [y, m, d] = key.split('-').map(Number)
  return toDateKey(new Date(y, m - 1, d + days))
}
export const formatDateKey = (key: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Intl.DateTimeFormat('th-TH', opts).format(new Date(y, m - 1, d))
}

export type DateRange = { from: string; to: string } // inclusive, '' = open-ended
export const inRange = (iso: string, r: DateRange) => {
  const k = dateKeyOf(iso)
  return (!r.from || k >= r.from) && (!r.to || k <= r.to)
}

export function dailySummary(orders: Order[]): Summary[] {
  return summarize(orders, (o) => dateKeyOf(o.createdAt)).sort((a, b) => b.key.localeCompare(a.key))
}
