import { useEffect, useRef, useState } from 'react'
import { Printer, X } from 'lucide-react'
import type { RestaurantTable } from '../../../shared/domain'
import type { OrderPrintDetails, PrinterSettings, PrintKind } from '../../../shared/printing'
import { formatMoney } from '../../../shared/billing'

export function TablePrintDialog({ table, kind, onClose }: { table: RestaurantTable; kind: PrintKind; onClose: () => void }) {
  const bridge = window.desktopPrinting!
  const [details, setDetails] = useState<OrderPrintDetails | null>(null)
  const [settings, setSettings] = useState<PrinterSettings | null>(null)
  const [ticketId, setTicketId] = useState('')
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let active = true, loading = false
    const refresh = async () => {
      if (loading || sending.current) return
      loading = true
      try { const value = await bridge.getOrderDetails(table.orderId!); if (active) { setDetails(value); setLoadError('') } }
      catch (cause) { if (active) setLoadError(cause instanceof Error ? cause.message : 'Cannot read the saved order.') }
      finally { loading = false }
    }
    const previousFocus = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    void refresh()
    void bridge.getState().then(value => { if (active) setSettings(value.settings) }).catch(() => {})
    const timer = setInterval(() => void refresh(), 3000)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !sending.current) onClose() }
    document.addEventListener('keydown', escape)
    return () => { active = false; clearInterval(timer); document.removeEventListener('keydown', escape); previousFocus?.focus() }
  }, [bridge, table.orderId, onClose])
  const tickets = details?.kitchenTickets ?? []
  const selectedTicket = tickets.some(ticket => ticket.id === ticketId) ? ticketId : tickets.at(-1)?.id ?? ''
  const pending = details?.pendingRequests.some(input => input.kind === kind && (input.ticketId ?? '') === (kind === 'kot' ? selectedTicket : '')) ?? false
  const prior = details?.jobs.some(job => job.kind === kind && (job.ticketId ?? '') === (kind === 'kot' ? selectedTicket : '') && job.status !== 'failed') ?? false
  async function request() {
    if (!details || sending.current || (kind === 'kot' && !selectedTicket)) return
    if (prior && !pending && !window.confirm('A request already exists. Check the printer and queue before printing another copy. Continue?')) return
    sending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const job = await bridge.request({ orderId: details.order.id, kind, ...(kind === 'kot' ? { ticketId: selectedTicket } : {}) })
      setDetails(current => current ? { ...current, jobs: [job, ...current.jobs.filter(item => item.id !== job.id)], pendingRequests: current.pendingRequests.filter(input => input.requestId !== job.id) } : current)
      setNotice(job.status === 'queued' ? 'Saved in the print queue. The configured desktop printer will receive it.' : `${job.status}: ${job.error || 'Print request accepted.'}`)
      try { setDetails(await bridge.getOrderDetails(details.order.id)) }
      catch { setLoadError('Print request accepted. Waiting to refresh its status from the server.') }
    } catch (cause) { setError(`${cause instanceof Error ? cause.message : 'Print request failed.'} Retry uses the saved request ID.`) }
    finally { sending.current = false; setBusy(false) }
  }
  const order = details?.order
  return <div className="print-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="print-settings table-print-dialog" role="dialog" aria-modal="true" aria-labelledby="table-print-title">
    <header><h2 id="table-print-title">{kind === 'bill' ? 'Print Bill' : 'Print KOT'} · Table {table.name}</h2><button ref={closeButton} aria-label="Close table printing" onClick={onClose} disabled={busy}><X size={18} /></button></header>
    <p>{table.floor}{order ? ` · Order #${order.orderNumber}` : ''} · Saved items only</p>
    {loadError && <p role="alert" className="management-error">{loadError}</p>}{error && <p role="alert" className="management-error">{error}</p>}{notice && <p role="status" className="management-notice">{notice}</p>}
    {!details && !loadError && <p>Loading saved order…</p>}
    {details && <>
      {kind === 'kot' ? <><label>Kitchen batch<select value={selectedTicket} disabled={busy} onChange={event => { setTicketId(event.target.value); setNotice(''); setError('') }}>{tickets.map((ticket, index) => <option key={ticket.id} value={ticket.id}>Batch {index + 1}{index === tickets.length - 1 ? ' · latest' : ''} · {ticket.createdAt} UTC</option>)}</select></label><p>Only the selected batch will print. Prices are omitted from KOTs.</p></> : <><p>{order!.items.reduce((sum, item) => sum + item.quantity, 0)} saved items · Total {formatMoney(order!.totalPaise)}</p><p>Printing the bill does not record payment.</p></>}
      <p>Printer: <b>{settings?.[kind] || 'Not configured — requests stay queued'}</b></p>
      <button className="send-table-print" disabled={busy || !!loadError || (kind === 'kot' && !selectedTicket)} onClick={() => void request()}><Printer size={16} />{busy ? 'Sending…' : pending ? 'Retry print request' : prior ? 'Print another copy' : kind === 'bill' ? 'Send bill to printer' : 'Send KOT to printer'}</button>
      {!!details.jobs.length && <><h3>Print status</h3><ul>{details.jobs.slice(0, 6).map(job => <li key={job.id}><b>{job.kind.toUpperCase()}{job.copy ? ' copy' : ''}</b> · {job.status}{job.error && <p>{job.error}</p>}</li>)}</ul></>}
      <p>Submitted means the desktop printer system accepted the job. Check paper output before requesting another copy.</p>
    </>}
  </section></div>
}
