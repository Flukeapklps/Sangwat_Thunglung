// Builds a real Excel (.xlsx) report that opens as tables in Excel / Google Sheets / Numbers.
import { dailySummary, dateKeyOf, type Order, type Product, summarize, unitLabel } from '@/lib/pos'

const bold = { fontWeight: 'bold' as const, backgroundColor: '#EDF4EC' }
const money = '#,##0.00'
const head = (labels: string[]) => labels.map((value) => ({ value, ...bold }))
const n = (value: number) => ({ value: Math.round(value * 100) / 100, type: Number, format: money })

export async function downloadExcelReport(orders: Order[], products: Product[], label: string) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser')
  const sorted = [...orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const daily = dailySummary(sorted).reverse()
  const dailyRows = [
    head(['วันที่', 'จำนวนออเดอร์', 'ยอดขาย', 'ต้นทุน', 'กำไร']),
    ...daily.map((d) => [{ value: d.key }, { value: d.orders }, n(d.revenue), n(d.cost), n(d.profit)]),
    [{ value: 'รวม', fontWeight: 'bold' as const }, { value: sorted.length, fontWeight: 'bold' as const },
      { ...n(sorted.reduce((s, o) => s + o.total, 0)), fontWeight: 'bold' as const },
      { ...n(sorted.reduce((s, o) => s + o.cost, 0)), fontWeight: 'bold' as const },
      { ...n(sorted.reduce((s, o) => s + o.profit, 0)), fontWeight: 'bold' as const }],
  ]

  const orderRows = [
    head(['วันที่', 'เวลา', 'เลขที่ออเดอร์', 'ลูกค้า', 'จำนวนรายการ', 'ยอดขาย', 'ต้นทุน', 'กำไร']),
    ...sorted.map((o) => {
      const d = new Date(o.createdAt)
      return [{ value: dateKeyOf(o.createdAt) }, { value: d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) }, { value: o.id }, { value: o.customer }, { value: o.items.length }, n(o.total), n(o.cost), n(o.profit)]
    }),
  ]

  const itemRows = [
    head(['วันที่', 'เลขที่ออเดอร์', 'ลูกค้า', 'สินค้า', 'จำนวน', 'หน่วย', 'ราคา/หน่วย', 'ยอดขาย', 'ต้นทุน', 'กำไร']),
    ...sorted.flatMap((o) => o.items.map((i) => [
      { value: dateKeyOf(o.createdAt) }, { value: o.id }, { value: o.customer }, { value: i.name }, { value: i.qty }, { value: unitLabel(i.unit) },
      n(i.price), n(i.price * i.qty), n(i.cost * i.qty), n((i.price - i.cost) * i.qty),
    ])),
  ]

  const customerRows = [
    head(['ลูกค้า', 'จำนวนออเดอร์', 'ยอดขาย', 'ต้นทุน', 'กำไร']),
    ...summarize(sorted, (o) => o.customer).map((c) => [{ value: c.key }, { value: c.orders }, n(c.revenue), n(c.cost), n(c.profit)]),
  ]

  const stockRows = [
    head(['สินค้า', 'หมวดหมู่', 'สต็อก (ถุง)', 'สต็อก (กก.)', 'สถานะ', 'ราคา/ถุง', 'ราคา/กก.', 'ต้นทุน/ถุง']),
    ...products.map((p) => [{ value: p.name }, { value: p.category || '' }, { value: p.bagStock }, { value: p.kgStock },
      { value: p.status === 'out_of_stock' ? 'สินค้าหมด' : 'มีสินค้า' }, n(p.bagPrice), n(p.kgPrice), n(p.unitCost)]),
  ]

  const blob: Blob = await writeXlsxFile([
    { data: dailyRows, sheet: 'สรุปรายวัน', columns: [{ width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }] },
    { data: orderRows, sheet: 'ออเดอร์', columns: [{ width: 12 }, { width: 8 }, { width: 18 }, { width: 22 }, { width: 12 }, { width: 13 }, { width: 13 }, { width: 13 }] },
    { data: itemRows, sheet: 'รายการสินค้าที่ขาย', columns: [{ width: 12 }, { width: 18 }, { width: 20 }, { width: 26 }, { width: 8 }, { width: 7 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }] },
    { data: customerRows, sheet: 'สรุปตามลูกค้า', columns: [{ width: 24 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }] },
    { data: stockRows, sheet: 'สินค้าคงเหลือ', columns: [{ width: 26 }, { width: 14 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 }] },
  ] as any).toBlob()
  saveBlob(blob, `sangwat-report-${label}.xlsx`)
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
