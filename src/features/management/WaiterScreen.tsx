import { useEffect, useRef, useState } from 'react'
import type { MenuData, StaffIdentity } from '../../../shared/domain'
import { createOrder, getWaiterMenu } from '../../services/pos'
import { formatMoney } from '../../../shared/billing'
import './management.css'

export function WaiterScreen({ staff, onClose }: { staff: StaffIdentity; onClose: () => void }) {
  const [menu, setMenu] = useState<MenuData | null>(null)
  const [tableId, setTableId] = useState('')
  const [query, setQuery] = useState('')
  const [cart, setCart] = useState<{ productId: string; quantity: number; note: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const pending = useRef<{ key: string; id: string }>({ key: '', id: '' })
  useEffect(() => { let active = true; getWaiterMenu().then(value => { if (active) setMenu(value) }).catch(cause => { if (active) setError(String(cause)) }); return () => { active = false } }, [])
  const existing = menu?.activeOrders.find(order => order.tableId === tableId)
  async function send() {
    if (!cart.length || !tableId) return
    setError(''); setNotice(''); setBusy(true)
    const data = { type: 'dine_in' as const, tableId, customerName: existing?.customerName ?? '', deliveryAddress: '',
      discount: existing?.discount ?? null, items: cart, ...(existing ? { orderId: existing.id } : {}) }
    const key = JSON.stringify(data)
    if (pending.current.key !== key) pending.current = { key, id: crypto.randomUUID() }
    try {
      await createOrder({ ...data, requestId: pending.current.id })
      setMenu(await getWaiterMenu()); setCart([]); pending.current = { key: '', id: '' }; setNotice('Order sent to the kitchen.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Order could not be saved. Retry with the same items.') } finally { setBusy(false) }
  }
  function add(productId: string) {
    setCart(current => current.some(line => line.productId === productId) ? current.map(line => line.productId === productId ? { ...line, quantity: Math.min(99, line.quantity + 1) } : line) : [...current, { productId, quantity: 1, note: '' }])
  }
  return <main className="management-shell"><header className="management-header"><div><span>BillMitra · {staff.displayName}</span><h1>Waiter table ordering</h1></div><button disabled={busy} onClick={onClose}>{staff.role === 'waiter' ? 'Sign out' : 'Close'}</button></header>
    {error && <p className="management-error" role="alert">{error}</p>}{notice && <p className="management-notice" role="status">{notice}</p>}
    {!menu ? <p>Loading tables…</p> : <><label>Table<select value={tableId} disabled={busy || cart.length > 0} onChange={event => { setTableId(event.target.value); setNotice('') }}><option value="">Choose table</option>{menu.tables.map(table => <option key={table.id} value={table.id}>{table.floor} · {table.name} · {table.orderId ? 'Open order' : 'Available'}</option>)}</select></label>
      <div className="management-columns"><section className="management-card"><h2>Menu</h2><label>Find an item<input value={query} onChange={event => setQuery(event.target.value)} /></label><div className="management-waiter-menu">{menu.products.filter(product => product.available && product.name.toLowerCase().includes(query.toLowerCase())).map(product => <button disabled={!tableId || busy} key={product.id} onClick={() => add(product.id)}><b>{product.name}</b><span>{formatMoney(product.pricePaise)}</span></button>)}</div></section>
      <section className="management-card"><h2>Table order</h2>{existing && <><h3>Already sent</h3><ul>{existing.items.map(item => <li key={item.id}>{item.quantity} × {item.productName}{item.note && ` · ${item.note}`}</li>)}</ul></>}
        <h3>New items</h3>{cart.map((line, index) => <div className="management-card" key={line.productId}><b>{menu.products.find(product => product.id === line.productId)?.name}</b><fieldset disabled={busy}><label>Quantity<input type="number" min={1} max={99} value={line.quantity} onChange={event => setCart(current => current.map((item, position) => position === index ? { ...item, quantity: Number(event.target.value) } : item))} /></label><label>Kitchen note<input maxLength={200} value={line.note} onChange={event => setCart(current => current.map((item, position) => position === index ? { ...item, note: event.target.value } : item))} /></label><button onClick={() => setCart(current => current.filter((_, position) => position !== index))}>Remove</button></fieldset></div>)}
        <button disabled={busy || !tableId || !cart.length} onClick={() => void send()}>{busy ? 'Sending…' : 'Send new items to kitchen'}</button>
      </section></div></>}
  </main>
}
