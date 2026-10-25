import { Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatOrderReference, type SavedOrder } from '../../../shared/domain'
import { formatMoney } from '../../../shared/billing'
import './splitBill.css'

export function RecallBillDialog({ orders, onClose, onRecall }: { orders: SavedOrder[]; onClose: () => void; onRecall: (order: SavedOrder) => void }) {
  const [search, setSearch] = useState('')
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    return !query ? orders : orders.filter(order => `#${order.orderNumber} ${order.tableId ?? ''} ${order.items.map(item => item.productName).join(' ')}`.toLowerCase().includes(query))
  }, [orders, search])
  return <div className="split-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="split-dialog" role="dialog" aria-modal="true" aria-labelledby="recall-bill-title"><header><span className="split-icon"><Search size={20} /></span><button aria-label="Close" onClick={onClose}><X size={18} /></button></header><h2 id="recall-bill-title">Recall bill</h2><p>Select an unpaid dine-in, takeaway, or home-delivery bill to continue editing, printing, or payment.</p><label className="manager-action-field"><span>Find bill or item</span><input autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Bill number, table, HD/P number, or item" /></label><div className="split-lines">{visible.length ? visible.map(order => <button className="split-line recall-bill-row" key={order.id} onClick={() => onRecall(order)}><span><b>Bill #{order.orderNumber} · {formatOrderReference(order)}</b><small>{order.type === 'dine_in' ? `Table ${order.tableId ?? '—'}` : order.type === 'delivery' ? `Delivery · ${order.customerName || 'Customer pending'}` : `Takeaway · ${order.customerName || 'Guest pending'}`} · {order.items.reduce((total, item) => total + item.quantity, 0)} items</small></span><strong>{formatMoney(order.totalPaise)}</strong></button>) : <p>No active bills match.</p>}</div><footer><button onClick={onClose}>Close</button></footer></section></div>
}
