import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Image, Modal, Platform, Pressable, RefreshControl, ScrollView, Share, StatusBar, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import * as Crypto from 'expo-crypto'
import { Branch, InventoryItem, Order, Product, Session, Summary, ownerLogin, ownerRequest } from './src/api'

type Tab = 'Home' | 'Orders' | 'Products' | 'Reports' | 'Ask' | 'Inventory' | 'Branches' | 'Staff' | 'Notifications' | 'Settings'
const primaryTabs: Tab[] = ['Home', 'Orders', 'Products', 'Reports', 'Ask']
const marks: Record<string, string> = { Home: '⌂', Orders: '▤', Products: '◫', Reports: '▥', Ask: '✦' }
const C = { bg: '#FFF8F7', paper: '#FFFFFF', ink: '#292122', muted: '#756766', border: '#EEDBD9', coral: '#FFE3DF', blue: '#A62C2B', yellow: '#FFF0ED', green: '#B22F2C', dark: '#8F2423' }
const brandSymbol = require('./assets/billmitra-symbol.png')
const ownerServer = 'https://owner.billmitra.shop'
const rupees = (value: number | string) => `₹${(Number(value || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const hundredths = (value: string) => {
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(value.trim())) return NaN
  const [whole, fraction = ''] = value.trim().split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}
const thousandths = (value: string) => {
  if (!/^-?\d{1,7}(\.\d{1,3})?$/.test(value.trim())) return NaN
  const negative = value.trim().startsWith('-')
  const [whole, fraction = ''] = value.trim().replace('-', '').split('.')
  const milli = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'))
  return negative ? -milli : milli
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const moveDate = (day: string, days: number) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10) }

function Button({ label, onPress, light = false, disabled = false }: { label: string; onPress: () => void; light?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} style={[s.button, light && s.buttonLight, disabled && { opacity: .5 }]}><Text style={[s.buttonText, light && { color: C.ink }]}>{label}</Text></Pressable>
}
function Card({ children, color = C.paper }: { children: React.ReactNode; color?: string }) { return <View style={[s.card, { backgroundColor: color }]}>{children}</View> }
function Label({ children, inverse = false }: { children: React.ReactNode; inverse?: boolean }) { return <Text style={[s.label, inverse && { color: '#FFE2DE' }]}>{children}</Text> }
function Empty({ text }: { text: string }) { return <Card><Text style={s.empty}>{text}</Text></Card> }

export default function App() {
  const { width } = useWindowDimensions()
  const [session, setSession] = useState<Session | null>(null)
  const [restoring, setRestoring] = useState(true)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [tab, setTab] = useState<Tab>('Home')
  const [branchId, setBranchId] = useState('')
  const [date, setDate] = useState(today())
  const [summary, setSummary] = useState<Summary | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [orderPage, setOrderPage] = useState({ key: '', offset: 0 })
  const [orderTotal, setOrderTotal] = useState(0)
  const [nextOrderOffset, setNextOrderOffset] = useState<number | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [productSearch, setProductSearch] = useState('')
  const [productCategory, setProductCategory] = useState('')
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [productForm, setProductForm] = useState<{ id?: string; branchId: string; categoryId: string; name: string; description: string; price: string; tax: string; available: boolean } | null>(null)
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [stockForm, setStockForm] = useState<{ item: InventoryItem; requestId: string; delta: string; reason: string; attempted: boolean } | null>(null)
  const [staff, setStaff] = useState<{ id: string; displayName: string; role: string; branchId: string }[]>([])
  const [orderDetail, setOrderDetail] = useState<{ order: Record<string, unknown>; items: { name: string; quantity: number; unitPricePaise: number }[]; payments: { method: string; amountPaise: number }[] } | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [clock, setClock] = useState(() => Date.now())
  const orderFilterKey = JSON.stringify([branchId, date, search, status])
  const orderOffset = orderPage.key === orderFilterKey ? orderPage.offset : 0
  const setOrderOffset = (value: number | ((offset: number) => number)) => {
    setOrderPage({ key: orderFilterKey, offset: typeof value === 'function' ? value(orderOffset) : value })
  }
  const selection = useMemo(() => session?.branches.find(branch => branch.id === branchId), [session, branchId])
  const scopedBranches = useMemo(() => session?.branches.filter(branch => !branchId || branch.id === branchId) ?? [], [session, branchId])

  useEffect(() => { setSummary(null); setOrders([]) }, [session, branchId, date])

  useEffect(() => {
    let active = true
    void SecureStore.getItemAsync('billmitra-owner-session').then(async saved => {
      if (!saved) return
      const restored = JSON.parse(saved) as Session
      if (restored.server !== ownerServer) { await SecureStore.deleteItemAsync('billmitra-owner-session'); return }
      await ownerRequest(restored, 'me')
      if (active) setSession(restored)
    }).catch(() => { void SecureStore.deleteItemAsync('billmitra-owner-session') }).finally(() => { if (active) setRestoring(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!session) return
    let active = true
    let pending = false
    const load = async (background = false) => {
      if (pending) return
      pending = true
      if (!background) setLoading(true)
      try {
        const scope = { branchId: branchId || undefined, date }
        if (tab === 'Home' || tab === 'Reports' || tab === 'Branches' || tab === 'Notifications') {
          const data = await ownerRequest<Summary>(session, 'summary', scope)
          if (active) setSummary(data)
        }
        if (tab === 'Orders') {
          const data = await ownerRequest<{ orders: Order[]; total: number; nextOffset: number | null }>(session, 'orders', { ...scope, status: status || undefined, search: search || undefined, offset: orderOffset })
          if (active) { setOrders(data.orders); setOrderTotal(data.total); setNextOrderOffset(data.nextOffset) }
        }
        if (tab === 'Products') {
          const data = await ownerRequest<{ products: Product[]; categories: { id: string; name: string }[] }>(session, 'products', { branchId: branchId || undefined })
          if (active) { setProducts(data.products); setCategories(data.categories) }
        }
        if (tab === 'Inventory' || tab === 'Notifications') {
          const data = await ownerRequest<{ items: InventoryItem[] }>(session, 'inventory', { branchId: branchId || undefined })
          if (active) setInventory(data.items)
        }
        if (tab === 'Staff') {
          const data = await ownerRequest<{ staff: typeof staff }>(session, 'staff', { branchId: branchId || undefined })
          if (active) setStaff(data.staff)
        }
        if (active) setError('')
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Could not load owner data.') }
      finally { pending = false; if (active && !background) setLoading(false) }
    }
    void load()
    const timer = setInterval(() => {
      if (!active) return
      setClock(Date.now())
      if (['Home', 'Orders', 'Reports', 'Notifications'].includes(tab)) void load(true)
    }, 15_000)
    return () => { active = false; clearInterval(timer) }
  }, [session, tab, branchId, date, refreshKey, search, status, orderOffset])

  async function signIn() {
    setBusy(true); setError('')
    try {
      const signed = await ownerLogin(ownerServer, username, password)
      await SecureStore.setItemAsync('billmitra-owner-session', JSON.stringify(signed))
      setSession(signed); setPassword(''); setBranchId(''); setTab('Home')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in failed.') }
    finally { setBusy(false) }
  }
  async function signOut() {
    if (session) { try { await ownerRequest(session, 'logout') } catch { /* Local sign-out still completes. */ } }
    await SecureStore.deleteItemAsync('billmitra-owner-session')
    setSession(null); setSummary(null); setOrders([]); setProducts([]); setInventory([]); setTab('Home')
  }
  async function openOrder(order: Order) {
    if (!session) return
    setBusy(true); setError('')
    try { setOrderDetail(await ownerRequest(session, 'order', { id: order.id })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Order details are unavailable.') }
    finally { setBusy(false) }
  }
  async function ask() {
    if (!session || !question.trim()) return
    setBusy(true); setError(''); setAnswer('')
    try { const response = await ownerRequest<{ answer: string }>(session, 'ask', { date, branchId: branchId || undefined, question }); setAnswer(response.answer) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The answer is unavailable.') }
    finally { setBusy(false) }
  }
  function editProduct(product: Product) {
    setProductForm({ id: product.id, branchId: product.branchId, categoryId: product.categoryId,
      name: product.name, description: product.description, price: (Number(product.pricePaise) / 100).toFixed(2),
      tax: (product.taxRateBps / 100).toFixed(2), available: Boolean(product.available && product.active) })
  }
  async function saveProduct() {
    if (!session || !productForm) return
    const pricePaise = hundredths(productForm.price)
    const taxRateBps = hundredths(productForm.tax)
    if (!productForm.name.trim() || !productForm.categoryId || !Number.isSafeInteger(pricePaise) || pricePaise < 0 || pricePaise > 100_000_000 || !Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10000) {
      setError('Enter a name, category, valid price and tax rate.'); return
    }
    const commit = async () => {
      setBusy(true); setError('')
      try {
        await ownerRequest(session, 'save-product', { id: productForm.id, branchId: productForm.branchId, categoryId: productForm.categoryId,
          name: productForm.name.trim(), description: productForm.description.trim(), pricePaise, taxRateBps, available: productForm.available })
        setProductForm(null); setRefreshKey(key => key + 1)
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Product could not be saved.') }
      finally { setBusy(false) }
    }
    Alert.alert('Save product?', 'This updates the selected branch menu and price.', [{ text: 'Cancel' }, { text: 'Save', onPress: () => void commit() }])
  }
  async function adjustStock() {
    if (!session || !stockForm) return
    const deltaMilli = thousandths(stockForm.delta)
    if (!Number.isSafeInteger(deltaMilli) || deltaMilli === 0 || Math.abs(deltaMilli) > 1_000_000_000 || stockForm.reason.trim().length < 3) {
      setError('Enter a non-zero quantity and a reason of at least 3 characters.'); return
    }
    const commit = async () => {
      setStockForm({ ...stockForm, attempted: true }); setBusy(true); setError('')
      try {
        await ownerRequest(session, 'adjust-stock', { branchId: stockForm.item.branchId, requestId: stockForm.requestId,
          itemId: stockForm.item.id, deltaMilli, reason: stockForm.reason.trim() })
        setStockForm(null); setRefreshKey(key => key + 1)
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Stock adjustment could not be confirmed. Retry the same request.') }
      finally { setBusy(false) }
    }
    if (stockForm.attempted) void commit()
    else Alert.alert('Confirm stock adjustment', `${stockForm.delta} ${stockForm.item.unit} · ${stockForm.reason}`, [{ text: 'Cancel' }, { text: 'Confirm', onPress: () => void commit() }])
  }
  async function shareReport() {
    if (!summary) return
    const rows = [['date', 'branch', 'paid_bills', 'paid_sales_paise', 'discount_paise', 'tax_paise', 'collected_paise', 'refunded_paise']]
    for (const branch of summary.branches) rows.push([summary.date, branch.name, String(branch.paidBills), String(branch.paidSalesPaise), String(branch.discountPaise), String(branch.taxPaise), String(branch.collectedPaise), String(branch.refundedPaise)])
    const csv = rows.map(row => row.map(value => {
      const safe = /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value
      return `"${safe.replace(/"/g, '""')}"`
    }).join(',')).join('\n')
    await Share.share({ title: `BillMitra sales ${summary.date}`, message: csv })
  }

  const contentWidth = Math.min(width - 32, 700)
  if (restoring) return <View style={s.center}><ActivityIndicator color={C.green} /><Text style={s.muted}>Opening BillMitra Owner…</Text></View>
  if (!session) return <ScrollView style={{ backgroundColor: C.bg }} contentContainerStyle={s.loginShell} keyboardShouldPersistTaps="handled"><StatusBar barStyle="dark-content" /><View style={[s.loginCard, { width: contentWidth }]}>
    <Image source={brandSymbol} style={s.logo} resizeMode="contain" accessibilityLabel="BillMitra logo" /><Label>YOUR RESTAURANT, IN VIEW</Label><Text style={s.loginTitle}>BillMitra{`\n`}Owner.</Text>
    <Text style={s.muted}>Sign in with your owner account to see live restaurant data.</Text>
    <Text style={s.fieldLabel}>USERNAME</Text><TextInput style={s.input} autoCapitalize="none" value={username} onChangeText={setUsername} />
    <Text style={s.fieldLabel}>PASSWORD</Text><TextInput style={s.input} secureTextEntry value={password} onChangeText={setPassword} />
    {!!error && <Text style={s.error}>{error}</Text>}<Button label={busy ? 'Signing in…' : 'Sign in'} onPress={() => void signIn()} disabled={busy} />
    <Text style={s.finePrint}>Your password stays on the restaurant server. The phone never connects directly to MySQL.</Text>
  </View></ScrollView>

  const totals = summary?.totals
  const lowStock = inventory.filter(item => Number(item.quantityMilli) <= Number(item.reorderMilli))
  const hourly = summary?.branches.every(branch => branch.hours !== null)
    ? Array.from({ length: 24 }, (_, hour) => summary.branches.reduce((sum, branch) => sum + (branch.hours?.[hour]?.amountPaise ?? 0), 0)) : null
  const peakHour = Math.max(...(hourly ?? [0]), 1)
  const paymentAmounts = summary?.branches.reduce<Record<string, number>>((all, branch) => {
    for (const payment of branch.payments) all[payment.method] = (all[payment.method] ?? 0) + payment.amountPaise
    return all
  }, {}) ?? {}
  const recentPaidSales = summary?.branches.flatMap(branch => branch.recentSales.map(sale => ({ ...sale, branchName: branch.name })))
    .sort((a, b) => Date.parse(b.paidAt) - Date.parse(a.paidAt)).slice(0, 10) ?? []
  const reportFresh = !!summary && clock - Date.parse(summary.updatedAt) < 45_000 && !error
  const visibleProducts = products.filter(product => (!productCategory || product.categoryId === productCategory)
    && (!productSearch || `${product.name} ${product.category}`.toLowerCase().includes(productSearch.toLowerCase())))
  return <View style={s.shell}><StatusBar barStyle="dark-content" /><ScrollView contentContainerStyle={[s.page, { width: contentWidth }]} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => setRefreshKey(key => key + 1)} tintColor={C.green} />} keyboardShouldPersistTaps="handled">
    <View style={s.topLine}><Image source={brandSymbol} style={s.logoSmall} resizeMode="contain" accessibilityLabel="BillMitra logo" /><Text style={s.brand}>BillMitra <Text style={{ color: C.green }}>Owner</Text></Text><Pressable accessibilityRole="button" accessibilityLabel="Open owner settings" onPress={() => setTab('Settings')} style={s.topAvatar}><Text style={s.topAvatarText}>{session.owner.displayName.slice(0, 1).toUpperCase()}</Text></Pressable></View>
    <View style={s.headingRow}><View><Label>{tab === 'Home' ? 'THE BUSINESS TODAY' : 'OWNER WORKSPACE'}</Label><Text style={s.pageTitle}>{tab === 'Ask' ? 'Ask BillMitra' : tab}</Text></View>{tab !== 'Settings' && <Pressable onPress={() => setTab('Notifications')} style={s.iconButton}><Text style={s.iconText}>●</Text></Pressable>}</View>
    {tab !== 'Settings' && <><ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.branchStrip} contentContainerStyle={{ gap: 7 }}><Pressable onPress={() => setBranchId('')} style={[s.chip, !branchId && s.chipSelected]}><Text style={[s.chipText, !branchId && s.chipSelectedText]}>All branches</Text></Pressable>{session.branches.map(branch => <Pressable key={branch.id} onPress={() => setBranchId(branch.id)} style={[s.chip, branchId === branch.id && s.chipSelected]}><Text style={[s.chipText, branchId === branch.id && s.chipSelectedText]}>{branch.name}</Text></Pressable>)}</ScrollView>
      {['Home', 'Orders', 'Reports', 'Ask', 'Notifications', 'Branches'].includes(tab) && <View style={s.dateRow}><Pressable onPress={() => setDate(day => moveDate(day, -1))}><Text style={s.dateArrow}>‹</Text></Pressable><Text style={s.dateText}>{date === today() ? 'Today' : date}  ·  {selection?.timezone || (scopedBranches.length > 1 ? 'Branch local time' : scopedBranches[0]?.timezone)}</Text><Pressable onPress={() => setDate(day => moveDate(day, 1))} disabled={date >= today()}><Text style={[s.dateArrow, date >= today() && { opacity: .3 }]}>›</Text></Pressable></View>}</>}
    {!!error && <Card color="#FCE9E4"><Text style={s.error}>{error}</Text><Button label="Retry" light onPress={() => setRefreshKey(key => key + 1)} /></Card>}
    {loading && !summary && <View style={s.loading}><ActivityIndicator color={C.green} /><Text style={s.muted}>Loading real business data…</Text></View>}

    {tab === 'Home' && summary && <>
      <View style={s.liveRow}><Text style={[s.liveDot, !reportFresh && { color: C.muted }]}>●</Text><Text style={s.liveText}>{reportFresh ? 'Sales updated' : 'Sales need refresh'} · {new Date(summary.updatedAt).toLocaleTimeString()}</Text><Pressable accessibilityRole="button" onPress={() => setRefreshKey(key => key + 1)}><Text style={s.link}>Refresh</Text></Pressable></View>
      <Card color={C.dark}><Label inverse>PAID SALES · {date}</Label><Text style={s.heroNumber}>{rupees(totals?.paidSalesPaise ?? 0)}</Text><Text style={s.heroCaption}>{totals?.paidBills ?? 0} paid bills across {summary.branches.length} {summary.branches.length === 1 ? 'branch' : 'branches'}</Text><View style={s.heroDivider} /><Text style={s.heroFoot}>Updated {new Date(summary.updatedAt).toLocaleTimeString()}</Text></Card>
      <View style={s.metricGrid}><View style={[s.metricCard, { backgroundColor: C.coral }]}><Label>NET COLLECTIONS</Label><Text style={s.metricNumber}>{rupees(totals?.netCollectionsPaise ?? 0)}</Text><Text style={s.metricFoot}>Tenders less refunds</Text></View><View style={[s.metricCard, { backgroundColor: C.yellow }]}><Label>AVG. PAID BILL</Label><Text style={s.metricNumber}>{rupees(totals?.paidBills ? (totals.paidSalesPaise / totals.paidBills) : 0)}</Text><Text style={s.metricFoot}>Paid sales ÷ bills</Text></View></View>
      <View style={s.metricGrid}><View style={[s.metricCard, { backgroundColor: '#FCE8E6' }]}><Label>DISCOUNTS</Label><Text style={s.metricNumber}>{rupees(totals?.discountPaise ?? 0)}</Text></View><View style={[s.metricCard, { backgroundColor: '#FFF0ED' }]}><Label>REFUNDS</Label><Text style={s.metricNumber}>{rupees(totals?.refundedPaise ?? 0)}</Text></View></View>
      <Card><View style={s.sectionHeader}><Text style={s.sectionTitle}>Sales by hour</Text><Text style={s.sectionHint}>BRANCH LOCAL TIME</Text></View>{hourly ? <><View style={s.chart}>{hourly.map((amount, hour) => <View key={hour} style={[s.chartBar, { height: Math.max(3, 70 * amount / peakHour), backgroundColor: amount ? C.blue : C.border }]} />)}</View><View style={s.sectionHeader}><Text style={s.rowSub}>00:00</Text><Text style={s.rowSub}>12:00</Text><Text style={s.rowSub}>23:00</Text></View></> : <Text style={s.rowSub}>Hourly chart unavailable for this high-volume day.</Text>}{totals?.previousPaidSalesPaise ? <Text style={s.rowSub}>Previous day: {rupees(totals.previousPaidSalesPaise)} · {Math.round((totals.paidSalesPaise - totals.previousPaidSalesPaise) * 100 / totals.previousPaidSalesPaise)}% change</Text> : <Text style={s.rowSub}>No paid sales on the previous day for comparison.</Text>}</Card>
      <Card><Text style={s.sectionTitle}>Payment methods</Text>{Object.entries(paymentAmounts).length ? Object.entries(paymentAmounts).map(([method, value]) => <View key={method} style={s.listRow}><Text style={s.rowTitle}>{method.toUpperCase()}</Text><Text style={s.rowValue}>{rupees(value)}</Text></View>) : <Text style={s.rowSub}>No tenders recorded for this date.</Text>}</Card>
      <Card><View style={s.sectionHeader}><Text style={s.sectionTitle}>Branch performance</Text><Text style={s.sectionHint}>PAID SALES</Text></View>{summary.branches.length === 0 ? <Text style={s.empty}>No authorized branch data.</Text> : summary.branches.map(branch => <Pressable key={branch.id} style={s.listRow} onPress={() => { setBranchId(branch.id); setTab('Reports') }}><View><Text style={s.rowTitle}>{branch.name}</Text><Text style={s.rowSub}>{branch.paidBills} paid bills</Text></View><Text style={s.rowValue}>{rupees(branch.paidSalesPaise)} ›</Text></Pressable>)}</Card>
      <View style={s.shortcutGrid}>{([['Orders', 'View orders'], ['Products', 'Menu items'], ['Inventory', 'Low stock'], ['Reports', 'Reports'], ['Ask', 'Ask AI'], ['Branches', 'Branches'], ['Staff', 'Staff']] as [Tab, string][]).map(([target, label]) => <Pressable key={target} style={s.shortcut} onPress={() => setTab(target)}><Text style={s.shortcutMark}>{marks[target] || '◈'}</Text><Text style={s.shortcutText}>{label} ↗</Text></Pressable>)}</View>
      <Text style={s.finePrint}>Paid sales exclude unpaid and voided bills. Profit is unavailable until reliable cost data exists.</Text>
    </>}

    {tab === 'Orders' && <><TextInput style={s.input} placeholder="Search name or order number" value={search} onChangeText={setSearch} /><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7, marginBottom: 14 }}>{['', 'ordering', 'preparing', 'ready', 'payment_pending', 'paid', 'voided'].map(value => <Pressable key={value} onPress={() => setStatus(value)} style={[s.chip, status === value && s.chipSelected]}><Text style={[s.chipText, status === value && s.chipSelectedText]}>{value ? value.replace('_', ' ') : 'All'}</Text></Pressable>)}</ScrollView><Text style={s.sectionHint}>{orderTotal} MATCHING ORDERS · PAGE {Math.floor(orderOffset / 50) + 1}</Text>{loading ? <ActivityIndicator color={C.green} /> : orders.length === 0 ? <Empty text="No orders match this date and filter." /> : orders.map(order => <Pressable key={order.id} style={s.orderCard} onPress={() => void openOrder(order)}><View style={s.sectionHeader}><Text style={s.orderNo}>#{order.orderNumber} · {order.branchName}</Text><Text style={s.status}>{order.status.replace('_', ' ')}</Text></View><Text style={s.rowSub}>{order.orderType.replace('_', ' ')}{order.tableName ? ` · ${order.tableName}` : ''} · {new Date(order.createdAt).toLocaleTimeString()}</Text><View style={s.sectionHeader}><Text style={s.rowTitle}>{order.customerName || 'Walk-in guest'}</Text><Text style={s.rowValue}>{rupees(order.totalPaise)} ›</Text></View></Pressable>)}<View style={s.metricGrid}>{orderOffset > 0 && <Button label="← Previous" light onPress={() => setOrderOffset(value => Math.max(0, value - 50))} />}{nextOrderOffset !== null && <Button label="Next →" light onPress={() => setOrderOffset(nextOrderOffset)} />}</View></>}

    {tab === 'Products' && <><View style={s.sectionHeader}><Text style={s.sectionHint}>{visibleProducts.length} OF {products.length} MENU ENTRIES</Text>{!productForm && session.writableBranchIds?.length > 0 && <Pressable onPress={() => setProductForm({ branchId: branchId || session.writableBranchIds[0], categoryId: categories[0]?.id || '', name: '', description: '', price: '', tax: '0', available: true })}><Text style={s.link}>+ Add product</Text></Pressable>}</View>{!productForm && <><TextInput style={s.input} placeholder="Search products" value={productSearch} onChangeText={setProductSearch} /><ScrollView horizontal contentContainerStyle={{ gap: 7 }}><Pressable onPress={() => setProductCategory('')} style={[s.chip, !productCategory && s.chipSelected]}><Text style={[s.chipText, !productCategory && s.chipSelectedText]}>All categories</Text></Pressable>{categories.map(category => <Pressable key={category.id} onPress={() => setProductCategory(category.id)} style={[s.chip, productCategory === category.id && s.chipSelected]}><Text style={[s.chipText, productCategory === category.id && s.chipSelectedText]}>{category.name}</Text></Pressable>)}</ScrollView></>}
      {productForm ? <Card><Text style={s.sectionTitle}>{productForm.id ? 'Edit product' : 'Add product'}</Text><Text style={s.rowSub}>Branch: {session.branches.find(branch => branch.id === productForm.branchId)?.name}</Text><TextInput style={s.input} placeholder="Product name" value={productForm.name} onChangeText={value => setProductForm({ ...productForm, name: value })} /><TextInput style={s.input} placeholder="Description" value={productForm.description} onChangeText={value => setProductForm({ ...productForm, description: value })} /><Text style={s.fieldLabel}>CATEGORY</Text><ScrollView horizontal contentContainerStyle={{ gap: 7 }}>{categories.map(category => <Pressable key={category.id} onPress={() => setProductForm({ ...productForm, categoryId: category.id })} style={[s.chip, productForm.categoryId === category.id && s.chipSelected]}><Text style={[s.chipText, productForm.categoryId === category.id && s.chipSelectedText]}>{category.name}</Text></Pressable>)}</ScrollView><TextInput style={s.input} keyboardType="decimal-pad" placeholder="Price in rupees" value={productForm.price} onChangeText={value => setProductForm({ ...productForm, price: value })} /><TextInput style={s.input} keyboardType="decimal-pad" placeholder="Tax percentage" value={productForm.tax} onChangeText={value => setProductForm({ ...productForm, tax: value })} /><Pressable onPress={() => setProductForm({ ...productForm, available: !productForm.available })}><Text style={s.link}>{productForm.available ? '● Available at this branch' : '○ Unavailable at this branch'}</Text></Pressable><Button label={busy ? 'Saving…' : 'Save product'} onPress={() => void saveProduct()} disabled={busy} /><Button label="Cancel" light onPress={() => setProductForm(null)} /></Card>
        : loading ? <ActivityIndicator color={C.green} /> : visibleProducts.length === 0 ? <Empty text="No products match this branch or filter." /> : visibleProducts.map(product => <Pressable key={`${product.branchId}-${product.id}`} onPress={() => { if (session.writableBranchIds?.includes(product.branchId)) editProduct(product) }}><Card><View style={s.sectionHeader}><View style={{ flex: 1 }}><Text style={s.rowTitle}>{product.name}</Text><Text style={s.rowSub}>{product.category} · {session.branches.find(branch => branch.id === product.branchId)?.name}</Text></View><Text style={s.rowValue}>{rupees(product.pricePaise)}</Text></View><Text style={[s.availability, !product.available && { color: C.green }]}>{product.available && product.active ? '● Available' : '● Unavailable'}{session.writableBranchIds?.includes(product.branchId) ? ' · Tap to edit' : ''}</Text>{!!product.description && <Text style={s.rowSub}>{product.description}</Text>}</Card></Pressable>)}</>}

    {tab === 'Inventory' && <><Card color={C.dark}><Label inverse>STOCK ATTENTION</Label><Text style={s.heroNumber}>{lowStock.length}</Text><Text style={s.heroCaption}>Items at or below their reorder level</Text></Card>{stockForm && <Card><Text style={s.sectionTitle}>Adjust {stockForm.item.name}</Text><Text style={s.rowSub}>Use a negative quantity to record consumption or wastage. Existing stock cannot go below zero.</Text><TextInput style={s.input} placeholder="Quantity, e.g. -0.500" keyboardType="numbers-and-punctuation" value={stockForm.delta} editable={!stockForm.attempted} onChangeText={value => setStockForm({ ...stockForm, delta: value })} /><TextInput style={s.input} placeholder="Reason" value={stockForm.reason} editable={!stockForm.attempted} onChangeText={value => setStockForm({ ...stockForm, reason: value })} /><Button label={busy ? 'Saving…' : stockForm.attempted ? 'Retry same adjustment' : 'Confirm adjustment'} onPress={() => void adjustStock()} disabled={busy} /><Button label="Refresh stock and close" light onPress={() => { setStockForm(null); setRefreshKey(key => key + 1) }} /></Card>}{inventory.length === 0 ? <Empty text="No inventory items are configured." /> : inventory.map(item => <Pressable key={item.id} onPress={() => { if (session.writableBranchIds?.includes(item.branchId)) setStockForm({ item, requestId: Crypto.randomUUID(), delta: '', reason: '', attempted: false }) }}><Card><View style={s.sectionHeader}><View><Text style={s.rowTitle}>{item.name}</Text><Text style={s.rowSub}>{session.branches.find(branch => branch.id === item.branchId)?.name}</Text></View><Text style={[s.rowValue, Number(item.quantityMilli) <= Number(item.reorderMilli) && { color: C.green }]}>{(Number(item.quantityMilli) / 1000).toFixed(3)} {item.unit}</Text></View><Text style={s.rowSub}>Reorder at {(Number(item.reorderMilli) / 1000).toFixed(3)} {item.unit}{session.writableBranchIds?.includes(item.branchId) ? ' · Tap to adjust' : ''}</Text></Card></Pressable>)}</>}

    {tab === 'Reports' && summary && <Card color={reportFresh ? '#FFF0ED' : '#FCE2D9'}><View style={s.sectionHeader}><Text style={s.sectionTitle}>{reportFresh ? '● Live sales report' : '● Report needs refresh'}</Text><Text style={s.sectionHint}>EVERY 15 SEC</Text></View><Text style={s.rowSub}>Last updated {new Date(summary.updatedAt).toLocaleTimeString()} · Pull down to refresh</Text></Card>}

    {tab === 'Reports' && summary && <><Card color={C.blue}><Label inverse>DAILY SALES REPORT</Label><Text style={s.heroNumber}>{rupees(totals?.paidSalesPaise ?? 0)}</Text><Text style={s.heroCaption}>{date} · {selection?.name || 'All branches'}</Text></Card><Card><Text style={s.sectionTitle}>Financial summary</Text>{([['Paid bills', String(totals?.paidBills ?? 0)], ['Paid sales', rupees(totals?.paidSalesPaise ?? 0)], ['Discounts', rupees(totals?.discountPaise ?? 0)], ['Taxes', rupees(totals?.taxPaise ?? 0)], ['Tender collections', rupees(totals?.collectedPaise ?? 0)], ['Refunds', rupees(totals?.refundedPaise ?? 0)], ['Net collections', rupees(totals?.netCollectionsPaise ?? 0)]] as [string, string][]).map(([label, value]) => <View key={label} style={s.listRow}><Text style={s.rowSub}>{label}</Text><Text style={s.rowValue}>{value}</Text></View>)}</Card><Card><Text style={s.sectionTitle}>Branch comparison</Text>{summary.branches.map(branch => <View key={branch.id} style={s.listRow}><Text style={s.rowTitle}>{branch.name}</Text><Text style={s.rowValue}>{rupees(branch.paidSalesPaise)}</Text></View>)}</Card><Card><Text style={s.sectionTitle}>Top products</Text>{summary.branches.flatMap(branch => branch.topProducts.map(product => ({ ...product, branch: branch.name }))).length ? summary.branches.flatMap(branch => branch.topProducts.map(product => ({ ...product, branch: branch.name }))).map((product, index) => <View key={`${product.branch}-${product.name}-${index}`} style={s.listRow}><Text style={s.rowTitle}>{product.name} · {product.branch}</Text><Text style={s.rowValue}>{product.quantity} sold</Text></View>) : <Text style={s.rowSub}>No paid product sales for this date.</Text>}</Card><Button label="Share CSV summary" light onPress={() => void shareReport()} /><Text style={s.finePrint}>Net collections are tender receipts minus refunds on this date. Profit and margin are not calculated without costs.</Text></>}

    {tab === 'Reports' && summary && <Card><View style={s.sectionHeader}><Text style={s.sectionTitle}>Latest paid bills</Text><Text style={s.sectionHint}>THIS BUSINESS DAY</Text></View>{recentPaidSales.length ? recentPaidSales.map(sale => <View key={sale.id} style={s.listRow}><View><Text style={s.rowTitle}>Bill #{sale.orderNumber} · {sale.branchName}</Text><Text style={s.rowSub}>Paid {new Date(sale.paidAt).toLocaleTimeString()}</Text></View><Text style={s.rowValue}>{rupees(sale.totalPaise)}</Text></View>) : <Text style={s.rowSub}>No paid bills recorded yet for this date.</Text>}</Card>}

    {tab === 'Branches' && summary && <>{summary.branches.map(branch => <Pressable key={branch.id} onPress={() => { setBranchId(branch.id); setTab('Home') }}><Card><Text style={s.rowTitle}>{branch.name} ↗</Text><Text style={s.rowSub}>{branch.timezone} · {branch.currencyCode}</Text><Text style={s.bigValue}>{rupees(branch.paidSalesPaise)}</Text><Text style={s.rowSub}>{branch.paidBills} paid bills</Text></Card></Pressable>)}</>}

    {tab === 'Staff' && <>{staff.length === 0 ? <Empty text="No active staff are assigned to this branch." /> : staff.map(person => <Card key={`${person.id}-${person.branchId}`}><View style={s.sectionHeader}><View><Text style={s.rowTitle}>{person.displayName}</Text><Text style={s.rowSub}>{session.branches.find(branch => branch.id === person.branchId)?.name}</Text></View><Text style={s.status}>{person.role}</Text></View></Card>)}</>}

    {tab === 'Notifications' && <><Card color={C.dark}><Label inverse>LIVE ATTENTION</Label><Text style={s.heroNumber}>{lowStock.length}</Text><Text style={s.heroCaption}>Low or out of stock items</Text></Card>{lowStock.length ? lowStock.map(item => <Pressable key={item.id} onPress={() => setTab('Inventory')}><Card><Text style={s.rowTitle}>{item.name} needs attention ↗</Text><Text style={s.rowSub}>{session.branches.find(branch => branch.id === item.branchId)?.name} · {(Number(item.quantityMilli) / 1000).toFixed(3)} {item.unit} left</Text></Card></Pressable>) : <Empty text="No stock alerts right now. Other alert types are not yet available from the server." />}</>}

    {tab === 'Ask' && <><Card color={C.dark}><Label inverse>BUSINESS QUESTIONS</Label><Text style={s.heroTitle}>Ask what matters.</Text><Text style={s.heroCaption}>Answers use authorized branch data for {date}.</Text></Card><TextInput style={[s.input, { minHeight: 100, textAlignVertical: 'top' }]} multiline placeholder="How much did we sell today?" value={question} onChangeText={setQuestion} /><Button label={busy ? 'Checking the data…' : 'Ask BillMitra'} onPress={() => void ask()} disabled={busy || !question.trim()} />{!!answer && <Card color="#FFF0ED"><Label>ANSWER · REAL DATA</Label><Text style={s.answer}>{answer}</Text></Card>}<Text style={s.finePrint}>Ask about sales, bills, branch and product leaders, active orders, payment methods or refunds. Voice capture and model-backed questions need a native build and server provider setup.</Text></>}

    {tab === 'Settings' && <><Card><Text style={s.sectionTitle}>{session.owner.displayName}</Text><Text style={s.rowSub}>@{session.owner.username} · Owner</Text><Text style={s.rowSub}>{session.server}</Text></Card><Card><Text style={s.sectionTitle}>Your branches</Text>{session.branches.map((branch: Branch) => <View key={branch.id} style={s.listRow}><Text style={s.rowTitle}>{branch.name}</Text><Text style={s.rowSub}>{branch.timezone}</Text></View>)}</Card><Button label="Sign out" light onPress={() => Alert.alert('Sign out?', 'You will need your owner password to return.', [{ text: 'Cancel' }, { text: 'Sign out', onPress: () => void signOut() }])} /></>}

    <Modal visible={orderDetail !== null} animationType="slide" onRequestClose={() => setOrderDetail(null)}>{orderDetail && <ScrollView style={{ backgroundColor: C.bg }} contentContainerStyle={s.detailSheet}><Button label="← Back to orders" light onPress={() => setOrderDetail(null)} /><Label>ORDER DETAIL</Label><Text style={s.pageTitle}>#{String(orderDetail.order.display_number)}</Text><Text style={s.rowSub}>{String(orderDetail.order.branchName)} · {String(orderDetail.order.status)}</Text><Card><Text style={s.sectionTitle}>Items</Text>{orderDetail.items.map((item, index) => <View key={index} style={s.listRow}><Text style={s.rowTitle}>{item.quantity} × {item.name}</Text><Text style={s.rowValue}>{rupees(item.quantity * Number(item.unitPricePaise))}</Text></View>)}</Card><Card><Text style={s.sectionTitle}>Payment</Text>{orderDetail.payments.length ? orderDetail.payments.map((payment, index) => <View key={index} style={s.listRow}><Text style={s.rowSub}>{payment.method}</Text><Text style={s.rowValue}>{rupees(payment.amountPaise)}</Text></View>) : <Text style={s.rowSub}>No tender recorded.</Text>}</Card><Card><Text style={s.sectionTitle}>Customer and delivery</Text><Text style={s.rowSub}>{String(orderDetail.order.customer_name || 'Walk-in guest')}</Text><Text style={s.rowSub}>{String(orderDetail.order.delivery_address || '')}</Text></Card></ScrollView>}</Modal>
  </ScrollView><View style={[s.nav, { paddingBottom: Platform.OS === 'android' ? 22 : 10 }]}>{primaryTabs.map(item => <Pressable key={item} style={[s.navItem, tab === item && s.navSelected]} onPress={() => { setOrderDetail(null); setTab(item) }}><Text style={[s.navMark, tab === item && { color: C.paper }]}>{marks[item]}</Text><Text style={[s.navLabel, tab === item && { color: C.paper }]}>{item}</Text></Pressable>)}</View></View>
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: C.bg }, center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: C.bg, gap: 12 },
  page: { alignSelf: 'center', paddingTop: 45, paddingBottom: 110, gap: 12 }, topLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logo: { width: 62, height: 62, marginBottom: 8 },
  logoSmall: { width: 34, height: 34 }, brand: { flex: 1, fontSize: 16, fontWeight: '900', color: C.ink },
  topAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.dark, alignItems: 'center', justifyContent: 'center' }, topAvatarText: { color: '#fff', fontWeight: '800' },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 7 }, pageTitle: { color: C.ink, fontSize: 34, fontWeight: '900', letterSpacing: -.8 }, label: { fontSize: 10, fontWeight: '900', letterSpacing: 1.3, color: C.muted },
  iconButton: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.paper, alignItems: 'center', justifyContent: 'center' }, iconText: { fontSize: 12, color: C.green },
  branchStrip: { flexGrow: 0 }, chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, borderWidth: 1, borderColor: C.border, backgroundColor: C.paper }, chipSelected: { backgroundColor: C.dark, borderColor: C.dark }, chipText: { fontSize: 11, fontWeight: '700', color: C.ink }, chipSelectedText: { color: C.paper },
  dateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 2 }, dateArrow: { fontSize: 27, fontWeight: '600', color: C.ink }, dateText: { fontSize: 11, color: C.muted, fontWeight: '700' },
  card: { borderRadius: 19, padding: 18, gap: 9, overflow: 'hidden', borderWidth: 1, borderColor: C.border }, heroNumber: { color: '#fff', fontSize: 37, fontWeight: '900', letterSpacing: -1 }, heroTitle: { color: '#fff', fontSize: 36, fontWeight: '900', lineHeight: 39 }, heroCaption: { color: '#FFE6E3', fontSize: 12, lineHeight: 18 }, heroDivider: { height: 1, backgroundColor: '#D36B64', marginTop: 9 }, heroFoot: { fontSize: 10, color: '#FFE2DE' },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 3 }, liveDot: { color: C.green, fontSize: 12 }, liveText: { flex: 1, color: C.muted, fontSize: 11, fontWeight: '700' },
  metricGrid: { flexDirection: 'row', gap: 10 }, metricCard: { flex: 1, minHeight: 112, padding: 14, borderRadius: 17, gap: 9 }, metricNumber: { fontSize: 20, color: C.ink, fontWeight: '900' }, metricFoot: { fontSize: 10, color: C.dark },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }, sectionTitle: { color: C.ink, fontSize: 16, fontWeight: '900' }, sectionHint: { fontSize: 10, color: C.muted, fontWeight: '800', letterSpacing: .8 },
  listRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border, gap: 8 }, rowTitle: { fontSize: 12, color: C.ink, fontWeight: '800' }, rowSub: { fontSize: 10, color: C.muted, marginTop: 3 }, rowValue: { fontSize: 12, color: C.ink, fontWeight: '900' }, bigValue: { fontSize: 26, color: C.ink, fontWeight: '900' },
  shortcutGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 }, shortcut: { width: '31%', minHeight: 76, borderRadius: 14, backgroundColor: C.paper, padding: 11, justifyContent: 'space-between' }, shortcutMark: { fontSize: 19, color: C.green, fontWeight: '900' }, shortcutText: { fontSize: 10, fontWeight: '800', color: C.ink },
  chart: { height: 75, flexDirection: 'row', gap: 3, alignItems: 'flex-end', paddingTop: 5 }, chartBar: { flex: 1, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  finePrint: { color: C.muted, fontSize: 10, lineHeight: 15, marginTop: 4 }, loading: { padding: 25, alignItems: 'center', gap: 9 }, muted: { color: C.muted, fontSize: 12 }, empty: { fontSize: 12, color: C.muted, lineHeight: 18 },
  orderCard: { padding: 16, borderRadius: 17, backgroundColor: C.paper, gap: 8 }, orderNo: { color: C.ink, fontSize: 14, fontWeight: '900' }, status: { color: C.green, fontSize: 10, fontWeight: '800', textTransform: 'capitalize' }, availability: { color: C.green, fontSize: 10, fontWeight: '800' },
  answer: { color: C.ink, fontSize: 16, lineHeight: 24, fontWeight: '700' }, input: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: '#fff', borderWidth: 1, borderColor: C.border, borderRadius: 11, fontSize: 13, color: C.ink },
  button: { minHeight: 48, backgroundColor: C.green, borderRadius: 11, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 18 }, buttonLight: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.border }, buttonText: { color: '#fff', fontWeight: '900', fontSize: 13 }, error: { color: '#A63D31', fontSize: 12, lineHeight: 18 },
  link: { color: C.green, fontSize: 12, fontWeight: '900' },
  nav: { position: 'absolute', bottom: 0, left: 0, right: 0, minHeight: 72, backgroundColor: C.paper, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', paddingBottom: 8, paddingHorizontal: 5 }, navItem: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 12, margin: 3 }, navSelected: { backgroundColor: C.dark }, navMark: { fontSize: 22, color: C.muted, fontWeight: '800' }, navLabel: { color: C.muted, fontSize: 9, fontWeight: '800' },
  loginShell: { flexGrow: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center', paddingVertical: 32, paddingHorizontal: 16 }, loginCard: { padding: 24, borderRadius: 24, backgroundColor: C.paper, borderWidth: 1, borderColor: C.border, gap: 11 }, loginTitle: { color: C.ink, fontSize: 36, fontWeight: '900', lineHeight: 39 }, fieldLabel: { fontSize: 10, fontWeight: '900', color: C.muted, marginTop: 7, letterSpacing: 1 },
  detailSheet: { padding: 20, paddingTop: 48, gap: 13, paddingBottom: 100 },
})
