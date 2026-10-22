import { useEffect, useState, type FormEvent } from 'react'
import type { Product, StaffIdentity } from '../../../shared/domain'
import type { MenuCatalog, ProductInput, SalesReport } from '../../../shared/restaurant'
import { staffHasPermission } from '../../../shared/staffPermissions'
import { formatMoney } from '../../../shared/billing'
import { getMenuCatalog, getSalesReport, saveCategory, saveProduct } from '../../services/pos'
import './management.css'
import { CashClosingPanel, InventoryPanel, KitchenPanel } from './OperationsPanels'
import { BackupsPanel } from './BackupsPanel'

type Props = { staff: StaffIdentity; onClose: () => void }
const emptyProduct: ProductInput = { name: '', categoryId: '', description: '', pricePaise: 0, taxRateBps: 0, available: true }
const today = () => new Date().toISOString().slice(0, 10)
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'The operation could not be completed.'

export function RestaurantManagement({ staff, onClose }: Props) {
  const canEdit = staffHasPermission(staff.role, 'menu:manage')
  const canReport = staffHasPermission(staff.role, 'reports:view')
  const canInventory = staffHasPermission(staff.role, 'inventory:manage')
  const canKitchen = staffHasPermission(staff.role, 'kitchen:operate')
  const canCloseCash = staffHasPermission(staff.role, 'cash:close')
  const canBackup = staffHasPermission(staff.role, 'settings:manage')
  const [tab, setTab] = useState<'menu' | 'reports' | 'inventory' | 'kitchen' | 'cash' | 'backups'>(canEdit ? 'menu' : canReport ? 'reports' : canInventory ? 'inventory' : 'kitchen')
  return <main className="management-shell">
    <header className="management-header"><div><span>BillMitra</span><h1>Restaurant management</h1><p>{staff.displayName} · {staff.role}</p></div><button onClick={onClose}>Close</button></header>
    <nav className="management-tabs" aria-label="Management sections">
      {canEdit && <button aria-pressed={tab === 'menu'} onClick={() => setTab('menu')}>Menu and prices</button>}
      {canReport && <button aria-pressed={tab === 'reports'} onClick={() => setTab('reports')}>Sales reports</button>}
      {canInventory && <button aria-pressed={tab === 'inventory'} onClick={() => setTab('inventory')}>Inventory</button>}
      {canKitchen && <button aria-pressed={tab === 'kitchen'} onClick={() => setTab('kitchen')}>Kitchen</button>}
      {canCloseCash && <button aria-pressed={tab === 'cash'} onClick={() => setTab('cash')}>Cash closing</button>}
      {canBackup && <button aria-pressed={tab === 'backups'} onClick={() => setTab('backups')}>Backups</button>}
    </nav>
    {tab === 'menu' && canEdit && <MenuEditor />}
    {tab === 'reports' && canReport && <SalesReports />}
    {tab === 'inventory' && canInventory && <InventoryPanel />}
    {tab === 'kitchen' && canKitchen && <KitchenPanel />}
    {tab === 'cash' && canCloseCash && <CashClosingPanel />}
    {tab === 'backups' && canBackup && <BackupsPanel />}
  </main>
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
