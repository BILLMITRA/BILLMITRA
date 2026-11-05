import { useState } from 'react'
import { GitMerge, X } from 'lucide-react'
import type { JoinOrdersInput, RestaurantTable, SavedOrder } from '../../../shared/domain'
import { formatMoney } from '../../../shared/billing'
import './splitBill.css'

export function JoinBillDialog({ orders, selectedOrderId, tables, onClose, onJoin }: {
  orders: SavedOrder[]; selectedOrderId?: string; tables: RestaurantTable[]; onClose: () => void; onJoin: (input: JoinOrdersInput) => Promise<void>
}) {
  const [firstId, setFirstId] = useState(() => orders.find(order => order.id === selectedOrderId)?.id ?? orders[0]?.id ?? '')
  const [secondId, setSecondId] = useState(() => orders.find(order => order.id !== (orders.find(item => item.id === selectedOrderId)?.id ?? orders[0]?.id))?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const first = orders.find(order => order.id === firstId)
  const second = orders.find(order => order.id === secondId && order.id !== firstId)
  const tableName = (order: SavedOrder) => {
    const table = tables.find(item => item.id === order.tableId)
    return table ? `Table ${table.name} · ${table.floor}` : 'Dining table'
  }
  const label = (order: SavedOrder) => `Bill #${order.orderNumber} · ${tableName(order)} · ${formatMoney(order.totalPaise)}`
  async function submit(): Promise<void> {
    if (!first || !second) { setError('Choose two different active dining bills.'); return }
    if (!window.confirm(`Join bill #${first.orderNumber} and bill #${second.orderNumber}? The combined bill will stay on ${tableName(first)}. Both original bills remain in history.`)) return
    setBusy(true); setError('')
    try { await onJoin({ requestId: crypto.randomUUID(), orderIds: [first.id, second.id] }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The bills could not be joined.') }
    finally { setBusy(false) }
  }
  return <div className="split-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="split-dialog" role="dialog" aria-modal="true" aria-labelledby="join-bill-title">
      <header><span className="split-icon"><GitMerge size={20} /></span><button aria-label="Close" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <h2 id="join-bill-title">Join dining bills</h2>
      <p>Choose two unpaid, active dining bills. The combined bill stays on the first table, and the original bills remain in history.</p>
      {orders.length < 2 ? <p role="status">At least two active dining bills are needed. Save another dining order, then try Join again.</p> : <div className="join-bill-fields">
        <label>Keep the combined bill on<select value={firstId} disabled={busy} onChange={event => { const id = event.target.value; setFirstId(id); if (id === secondId) setSecondId(orders.find(item => item.id !== id)?.id ?? ''); setError('') }}>{orders.map(order => <option key={order.id} value={order.id}>{label(order)}</option>)}</select></label>
        <label>Join with<select value={secondId} disabled={busy} onChange={event => { setSecondId(event.target.value); setError('') }}>{orders.filter(order => order.id !== firstId).map(order => <option key={order.id} value={order.id}>{label(order)}</option>)}</select></label>
      </div>}
      {error && <p className="split-error" role="alert">{error}</p>}
      <footer><button onClick={onClose} disabled={busy}>Cancel</button><button className="split-submit" onClick={() => void submit()} disabled={busy || !first || !second}>{busy ? 'Joining…' : 'Confirm join'}</button></footer>
    </section>
  </div>
}
