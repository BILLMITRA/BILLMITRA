import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { CashSummary, InventoryItem, KitchenQueue, StockMovement } from '../../../shared/restaurant'
import { formatOrderReference } from '../../../shared/domain'
import { formatMoney } from '../../../shared/billing'
import { DesktopPrinters } from '../printing/DesktopPrinters'
import '../printing/printing.css'
import { closeCash, getCashSummary, getKitchenQueue, getStockHistory, listInventory, moveStock, saveInventoryItem, updateKitchenStatus } from '../../services/pos'

const message = (error: unknown) => error instanceof Error ? error.message : 'The operation failed.'
function useRequestId() {
  const current = useRef({ key: '', id: '' })
  return { get(key: string) { if (current.current.key !== key || !current.current.id) current.current = { key, id: crypto.randomUUID() }; return current.current.id }, clear() { current.current = { key: '', id: '' } } }
}

export function InventoryPanel() {
  const [items, setItems] = useState<InventoryItem[]>([])
  const [name, setName] = useState('')
  const [unit, setUnit] = useState('kg')
  const [threshold, setThreshold] = useState('0')
  const [selected, setSelected] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [history, setHistory] = useState<StockMovement[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRequestId()
  useEffect(() => { let active = true; listInventory().then(value => { if (active) setItems(value) }).catch(cause => { if (active) setError(message(cause)) }); return () => { active = false } }, [])
  useEffect(() => { let active = true; if (selected) getStockHistory(selected).then(value => { if (active) setHistory(value) }).catch(cause => { if (active) setError(message(cause)) }); return () => { active = false } }, [selected])
  async function add(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('')
    if (!/^\d+(\.\d{1,3})?$/.test(threshold)) { setError('Reorder level requires up to three decimal places.'); return }
    setBusy(true)
    try { await saveInventoryItem({ name, unit, reorderMilli: Math.round(Number(threshold) * 1000) }); setItems(await listInventory()); setName(''); setNotice('Inventory item created.') } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  async function adjust(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('')
    if (!/^-?\d+(\.\d{1,3})?$/.test(amount)) { setError('Use up to three decimal places. Negative amounts record usage or waste.'); return }
    setBusy(true)
    const data = { itemId: selected, deltaMilli: Math.round(Number(amount) * 1000), reason }
    try { await moveStock({ ...data, requestId: request.get(JSON.stringify(data)) }); setItems(await listInventory()); setHistory(await getStockHistory(selected)); request.clear(); setAmount(''); setReason(''); setNotice('Stock adjustment saved.') } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  return <><p>Record stock received, used, wasted, or corrected. Quantities support three decimal places. Recipe-based automatic deductions are not configured.</p>
    {error && <p className="management-error" role="alert">{error}</p>}{notice && <p className="management-notice" role="status">{notice}</p>}
    <div className="management-columns"><section className="management-card"><h2>Stock on hand</h2><table><thead><tr><th>Item</th><th>On hand</th><th>Reorder at</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><button onClick={() => setSelected(item.id)}>{item.name}</button></td><td>{item.quantityMilli / 1000} {item.unit}{item.quantityMilli <= item.reorderMilli && <small>Low stock</small>}</td><td>{item.reorderMilli / 1000} {item.unit}</td></tr>)}</tbody></table></section>
    <div className="management-forms"><form className="management-card" onSubmit={event => void add(event)}><h2>New inventory item</h2><fieldset disabled={busy}><label>Name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><label>Unit (kg, litres, pieces)<input required maxLength={20} value={unit} onChange={event => setUnit(event.target.value)} /></label><label>Reorder level<input required inputMode="decimal" value={threshold} onChange={event => setThreshold(event.target.value)} /></label><button type="submit">Create item</button></fieldset></form>
    <form className="management-card" onSubmit={event => void adjust(event)}><h2>Stock movement</h2><fieldset disabled={busy}><label>Item<select required value={selected} onChange={event => setSelected(event.target.value)}><option value="">Select item</option>{items.map(item => <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}</select></label><label>Quantity change (+received / -used)<input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></label><label>Reason<input required minLength={3} maxLength={250} value={reason} onChange={event => setReason(event.target.value)} /></label><button type="submit">Save adjustment</button></fieldset></form></div></div>
    {selected && <section className="management-card"><h2>Recent movements</h2><table><thead><tr><th>Date</th><th>Change</th><th>Reason</th><th>Staff</th></tr></thead><tbody>{history.filter(row => row.itemId === selected).map(row => <tr key={row.id}><td>{row.createdAt} UTC</td><td>{row.deltaMilli / 1000}</td><td>{row.reason}</td><td>{row.actor}</td></tr>)}</tbody></table></section>}
  </>
}

export function CashClosingPanel() {
  const [summary, setSummary] = useState<CashSummary | null>(null)
  const [opening, setOpening] = useState('0.00')
  const [counted, setCounted] = useState('0.00')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRequestId()
  useEffect(() => { let active = true; getCashSummary().then(value => { if (active) setSummary(value) }).catch(cause => { if (active) setError(message(cause)) }); return () => { active = false } }, [])
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('')
    if (![opening, counted].every(value => /^\d+(\.\d{1,2})?$/.test(value))) { setError('Use non-negative amounts with up to two decimal places.'); return }
    setBusy(true)
    const data = { openingPaise: Math.round(Number(opening) * 100), countedPaise: Math.round(Number(counted) * 100), notes }
    try { await closeCash({ ...data, requestId: request.get(JSON.stringify(data)) }); setSummary(await getCashSummary()); request.clear(); setNotes(''); setOpening('0.00'); setCounted('0.00') } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  return <><p>Close cash receipts since the previous closing. Enter the opening cash held in the drawer and the amount counted. Cash expenses and bank withdrawals are not tracked here.</p>{error && <p className="management-error" role="alert">{error}</p>}
    <div className="management-columns"><form className="management-card" onSubmit={event => void submit(event)}><h2>Close cash drawer</h2>{summary && <p>Cash receipts since last close: <b>{formatMoney(summary.receiptsPaise)}</b></p>}<fieldset disabled={busy || !summary}><label>Opening cash (INR)<input required inputMode="decimal" value={opening} onChange={event => setOpening(event.target.value)} /></label><p>Expected cash: {formatMoney(Math.round(Number(opening || 0) * 100) + (summary?.receiptsPaise ?? 0))}</p><label>Counted cash (INR)<input required inputMode="decimal" value={counted} onChange={event => setCounted(event.target.value)} /></label><label>Notes / reason for variance<textarea maxLength={250} value={notes} onChange={event => setNotes(event.target.value)} /></label><button type="submit">Record cash closing</button></fieldset></form>
    <section className="management-card"><h2>Last closing</h2>{summary?.lastClose ? <dl>{Object.entries({ Date: summary.lastClose.createdAt + ' UTC', Staff: summary.lastClose.actor, Expected: formatMoney(summary.lastClose.expectedPaise), Counted: formatMoney(summary.lastClose.countedPaise), Variance: formatMoney(summary.lastClose.variancePaise), Notes: summary.lastClose.notes }).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl> : <p>No previous closing recorded.</p>}</section></div>
  </>
}

export function KitchenPanel() {
  const [queue, setQueue] = useState<KitchenQueue>({ orders: [] })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = () => getKitchenQueue().then(value => { if (active) { setQueue(value); setError('') } }).catch(cause => { if (active) setError(message(cause)) })
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  async function advance(orderId: string, ticketId: string, status: 'preparing' | 'ready' | 'payment_pending') {
    setBusy(true); setError('')
    try { await updateKitchenStatus({ orderId, ticketId, status }); setQueue(await getKitchenQueue()) } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  return <><DesktopPrinters /><p>Live preparation queue  |  refreshes every five seconds. Payment and preparation are tracked separately.</p>{error && <p role="alert" className="management-error">{error}</p>}
    {queue.orders.length === 0 && <p>No orders waiting in the kitchen.</p>}
    <div className="management-kitchen-grid">{queue.orders.map(order => <article className="management-card" key={order.ticketId}><h2>{formatOrderReference(order)}  |  {order.type.replace('_', ' ')}</h2><p>{order.createdAt} UTC  |  {order.status}</p>{order.tableId && <p>Table: {order.tableId}</p>}<ul>{order.items.map(item => <li key={item.id}><b>{item.quantity} x {item.productName}</b>{item.note && <p>{item.note}</p>}</li>)}</ul><button disabled={busy} onClick={() => void advance(order.id, order.ticketId, order.status === 'ordering' ? 'preparing' : order.status === 'preparing' ? 'ready' : 'payment_pending')}>{order.status === 'ordering' ? 'Start preparation' : order.status === 'preparing' ? 'Mark ready' : 'Mark handed over'}</button></article>)}</div>
  </>
}

