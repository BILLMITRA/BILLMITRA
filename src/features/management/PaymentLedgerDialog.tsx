import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { PaymentMethod } from '../../../shared/domain'
import type { PaymentLedger } from '../../../shared/restaurant'
import { formatMoney } from '../../../shared/billing'
import { collectPayment, getPaymentLedger, refundPayment } from '../../services/pos'
import './management.css'

export function PaymentLedgerDialog({ orderId, canRefund, onClose }: { orderId: string; canRefund: boolean; onClose: () => void }) {
  const [ledger, setLedger] = useState<PaymentLedger | null>(null)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [tenderId, setTenderId] = useState('')
  const [refundAmount, setRefundAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef({ key: '', id: '' })
  useEffect(() => { let active = true; getPaymentLedger(orderId).then(value => { if (active) setLedger(value) }).catch(cause => { if (active) setError(String(cause)) }); return () => { active = false } }, [orderId])
  function requestId(key: string) { if (pending.current.key !== key) pending.current = { key, id: crypto.randomUUID() }; return pending.current.id }
  async function submit(event: FormEvent, refund = false) {
    event.preventDefault(); setError('')
    const value = refund ? refundAmount : amount
    if (!/^\d+(\.\d{1,2})?$/.test(value) || Number(value) <= 0) { setError('Enter a positive amount with up to two decimal places.'); return }
    setBusy(true)
    try {
      if (refund) {
        const input = { tenderId, amountPaise: Math.round(Number(value) * 100), reason }
        setLedger(await refundPayment({ ...input, requestId: requestId('refund:' + JSON.stringify(input)) })); setRefundAmount(''); setReason('')
      } else {
        const input = { orderId, method, amountPaise: Math.round(Number(value) * 100) }
        setLedger(await collectPayment({ ...input, requestId: requestId('collect:' + JSON.stringify(input)) })); setAmount('')
      }
      pending.current = { key: '', id: '' }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Payment record could not be saved.') } finally { setBusy(false) }
  }
  return <main className="management-shell"><header className="management-header"><div><span>BillMitra</span><h1>Payments and refunds</h1></div><button disabled={busy} onClick={onClose}>Close</button></header>
    <p>Record money received or returned through cash, UPI, or an external card terminal. These actions save records; they do not charge or refund a payment provider.</p>
    {error && <p className="management-error" role="alert">{error}</p>}
    {ledger && <><div className="management-metrics">{[['Bill total', ledger.totalPaise], ['Collected', ledger.collectedPaise], ['Refunded', ledger.refundedPaise], ['Balance due', ledger.balancePaise]].map(([label, value]) => <article key={label}><span>{label}</span><b>{formatMoney(value as number)}</b></article>)}</div>
      <p>{ledger.settled ? 'Settled bill. Refunds keep the original invoice and payment history intact.' : 'Payments can be split across multiple methods. The bill settles when the remaining balance reaches zero.'}</p>
      <div className="management-columns"><section className="management-card"><h2>Payment history</h2><table><thead><tr><th>Date (UTC)</th><th>Method</th><th>Received</th><th>Refunded</th></tr></thead><tbody>{ledger.tenders.map(tender => <tr key={tender.id}><td>{tender.createdAt}</td><td>{tender.method.toUpperCase()}</td><td>{formatMoney(tender.amountPaise)}</td><td>{formatMoney(ledger.refunds.filter(refund => refund.tenderId === tender.id).reduce((sum, refund) => sum + refund.amountPaise, 0))}</td></tr>)}</tbody></table>
        <h2>Refund history</h2>{ledger.refunds.map(refund => <p key={refund.id}>{formatMoney(refund.amountPaise)} · {refund.reason} · {refund.actor} · {refund.createdAt} UTC</p>)}</section>
      <div className="management-forms">{!ledger.settled && ledger.balancePaise > 0 && <form className="management-card" onSubmit={event => void submit(event)}><h2>Record a payment</h2><fieldset disabled={busy}><label>Amount (₹)<input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></label><label>Method<select value={method} onChange={event => setMethod(event.target.value as PaymentMethod)}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">External card terminal</option></select></label><button type="submit">Record payment</button></fieldset></form>}
        {canRefund && <form className="management-card" onSubmit={event => void submit(event, true)}><h2>Record a refund</h2><fieldset disabled={busy}><label>Original payment<select required value={tenderId} onChange={event => setTenderId(event.target.value)}><option value="">Select original payment</option>{ledger.tenders.map(tender => <option key={tender.id} value={tender.id}>{tender.method.toUpperCase()} · {formatMoney(tender.amountPaise)} · {tender.createdAt}</option>)}</select></label><label>Amount returned (₹)<input required inputMode="decimal" value={refundAmount} onChange={event => setRefundAmount(event.target.value)} /></label><label>Reason<input required minLength={3} maxLength={250} value={reason} onChange={event => setReason(event.target.value)} /></label><button type="submit">Record refund</button></fieldset></form>}
      </div></div></>}
  </main>
}
