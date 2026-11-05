import { useRef, useState, type FormEvent } from 'react'
import { Wallet } from 'lucide-react'
import type { CashSummary } from '../../../shared/restaurant'
import { formatMoney } from '../../../shared/billing'
import '../security/security.css'

type Props = { summary: CashSummary; onOpen: (requestId: string, openingPaise: number) => Promise<void>; onSignOut: () => Promise<void> }

export function CashOpeningDialog({ summary, onOpen, onSignOut }: Props) {
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const requestId = useRef(crypto.randomUUID())

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) > 10_000_000) {
      setError('Enter an opening amount from 0 to 10,000,000 with up to two decimal places.')
      return
    }
    setBusy(true)
    try { await onOpen(requestId.current, Math.round(Number(amount) * 100)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open the cash drawer.') }
    finally { setBusy(false) }
  }

  return <div className="manager-action-backdrop">
    <section className="manager-action-dialog" role="dialog" aria-modal="true" aria-labelledby="cash-opening-title">
      <header><span className="manager-action-icon"><Wallet size={20} /></span></header>
      <h2 id="cash-opening-title">Opening cash</h2>
      <p>Count the cash already in the drawer at the start of this shift. This amount is saved once and used at Cash closing.</p>
      {summary.receiptsPaise !== 0 && <p>{formatMoney(summary.receiptsPaise)} in cash activity is already recorded since the last closing. Enter the opening amount from that time, not today’s current drawer total.</p>}
      <form onSubmit={event => void submit(event)}>
        <label className="manager-action-field"><span>Opening amount (₹)</span>
          <input required autoFocus inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)}
            placeholder="0.00" disabled={busy} /></label>
        {error && <div className="manager-action-error" role="alert">{error}</div>}
        <footer><button type="button" onClick={() => void onSignOut()} disabled={busy}>Sign out</button>
          <button type="submit" className="manager-action-submit" disabled={busy}>{busy ? 'Saving…' : 'Open cash drawer'}</button></footer>
      </form>
    </section>
  </div>
}
