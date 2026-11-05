'use client'

import { useRef, useState } from 'react'
import { FileDown, Trash2, X } from 'lucide-react'
import { formatDateTime, money, type Order, unitLabel } from '@/lib/pos'

const SHOP_NAME = 'แสงวัฒน์ ทุ่งลุง (Sangwat)'

/** Generates an A4 PDF from the receipt element. Thai text is rendered by the browser, so fonts stay correct. */
async function exportReceiptPdf(el: HTMLElement, fileName: string) {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas-pro'), import('jspdf')])
  if (document.fonts?.ready) await document.fonts.ready
  const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false })
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageW = pdf.internal.pageSize.getWidth()
  const pageH = pdf.internal.pageSize.getHeight()
  const margin = 10
  const imgW = pageW - margin * 2
  const imgH = (canvas.height * imgW) / canvas.width
  const data = canvas.toDataURL('image/jpeg', 0.92)
  const usableH = pageH - margin * 2
  let offset = 0
  // split long receipts across pages
  while (offset < imgH) {
    if (offset > 0) pdf.addPage()
    pdf.addImage(data, 'JPEG', margin, margin - offset, imgW, imgH)
    offset += usableH
  }
  pdf.save(fileName)
}

export function Receipt({ order }: { order: Order }) {
  return (
    <div className="receipt">
      <div className="receipt-head">
        <div>
          <strong>{SHOP_NAME}</strong>
          <small>ใบเสร็จรับเงิน / Receipt</small>
        </div>
        <div className="receipt-meta">
          <span>เลขที่: {order.id}</span>
          <span>วันที่: {formatDateTime(order.createdAt)}</span>
        </div>
      </div>
      <div className="receipt-parties">
        <span>ลูกค้า: <b>{order.customer}</b></span>
      </div>
      <table className="receipt-table">
        <thead>
          <tr>
            <th>#</th>
            <th>รายการ</th>
            <th className="num">จำนวน</th>
            <th className="num">ราคา/หน่วย</th>
            <th className="num">รวม</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((i, idx) => (
            <tr key={`${i.id}-${i.unit}-${idx}`}>
              <td>{idx + 1}</td>
              <td>{i.name}</td>
              <td className="num">{money(i.qty)} {unitLabel(i.unit)}</td>
              <td className="num">฿{money(i.price)}</td>
              <td className="num">฿{money(i.price * i.qty)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="receipt-total">
        <span>ยอดรวมทั้งสิ้น</span>
        <strong>฿{money(order.total)}</strong>
      </div>
      <p className="receipt-thanks">ขอบคุณที่ใช้บริการ</p>
    </div>
  )
}

export function OrderDetailModal({
  order,
  customerTotals,
  justCreated,
  onClose,
  onDelete,
}: {
  order: Order
  customerTotals?: { orders: number; revenue: number; profit: number }
  justCreated?: boolean
  onClose: () => void
  onDelete?: (o: Order) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const margin = order.total > 0 ? (order.profit / order.total) * 100 : 0

  const download = async () => {
    if (!ref.current) return
    setBusy(true)
    try {
      await exportReceiptPdf(ref.current, `bill-${order.id}.pdf`)
    } catch (e) {
      console.error(e)
      alert('ไม่สามารถสร้างไฟล์ PDF ได้ กรุณาลองใหม่')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <span className="section-kicker">{justCreated ? 'ORDER SAVED' : 'ORDER DETAIL'}</span>
            <h2>{justCreated ? 'บันทึกออเดอร์เรียบร้อย' : 'รายละเอียดออเดอร์'}</h2>
          </div>
          <button onClick={onClose} aria-label="ปิด"><X /></button>
        </div>

        <div className="summary-grid">
          <div><span>ยอดขาย</span><strong>฿{money(order.total)}</strong></div>
          <div><span>ต้นทุน</span><strong>฿{money(order.cost)}</strong></div>
          <div className={order.profit >= 0 ? 'positive' : 'negative'}><span>กำไรสุทธิ</span><strong>฿{money(order.profit)}</strong><small>{money(margin)}%</small></div>
        </div>
        {customerTotals && (
          <p className="muted customer-totals">
            ยอดสะสมของ <b>{order.customer}</b>: {customerTotals.orders} ออเดอร์ · ยอดขาย ฿{money(customerTotals.revenue)} · กำไร ฿{money(customerTotals.profit)}
          </p>
        )}

        <div className="receipt-wrap">
          <div ref={ref}><Receipt order={order} /></div>
        </div>

        <div className="modal-actions">
          {onDelete && (
            <button className="secondary danger" onClick={() => onDelete(order)}><Trash2 size={16} /> ลบออเดอร์</button>
          )}
          <button className="secondary" onClick={onClose}>ปิด</button>
          <button className="primary" onClick={download} disabled={busy}><FileDown size={17} /> {busy ? 'กำลังสร้าง PDF...' : 'ดาวน์โหลดบิล PDF'}</button>
        </div>
      </div>
    </div>
  )
}
