import { Printer, X } from 'lucide-react'
import { formatOrderReference, type SavedOrder } from '../../../shared/domain'
import './kitchen.css'

type KitchenTicketPreviewProps = {
  order: SavedOrder
  tableLabel: string
  duplicate: boolean
  onClose: () => void
}

export function KitchenTicketPreview({ order, tableLabel, duplicate, onClose }: KitchenTicketPreviewProps) {
  return (
    <div className="kot-backdrop print-document-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="kot-dialog print-document-dialog" role="dialog" aria-modal="true" aria-labelledby="kot-title">
        <header className="kot-actions print-document-actions">
          <span>{duplicate ? 'Duplicate kitchen ticket' : 'Kitchen order ticket'} · {formatOrderReference(order)}</span>
          <div>
            <button onClick={() => window.print()}><Printer size={15} />{duplicate ? 'Print duplicate' : 'Print KOT'}</button>
            <button aria-label="Close kitchen ticket preview" onClick={onClose}><X size={17} /></button>
          </div>
        </header>
        <article className="kot-paper print-document-paper">
          <header>
            <span>{duplicate ? 'KITCHEN · DUPLICATE' : 'KITCHEN ORDER TICKET'}</span>
            <h1 id="kot-title">{tableLabel}</h1>
            <p>Order {formatOrderReference(order)} · {new Date(`${order.createdAt.replace(' ', 'T')}Z`).toLocaleString('en-IN')}</p>
            {order.type === 'delivery' && order.customerName && <p>Customer: {order.customerName}{order.contactNumber ? ` · ${order.contactNumber}` : ''}</p>}
            {order.type === 'delivery' && order.deliveryAddress && <p>{order.deliveryAddress}</p>}
            {order.type === 'delivery' && order.deliveryArea && <p>Area: {order.deliveryArea}</p>}
            {order.type === 'delivery' && order.deliveryLandmark && <p>Landmark: {order.deliveryLandmark}</p>}
            {order.type === 'delivery' && order.deliveryInstructions && <p>Delivery instructions: {order.deliveryInstructions}</p>}
            {order.type === 'delivery' && order.scheduledDeliveryAt && <p>Promised delivery: {new Date(order.scheduledDeliveryAt).toLocaleString('en-IN')}</p>}
            {order.type === 'delivery' && order.assignedDeliveryTo && <p>Delivery assigned to: {order.assignedDeliveryTo}</p>}
          </header>
          <ul>
            {order.items.map((item) => (
              <li key={item.id}>
                <b>{item.quantity} ×</b>
                <span>{item.productName}{item.note && <small>{item.note}</small>}</span>
              </li>
            ))}
          </ul>
          <footer>{duplicate ? 'Duplicate ticket' : 'New order'} · No prices shown</footer>
        </article>
      </section>
    </div>
  )
}
