import { useMemo, useState } from 'react'
import { CopyPlus, Minus, Plus, X } from 'lucide-react'
import type { SavedOrder, SplitOrderInput } from '../../../shared/domain'
import { formatMoney } from '../../../shared/billing'
import './splitBill.css'

type Props = {
  order: SavedOrder
  onClose: () => void
  onSplit: (input: SplitOrderInput) => Promise<void>
}

export function SplitBillDialog({ order, onClose, onSplit }: Props) {
  const [quantities, setQuantities] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selected = useMemo(() => order.items.flatMap(item => {
    const quantity = quantities[item.id] ?? 0
    return quantity ? [{ item, quantity }] : []
  }), [order.items, quantities])
  const selectedCount = selected.reduce((total, entry) => total + entry.quantity, 0)
  const totalCount = order.items.reduce((total, item) => total + item.quantity, 0)
  const selectedValue = selected.reduce((total, entry) => total + entry.item.unitPricePaise * entry.quantity, 0)

  function change(id: string, max: number, delta: number): void {
    setQuantities(current => ({ ...current, [id]: Math.max(0, Math.min(max, (current[id] ?? 0) + delta)) }))
    setError('')
  }

  async function submit(): Promise<void> {
    if (!selected.length || selectedCount >= totalCount) {
      setError('Move at least one item, and leave at least one item on the original bill.')
      return
    }
    if (!window.confirm(`Create a separate bill with ${selectedCount} item${selectedCount === 1 ? '' : 's'}? Both bills will remain unpaid and editable.`)) return
    setBusy(true); setError('')
    try {
      await onSplit({ requestId: crypto.randomUUID(), orderId: order.id, items: selected.map(({ item, quantity }) => ({ itemId: item.id, quantity })) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The bill could not be split.')
    } finally { setBusy(false) }
  }

  return <div className="split-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="split-dialog" role="dialog" aria-modal="true" aria-labelledby="split-bill-title">
      <header><span className="split-icon"><CopyPlus size={20} /></span><button aria-label="Close" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <h2 id="split-bill-title">Split bill #{order.orderNumber}</h2>
      <p>Choose the quantities that should move to a new independent bill. Existing prices and the bill discount are apportioned automatically.</p>
      <div className="split-lines">
        {order.items.map(item => {
          const quantity = quantities[item.id] ?? 0
          return <div className="split-line" key={item.id}><div><b>{item.productName}</b><small>On bill: {item.quantity} × {formatMoney(item.unitPricePaise)}</small></div><div className="split-stepper"><button onClick={() => change(item.id, item.quantity, -1)} disabled={busy || quantity === 0} aria-label={`Move one fewer ${item.productName}`}><Minus size={14} /></button><b>{quantity}</b><button onClick={() => change(item.id, item.quantity, 1)} disabled={busy || quantity === item.quantity} aria-label={`Move one more ${item.productName}`}><Plus size={14} /></button></div></div>
        })}
      </div>
      <div className="split-summary"><span>New bill</span><b>{selectedCount} items · {formatMoney(selectedValue)}</b></div>
      {error && <p className="split-error" role="alert">{error}</p>}
      <footer><button onClick={onClose} disabled={busy}>Cancel</button><button className="split-submit" onClick={() => void submit()} disabled={busy || !selected.length}>{busy ? 'Splitting…' : 'Create split bill'}</button></footer>
    </section>
  </div>
}
