import { useState } from 'react'
import { ShieldCheck, Wallet, X } from 'lucide-react'
import type { SavedOrder } from '../../../shared/domain'
import { formatOrderReference } from '../../../shared/domain'
import { formatMoney } from '../billing'
import '../security/security.css'

type Props = {
  order: SavedOrder
  balancePaise: number
  onClose: () => void
  onConfirm: (pin: string) => Promise<void>
}

export function DeliveryCashOutDialog({ order, balancePaise, onClose, onConfirm }: Props) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(): Promise<void> {
    setError('')
    if (!/^\d{4,12}$/.test(pin)) {
      setError('Enter the manager PIN with 4 to 12 digits.')
      return
    }
    setSaving(true)
    try { await onConfirm(pin) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Cash-out could not be completed.') }
    finally { setSaving(false) }
  }

  return <div className="manager-action-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !saving) onClose()
  }}>
    <section className="manager-action-dialog" role="dialog" aria-modal="true" aria-labelledby="delivery-cash-out-title">
      <header><span className="manager-action-icon"><Wallet size={20} /></span>
        <button className="manager-action-close" aria-label="Close" onClick={onClose} disabled={saving}><X size={18} /></button></header>
      <h2 id="delivery-cash-out-title">Cash out {formatOrderReference(order)}</h2>
      <p>Bill #{order.orderNumber} · {order.customerName || 'Delivery customer'}. Manager approval closes this HD card and marks the delivery complete.</p>
      <div className="delivery-cash-out-amount">
        <span>{balancePaise > 0 ? 'Cash to receive' : 'Payment already recorded'}</span>
        <strong>{formatMoney(balancePaise)}</strong>
      </div>
      <p>{balancePaise > 0
        ? 'Confirm you have received this exact cash amount. If the rider has the cash, use rider settlement instead.'
        : 'No additional cash will be recorded. This action only closes the HD card.'}</p>
      <form onSubmit={event => { event.preventDefault(); void submit() }}>
        <label className="manager-action-field"><span>Manager PIN</span>
          <input type="password" inputMode="numeric" autoComplete="off" maxLength={12} autoFocus
            value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, ''))}
            placeholder="4 to 12 digits" disabled={saving} /></label>
        {error && <div className="manager-action-error" role="alert">{error}</div>}
        <footer><button type="button" className="manager-action-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="manager-action-submit" disabled={saving}>
            <ShieldCheck size={15} /> {saving ? 'Closing…' : 'Confirm cash out'}</button></footer>
      </form>
      <small className="manager-action-security-note">Five incorrect PIN attempts lock the PIN for five minutes. Cash-out is recorded in the audit log.</small>
    </section>
  </div>
}
