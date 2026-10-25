import { useState } from 'react'
import { GitMerge, X } from 'lucide-react'
import type { JoinOrdersInput, SavedOrder } from '../../../shared/domain'
import { formatMoney } from '../../../shared/billing'
import './splitBill.css'

export function JoinBillDialog({ order, candidates, onClose, onJoin }: { order: SavedOrder; candidates: SavedOrder[]; onClose: () => void; onJoin: (input: JoinOrdersInput) => Promise<void> }) {
  const [selectedId, setSelectedId] = useState(candidates[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(): Promise<void> {
    if (!selectedId) return setError('Select another active table bill.')
    const other = candidates.find(candidate => candidate.id === selectedId)
    if (!other || !window.confirm(`Join bill #${order.orderNumber} and bill #${other.orderNumber}? The source bills remain in history and one combined bill will be created.`)) return
    setBusy(true); setError('')
    try { await onJoin({ requestId: crypto.randomUUID(), orderIds: [order.id, other.id] }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The bills could not be joined.') }
    finally { setBusy(false) }
  }
  return <div className="split-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="split-dialog" role="dialog" aria-modal="true" aria-labelledby="join-bill-title"><header><span className="split-icon"><GitMerge size={20} /></span><button aria-label="Close" onClick={onClose} disabled={busy}><X size={18} /></button></header><h2 id="join-bill-title">Join bill #{order.orderNumber}</h2><p>Choose another active dine-in bill. A new combined bill is created; both original bills stay in history for audit.</p><div className="split-lines">{candidates.length ? candidates.map(candidate => <label className="split-line" key={candidate.id}><span><b>Bill #{candidate.orderNumber} · Table {candidate.tableId === order.tableId ? order.tableId : candidate.tableId}</b><small>{candidate.items.reduce((total, item) => total + item.quantity, 0)} items · {formatMoney(candidate.totalPaise)}</small></span><input type="radio" name="join-bill" checked={selectedId === candidate.id} onChange={() => setSelectedId(candidate.id)} disabled={busy} /></label>) : <p>No other active dine-in bills are available.</p>}</div>{error && <p className="split-error" role="alert">{error}</p>}<footer><button onClick={onClose} disabled={busy}>Cancel</button><button className="split-submit" onClick={() => void submit()} disabled={busy || !selectedId}>{busy ? 'Joining…' : 'Confirm join'}</button></footer></section></div>
}
