// Talks to the Google Apps Script web app (google-apps-script/Code.gs).
import { dateKeyOf, type Order, type Product } from '@/lib/pos'

export type SheetAction =
  | { type: 'upsertOrders'; orders: (Order & { date: string })[]; deductStock: boolean }
  | { type: 'deleteOrders'; ids: string[]; restock: boolean }
  | { type: 'saveProduct'; product: Product }
  | { type: 'deleteProduct'; id: string }

/** full = new script (read + write), readonly = old script that only lists products */
export type SheetMode = 'full' | 'readonly'
export type SheetData = { mode: SheetMode; products: any[]; orders: any[] }

export const withDate = (o: Order) => ({ ...o, date: dateKeyOf(o.createdAt) })

function parse(j: any): SheetData {
  if (Array.isArray(j)) return { mode: 'readonly', products: j, orders: [] }
  if (j && j.ok && Array.isArray(j.products)) return { mode: 'full', products: j.products, orders: Array.isArray(j.orders) ? j.orders : [] }
  throw new Error((j && j.error) || 'รูปแบบข้อมูลจาก Google Sheet ไม่ถูกต้อง')
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
