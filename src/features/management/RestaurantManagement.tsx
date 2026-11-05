import { useEffect, useState, type FormEvent } from 'react'
import type { Product, StaffIdentity, RestaurantTable } from '../../../shared/domain'
import type { MenuCatalog, ProductInput, SalesReport } from '../../../shared/restaurant'
import { staffHasPermission } from '../../../shared/staffPermissions'
import { formatMoney } from '../../../shared/billing'
import { addTable, getMenuCatalog, getSalesReport, loadMenu, saveCardSettings, saveCategory, saveProduct } from '../../services/pos'
import './management.css'
import { CashClosingPanel, InventoryPanel, KitchenPanel } from './OperationsPanels'
import { BackupsPanel } from './BackupsPanel'
import { CardShortcutSettings } from '../shortcuts/CardShortcutSettings'
import type { CardShortcuts } from '../shortcuts/cardShortcuts'
import { OrderShortcutsDialog } from '../shortcuts/OrderShortcutsDialog'
import { shortcutActions, type OrderShortcuts } from '../shortcuts/orderShortcuts'
import { DesktopPrinters } from '../printing/DesktopPrinters'
import '../printing/printing.css'

type Props = { staff: StaffIdentity; theme: 'light' | 'dark'; onThemeChange: (theme: 'light' | 'dark') => void; cardShortcuts: CardShortcuts; onCardShortcutsChange: (value: CardShortcuts) => void; orderShortcuts: OrderShortcuts; onOrderShortcutsChange: (value: OrderShortcuts) => void; onClose: () => void }
const emptyProduct: ProductInput = { name: '', categoryId: '', description: '', pricePaise: 0, taxRateBps: 0, available: true }
const today = () => new Date().toISOString().slice(0, 10)
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'The operation could not be completed.'

export function RestaurantManagement({ staff, theme, onThemeChange, cardShortcuts, onCardShortcutsChange, orderShortcuts, onOrderShortcutsChange, onClose }: Props) {
  const canEdit = staffHasPermission(staff.role, 'menu:manage')
  const canReport = staffHasPermission(staff.role, 'reports:view')
  const canInventory = staffHasPermission(staff.role, 'inventory:manage')
  const canKitchen = staffHasPermission(staff.role, 'kitchen:operate')
  const canCloseCash = staffHasPermission(staff.role, 'cash:close')
  const canBackup = staffHasPermission(staff.role, 'settings:manage')
  const [tab, setTab] = useState<'menu' | 'tables' | 'shortcuts' | 'printers' | 'reports' | 'inventory' | 'kitchen' | 'cash' | 'backups' | 'appearance'>(canEdit ? 'menu' : canReport ? 'reports' : canInventory ? 'inventory' : 'kitchen')
  const [showOrderShortcuts, setShowOrderShortcuts] = useState(false)
  return <main className="management-shell">
    <header className="management-header"><div><span>BillMitra</span><h1>Restaurant management</h1><p>{staff.displayName} · {staff.role}</p></div><button onClick={onClose}>Close</button></header>
    <nav className="management-tabs" aria-label="Management sections">
      {canEdit && <button aria-pressed={tab === 'menu'} onClick={() => setTab('menu')}>Menu and prices</button>}
      {canEdit && <button aria-pressed={tab === 'tables'} onClick={() => setTab('tables')}>Tables and cards</button>}
      {canEdit && <button aria-pressed={tab === 'shortcuts'} onClick={() => setTab('shortcuts')}>Shortcuts</button>}
      {canEdit && <button aria-pressed={tab === 'printers'} onClick={() => setTab('printers')}>Printers</button>}
      {canReport && <button aria-pressed={tab === 'reports'} onClick={() => setTab('reports')}>Sales reports</button>}
      {canInventory && <button aria-pressed={tab === 'inventory'} onClick={() => setTab('inventory')}>Inventory</button>}
      {canKitchen && <button aria-pressed={tab === 'kitchen'} onClick={() => setTab('kitchen')}>Kitchen</button>}
      {canCloseCash && <button aria-pressed={tab === 'cash'} onClick={() => setTab('cash')}>Cash closing</button>}
      {canBackup && <button aria-pressed={tab === 'backups'} onClick={() => setTab('backups')}>Backups</button>}
      {canBackup && <button aria-pressed={tab === 'appearance'} onClick={() => setTab('appearance')}>Appearance</button>}
    </nav>
    {tab === 'menu' && canEdit && <MenuEditor />}
    {tab === 'tables' && canEdit && <TableSettings />}
    {tab === 'shortcuts' && canEdit && <><CardShortcutSettings shortcuts={cardShortcuts} onSave={onCardShortcutsChange} /><section className="management-card appearance-settings"><h2>Order shortcuts</h2><p>On the order entry screen, press Escape to leave menu search, then P to print the selected bill or R to recall a bill. Keys can be changed on this device.</p><div className="shortcut-list">{shortcutActions.map(action => <div className="shortcut-row" key={action.id}><span>{action.label}</span><strong>{orderShortcuts[action.id]}</strong></div>)}</div><button type="button" onClick={() => setShowOrderShortcuts(true)}>Customize order shortcuts</button></section></>}
    {tab === 'printers' && canEdit && <DesktopPrinters embedded />}
    {tab === 'reports' && canReport && <SalesReports />}
    {tab === 'inventory' && canInventory && <InventoryPanel />}
    {tab === 'kitchen' && canKitchen && <KitchenPanel />}
    {tab === 'cash' && canCloseCash && <CashClosingPanel onReturnToCashier={onClose} />}
    {tab === 'backups' && canBackup && <BackupsPanel />}
    {tab === 'appearance' && canBackup && <section className="management-card appearance-settings">
      <h2>Appearance</h2>
      <p>Choose the display style for this device. Your choice is saved automatically.</p>
      <div className="appearance-options" role="group" aria-label="Color theme">
        <button type="button" aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')}><span aria-hidden="true">☀</span> Light</button>
        <button type="button" aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')}><span aria-hidden="true">◐</span> Dark</button>
      </div>
    </section>}
    {showOrderShortcuts && <OrderShortcutsDialog shortcuts={orderShortcuts} onClose={() => setShowOrderShortcuts(false)} onSave={value => { onOrderShortcutsChange(value); setShowOrderShortcuts(false) }} />}
  </main>
}

function TableSettings() {
  const [tables, setTables] = useState<RestaurantTable[] | null>(null)
  const [name, setName] = useState('')
  const [floor, setFloor] = useState('')
  const [capacity, setCapacity] = useState('2')
  const [parcelCount, setParcelCount] = useState('100')
  const [deliveryCount, setDeliveryCount] = useState('100')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    loadMenu().then(menu => { if (active) { setTables(menu.tables); setParcelCount(String(menu.cardSettings?.parcelCount ?? 100)); setDeliveryCount(String(menu.cardSettings?.deliveryCount ?? 100)) } }).catch(cause => { if (active) setError(errorMessage(cause)) })
    return () => { active = false }
  }, [])
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      const saved = await addTable({ name: name.trim(), floor: floor.trim(), capacity: Number(capacity) })
      setName('')
      setNotice(`Table ${saved.name} added to ${saved.floor}.`)
      setTables((await loadMenu()).tables)
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  async function saveCards(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      await saveCardSettings({ parcelCount: Number(parcelCount), deliveryCount: Number(deliveryCount) })
      setNotice('Card counts saved. Return to the cashier to see the updated cards.')
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  const floors = [...new Set(tables?.map(table => table.floor) ?? [])]
  return <div className="management-columns">
    <form className="management-card" onSubmit={event => void submit(event)}>
      <h2>Add a dining table</h2>
      <fieldset disabled={busy}>
        <label>Table name or number<input value={name} onChange={event => setName(event.target.value)} maxLength={40} required /></label>
        <label>Floor<input list="management-floor-options" value={floor} onChange={event => setFloor(event.target.value)} maxLength={80} required placeholder="Choose or enter a floor" /><datalist id="management-floor-options">{floors.map(item => <option key={item} value={item} />)}</datalist></label>
        <label>Number of seats<input type="number" min="1" max="100" required value={capacity} onChange={event => setCapacity(event.target.value)} /></label>
        <button type="submit">{busy ? 'Adding…' : 'Add table'}</button>
      </fieldset>
      {error && <p className="management-error" role="alert">{error}</p>}
      {notice && <p className="management-notice" role="status">{notice}</p>}
    </form>
    <div className="management-forms"><form className="management-card" onSubmit={event => void saveCards(event)}><h2>Parcel and delivery cards</h2>
      <p>Choose how many numbered cards to show for each type (1–100).</p>
      <fieldset disabled={busy || tables === null}>
        <label>Parcel cards<input type="number" min="1" max="100" required value={parcelCount} onChange={event => setParcelCount(event.target.value)} /></label>
        <label>Home delivery cards<input type="number" min="1" max="100" required value={deliveryCount} onChange={event => setDeliveryCount(event.target.value)} /></label>
        <button type="submit">Save card counts</button>
      </fieldset>
    </form><section className="management-card"><h2>Existing tables</h2>
      {tables === null ? <p>Loading tables…</p> : tables.length === 0 ? <p>No tables added yet.</p> : <div className="management-table-wrap"><table><thead><tr><th>Floor</th><th>Table</th><th>Seats</th></tr></thead><tbody>{tables.map(table => <tr key={table.id}><td>{table.floor}</td><td>{table.name}</td><td>{table.capacity}</td></tr>)}</tbody></table></div>}
    </section></div>
  </div>
}

function MenuEditor() {
  const [catalog, setCatalog] = useState<MenuCatalog | null>(null)
  const [draft, setDraft] = useState<ProductInput>(emptyProduct)
  const [price, setPrice] = useState('0.00')
  const [tax, setTax] = useState('0.00')
  const [categoryId, setCategoryId] = useState('')
  const [categoryName, setCategoryName] = useState('')
  const [sortOrder, setSortOrder] = useState(0)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    getMenuCatalog().then(value => { if (active) setCatalog(value) }).catch(cause => { if (active) setError(errorMessage(cause)) })
    return () => { active = false }
  }, [])

  function edit(product: Product) {
    setDraft(product); setPrice((product.pricePaise / 100).toFixed(2)); setTax((product.taxRateBps / 100).toFixed(2)); setNotice('')
  }
  async function submitProduct(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('')
    if (!/^\d+(\.\d{1,2})?$/.test(price) || !/^\d+(\.\d{1,2})?$/.test(tax)) {
      setError('Price and tax must be positive numbers with up to two decimal places.'); return
    }
    setBusy(true)
    try {
      await saveProduct({ ...draft, pricePaise: Math.round(Number(price) * 100), taxRateBps: Math.round(Number(tax) * 100) })
      setCatalog(await getMenuCatalog()); setDraft(emptyProduct); setPrice('0.00'); setTax('0.00'); setNotice('Menu item saved. Existing invoice lines keep their original prices and names.')
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  async function submitCategory(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      await saveCategory({ ...(categoryId ? { id: categoryId } : {}), name: categoryName, sortOrder })
      setCatalog(await getMenuCatalog()); setCategoryId(''); setCategoryName(''); setSortOrder(0); setNotice('Category saved.')
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <>
    {error && <p className="management-error" role="alert">{error}</p>}
    {notice && <p className="management-notice" role="status">{notice}</p>}
    {!catalog ? <p>Loading menu…</p> : <div className="management-columns">
      <section className="management-card"><h2>Menu items</h2><label>Search items<input value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="management-table-wrap"><table><thead><tr><th>Item</th><th>Price</th><th>Availability</th><th /></tr></thead><tbody>
          {catalog.products.filter(product => `${product.name} ${product.description}`.toLowerCase().includes(query.toLowerCase())).map(product => <tr key={product.id}>
            <td><b>{product.name}</b><small>{catalog.categories.find(category => category.id === product.categoryId)?.name}</small></td><td>{formatMoney(product.pricePaise)}</td><td>{product.available ? 'Available' : 'Unavailable'}</td><td><button disabled={busy} onClick={() => edit(product)}>Edit</button></td>
          </tr>)}
        </tbody></table></div>
      </section>
      <div className="management-forms">
        <form className="management-card" onSubmit={event => void submitProduct(event)}><h2>{draft.id ? 'Edit menu item' : 'New menu item'}</h2>
          <fieldset disabled={busy}>
            <label>Name<input required maxLength={120} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>Category<select required value={draft.categoryId} onChange={event => setDraft({ ...draft, categoryId: event.target.value })}><option value="">Select category</option>{catalog.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label>Description<textarea maxLength={500} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
            <div className="management-form-row"><label>Price (₹)<input required inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} /></label><label>Tax rate (%)<input required inputMode="decimal" value={tax} onChange={event => setTax(event.target.value)} /></label></div>
            <label className="management-checkbox"><input type="checkbox" checked={draft.available} onChange={event => setDraft({ ...draft, available: event.target.checked })} />Available for new orders</label>
            <div className="management-form-row"><button type="submit">{busy ? 'Saving…' : 'Save item'}</button><button type="button" onClick={() => { setDraft(emptyProduct); setPrice('0.00'); setTax('0.00') }}>Clear</button></div>
          </fieldset>
        </form>
        <form className="management-card" onSubmit={event => void submitCategory(event)}><h2>Categories</h2><fieldset disabled={busy}>
          <label>Edit category<select value={categoryId} onChange={event => {
            const category = catalog.categories.find(item => item.id === event.target.value)
            setCategoryId(category?.id ?? ''); setCategoryName(category?.name ?? ''); setSortOrder(category?.sortOrder ?? 0)
          }}><option value="">New category</option>{catalog.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
          <label>Name<input required maxLength={80} value={categoryName} onChange={event => setCategoryName(event.target.value)} /></label>
          <label>Display order<input type="number" min={0} max={9999} required value={sortOrder} onChange={event => setSortOrder(Number(event.target.value))} /></label><button type="submit">Save category</button>
        </fieldset></form>
      </div>
    </div>}
  </>
}

function SalesReports() {
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [report, setReport] = useState<SalesReport | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function load(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setReport(null)
    try { setReport(await getSalesReport({ from, to })) } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  function exportCsv() {
    if (!report) return
    const rows = [ ['Metric', 'Value (paise unless stated)'], ['From (UTC)', report.from], ['To (UTC)', report.to],
      ['Paid bills (count)', report.paidBills], ['Subtotal', report.subtotalPaise], ['Discount', report.discountPaise], ['Tax', report.taxPaise], ['Paid sales', report.totalPaise],
      ['Voided bills (count)', report.voidedBills], ['Voided amount', report.voidedPaise], ['Unpaid bills created in period (count)', report.unpaidBills], ['Unpaid amount', report.unpaidPaise],
      ['Collected', report.collectedPaise], ['Refunded', report.refundedPaise], ['Net collections', report.netCollectionsPaise],
      ...report.payments.map(payment => [payment.method + ' collections', payment.amountPaise]) ]
    const blob = new Blob([rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `sales-${report.from}-${report.to}.csv`; link.click(); URL.revokeObjectURL(url)
  }
  return <>
    <form className="management-report-filter" onSubmit={event => void load(event)}><label>From (UTC)<input type="date" required value={from} onChange={event => setFrom(event.target.value)} /></label><label>To (UTC)<input type="date" required min={from} value={to} onChange={event => setTo(event.target.value)} /></label><button disabled={busy}>{busy ? 'Loading…' : 'Generate report'}</button></form>
    {error && <p className="management-error" role="alert">{error}</p>}
    {!report && !busy && <p>Select a date range and generate a report.</p>}
    {report && <>
      <div className="management-report-summary"><h2>Sales: {report.from} – {report.to} (UTC)</h2><button onClick={exportCsv}>Export CSV</button></div>
      <p>Paid sales use payment dates. Voids use cancellation dates. Unpaid amounts include open bills created in the selected period. All date boundaries use UTC.</p>
      <div className="management-metrics">{[
        ['Paid sales', formatMoney(report.totalPaise)], ['Paid bills', String(report.paidBills)], ['Discounts', formatMoney(report.discountPaise)], ['Tax', formatMoney(report.taxPaise)],
        ['Voided bills', String(report.voidedBills)], ['Voided amount', formatMoney(report.voidedPaise)], ['Unpaid bills', String(report.unpaidBills)], ['Unpaid amount', formatMoney(report.unpaidPaise)],
        ['Collected', formatMoney(report.collectedPaise)], ['Refunded', formatMoney(report.refundedPaise)], ['Net collections', formatMoney(report.netCollectionsPaise)],
      ].map(([label, value]) => <article key={label}><span>{label}</span><b>{value}</b></article>)}</div>
      <div className="management-columns"><section className="management-card"><h2>Recorded collections</h2><table><thead><tr><th>Method</th><th>Payments</th><th>Amount</th></tr></thead><tbody>{report.payments.map(payment => <tr key={payment.method}><td>{payment.method.toUpperCase()}</td><td>{payment.count}</td><td>{formatMoney(payment.amountPaise)}</td></tr>)}</tbody></table></section>
        <section className="management-card"><h2>Items sold</h2><p>Item amounts are before invoice discounts and tax.</p><table><thead><tr><th>Item</th><th>Quantity</th><th>Subtotal</th></tr></thead><tbody>{report.items.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.quantity}</td><td>{formatMoney(item.subtotalPaise)}</td></tr>)}</tbody></table></section></div>
    </>}
  </>
}
