import { useState } from 'react'
import { Ban, Minus, Plus, X } from 'lucide-react'
import type { SavedOrder } from '../../../shared/domain'
import { formatMoney } from '../../../shared/billing'
import './security.css'

type ItemVoidDialogProps = {
  order: SavedOrder
  onClose: () => void
  onVoid: (itemId: string, quantity: number, pin: string, reason: string) => Promise<void>
}

export function ItemVoidDialog({ order, onClose, onVoid }: ItemVoidDialogProps) {
  const [itemId, setItemId] = useState(order.items[0]?.id ?? '')
  const [quantity, setQuantity] = useState(1)
  const [pin, setPin] = useState('')
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const item = order.items.find(line => line.id === itemId) ?? null

  async function submit(): Promise<void> {
    setError('')
    if (!item) return setError('Select an item to void.')
    if (quantity < 1 || quantity > item.quantity) return setError('Choose a quantity available on this bill.')
    if (!/^\d{4,12}$/.test(pin)) return setError('Enter a manager PIN with 4 to 12 digits.')
    if (reason.trim().length < 3) return setError('Enter a reason for voiding this item.')
    if (!confirmed) return setError('Confirm that this item quantity should be voided.')
    setSaving(true)
    try { await onVoid(item.id, quantity, pin, reason.trim()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Item could not be voided.') }
    finally { setSaving(false) }
  }

  return <div className="manager-action-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !saving) onClose()
  }}>
    <section className="manager-action-dialog" role="dialog" aria-modal="true" aria-labelledby="item-void-title">
      <header><span className="manager-action-icon void"><Ban size={20} /></span><button className="manager-action-close" aria-label="Close" onClick={onClose} disabled={saving}><X size={18} /></button></header>
      <h2 id="item-void-title">Void item · Bill #{order.orderNumber}</h2>
      <p>Select the item and quantity to remove. The original item and reason are kept in the audit history.</p>
      <label className="manager-action-field"><span>Item</span><select value={itemId} onChange={event => { setItemId(event.target.value); setQuantity(1); setConfirmed(false) }} disabled={saving}>
        {order.items.map(line => <option key={line.id} value={line.id}>{line.productName} · {line.quantity} × {formatMoney(line.unitPricePaise)}</option>)}
      </select></label>
      {item && <div className="item-void-summary"><b>{item.productName}</b><span>On bill: {item.quantity} · void value: {formatMoney(item.unitPricePaise * quantity)}</span></div>}
      <div className="item-void-quantity"><span>Quantity to void</span><button onClick={() => setQuantity(value => Math.max(1, value - 1))} disabled={saving || quantity <= 1}><Minus size={14} /></button><b>{quantity}</b><button onClick={() => setQuantity(value => Math.min(item?.quantity ?? 1, value + 1))} disabled={saving || !item || quantity >= item.quantity}><Plus size={14} /></button></div>
      <label className="manager-action-field"><span>Manager PIN</span><input type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, ''))} placeholder="4–12 digits" disabled={saving} /></label>
      <label className="manager-action-field"><span>Reason for void</span><textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={250} rows={3} placeholder="For example, customer cancelled one portion" disabled={saving} /></label>
      <label className="item-void-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={saving} /> I confirm this quantity should be voided.</label>
      {error && <div className="manager-action-error" role="alert">{error}</div>}
      <footer><button className="manager-action-cancel" onClick={onClose} disabled={saving}>Cancel</button><button className="manager-action-submit void" onClick={() => void submit()} disabled={saving || !confirmed}>{saving ? 'Voiding…' : 'Confirm item void'}</button></footer>
    </section>
  </div>
}
