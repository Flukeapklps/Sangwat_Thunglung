// Talks to the Google Apps Script web app (google-apps-script/Code.gs).
import { dateKeyOf, type Order, type Product } from '@/lib/pos'

export type SheetAction =
  | { type: 'upsertOrders'; orders: (Order & { date: string })[]; deductStock: boolean }
  | { type: 'deleteOrders'; ids: string[]; restock: boolean }
  | { type: 'saveProduct'; product: Product }
  | { type: 'deleteProduct'; id: string }
  | { type: 'setProductImage'; id: string; img: string }

/** full = new script (read + write), readonly = old script that only lists products */
export type SheetMode = 'full' | 'readonly'
export type SheetData = { mode: SheetMode; version: number; products: any[]; orders: any[]; warnings: string[] }

/** the script answered but refused the action (bad data / old script) – retrying will not help */
export class SheetRejected extends Error {}

export const withDate = (o: Order) => ({ ...o, date: dateKeyOf(o.createdAt) })

function parse(j: any): SheetData {
  if (Array.isArray(j)) return { mode: 'readonly', version: 1, products: j, orders: [], warnings: [] }
  if (j && j.ok && Array.isArray(j.products)) return { mode: 'full', version: Number(j.version) || 2, products: j.products, orders: Array.isArray(j.orders) ? j.orders : [], warnings: Array.isArray(j.warnings) ? j.warnings.map(String) : [] }
  if (j && j.ok === false) throw new SheetRejected(String(j.error || 'rejected'))
  throw new Error('รูปแบบข้อมูลจาก Google Sheet ไม่ถูกต้อง')
}

export async function fetchSheet(url: string): Promise<SheetData> {
  const r = await fetch(url, { cache: 'no-store' })
  return parse(await r.json())
}

export async function postSheet(url: string, action: SheetAction): Promise<SheetData> {
  // text/plain avoids a CORS pre-flight request, which Apps Script does not support
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(action) })
  return parse(await r.json())
}

export type Diagnosis = {
  version?: number; folderAccess?: boolean; folderName?: string; folderError?: string; usingFolder?: string
  canWrite?: boolean; writeError?: string; canShare?: boolean; shareError?: string; products?: number; productsWithImage?: number
}

/** asks the script (v4+) to check its Google Drive access */
export async function diagnoseSheet(url: string): Promise<Diagnosis | null> {
  const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}diag=1`, { cache: 'no-store' })
  const j = await r.json()
  return j && typeof j === 'object' && !Array.isArray(j) && 'canWrite' in j ? j : null
}
