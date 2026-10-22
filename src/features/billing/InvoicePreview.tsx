import { X } from 'lucide-react'
import { formatMoney } from '../../../shared/billing'
import { formatOrderReference, type PaymentRecord, type SavedOrder } from '../../../shared/domain'
import './invoice.css'

interface InvoicePreviewProps {
  order: SavedOrder
  payment?: PaymentRecord | null
  onClose: () => void
}

export function InvoicePreview({ order, payment = null, onClose }: InvoicePreviewProps) {
  const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0)

  return (
    <div className="invoice-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="invoice-dialog" role="dialog" aria-modal="true" aria-labelledby="invoice-title">
        <div className="invoice-actions">
          <span>Invoice preview</span>
          <div>
            <button onClick={() => window.print()}>Print invoice</button>
            <button aria-label="Close invoice preview" onClick={onClose}><X size={17} /></button>
          </div>
        </div>
        <article className="invoice-paper">
          <header className="invoice-brand">
            <div><b>BillMitra</b><span>Restaurant POS</span></div>
            <small>{order.status === 'voided' ? 'VOIDED BILL' : 'DEMO INVOICE — NOT TAX-CERTIFIED'}</small>
          </header>
          <div className="invoice-title-row">
            <div><span>INVOICE</span><h1 id="invoice-title">BM-{String(order.orderNumber).padStart(6, '0')}</h1></div>
            <div className="invoice-meta"><b>{new Date(`${order.createdAt.replace(' ', 'T')}Z`).toLocaleString('en-IN')}</b><span>{order.type.replace('_', ' ')}</span>{(order.type === 'delivery' || order.type === 'parcel') && <strong>{order.type === 'delivery' ? 'Delivery ref' : 'Takeaway ref'}: {formatOrderReference(order)}</strong>}</div>
          </div>
          {(order.customerName || order.tableId || order.deliveryAddress || order.scheduledDeliveryAt || order.assignedDeliveryTo || order.deliveryArea || order.deliveryLandmark || order.deliveryInstructions) && (
            <div className="invoice-customer">
              {order.customerName && <span>Customer: {order.customerName}</span>}
              {order.contactNumber && <span>Contact: {order.contactNumber}</span>}
              {order.tableId && <span>Table order</span>}
              {order.deliveryAddress && <span>{order.deliveryAddress}</span>}
              {order.deliveryArea && <span>Area: {order.deliveryArea}</span>}
              {order.deliveryLandmark && <span>Landmark: {order.deliveryLandmark}</span>}
              {order.deliveryInstructions && <span>Delivery instructions: {order.deliveryInstructions}</span>}
              {order.scheduledDeliveryAt && <span>Promised delivery: {new Date(order.scheduledDeliveryAt).toLocaleString('en-IN')}</span>}
              {order.assignedDeliveryTo && <span>Delivery assigned to: {order.assignedDeliveryTo}</span>}
            </div>
          )}
          {order.status === 'voided' && <div className="invoice-payment invoice-voided">VOIDED · {order.voidReason || 'No reason recorded'}</div>}
          <table className="invoice-items">
            <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
            <tbody>{order.items.map((item) => (
              <tr key={item.id}>
                <td>{item.productName}{item.note && <small>{item.note}</small>}</td>
                <td>{item.quantity}</td>
                <td>{formatMoney(item.unitPricePaise)}</td>
                <td>{formatMoney(item.unitPricePaise * item.quantity)}</td>
              </tr>
            ))}</tbody>
          </table>
          <div className="invoice-totals">
            <div><span>Items</span><b>{itemCount}</b></div>
            <div><span>Subtotal</span><b>{formatMoney(order.subtotalPaise)}</b></div>
            {order.discountPaise > 0 && <div><span>Discount</span><b>−{formatMoney(order.discountPaise)}</b></div>}
            <div><span>GST (configured demo rates)</span><b>{formatMoney(order.taxPaise)}</b></div>
            <div className="invoice-grand-total"><span>Total due</span><b>{formatMoney(order.totalPaise)}</b></div>
          </div>
          {payment && <div className="invoice-payment">PAID IN FULL · {payment.method.toUpperCase()} · {new Date(`${payment.paidAt.replace(' ', 'T')}Z`).toLocaleString('en-IN')}</div>}
          <footer className="invoice-disclaimer">Demo invoice for testing only. Validate business details, GST treatment, tax rates, and invoice requirements before operational use.</footer>
        </article>
      </section>
    </div>
  )
}
