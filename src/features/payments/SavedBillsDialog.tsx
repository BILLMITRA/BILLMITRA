import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { SavedOrder } from '../../../shared/domain'
import { formatMoney } from '../../../shared/billing'
import './payments.css'

export function SavedBillsDialog({ orders, onClose, onSelect }: { orders: SavedOrder[]; onClose: () => void; onSelect: (order: SavedOrder) => void }) {
  const [search, setSearch] = useState('')
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    close.current?.focus()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('keydown', escape); previous?.focus() }
  }, [onClose])
  const visible = orders.filter(order => `#${order.orderNumber} ${order.savedTableName} ${order.savedTableFloor} ${order.savedBy}`.toLowerCase().includes(search.trim().toLowerCase()))
  return <div className="history-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="saved-bills-title">
      <header className="history-heading"><div><span className="eyebrow">AWAITING CASHIER</span><h2 id="saved-bills-title">Saved Bills ({orders.length})</h2><p>Tables released by waiters. These bills still need payment.</p></div><button ref={close} className="history-close" aria-label="Close saved bills" onClick={onClose}><X size={18} /></button></header>
      <label className="history-search"><input aria-label="Search saved bills" placeholder="Search bill, table, floor or waiter" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className="history-list">{!visible.length && <p className="history-empty">No saved bills awaiting payment.</p>}{visible.map(order => <article className="history-row" key={order.id}>
        <div className="history-row-main"><div className="history-row-title"><strong>Bill #{order.orderNumber} · Table {order.savedTableName}</strong><span className="history-status unpaid">Payment due</span></div><span>{order.savedTableFloor} · Saved by {order.savedBy}</span><small>{order.savedAt ? new Date(`${order.savedAt.replace(' ', 'T')}Z`).toLocaleString('en-IN') : ''}</small><small>{order.items.reduce((sum, line) => sum + line.quantity, 0)} items · {order.items.map(line => `${line.quantity} × ${line.productName}`).join(', ')}</small></div>
        <div className="history-row-end"><strong>{formatMoney(order.totalPaise)}</strong><button onClick={() => onSelect(order)}>Open / Close bill</button></div>
      </article>)}</div><footer className="history-footer">Open a bill to review its items and record payment. Saving a bill does not mark it paid.</footer>
    </section>
  </div>
}
