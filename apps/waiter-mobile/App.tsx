import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, AppState, Platform, Pressable, SafeAreaView, ScrollView, StatusBar as NativeStatusBar, StyleSheet, Text, TextInput, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as Crypto from 'expo-crypto'
import { adjustProduct, productQuantity, tableFloors } from './src/draft'
import { ApiError, getMenu, login, logout, requestPrint, sendOrder, serverUrl, type Line, type Menu, type OrderInput, type PrintInput, type Session } from './src/api'
import { clearPending, clearPendingPrint, clearSession, getDraft, getPending, getPendingPrint, loadSession, putDraft, putPending, putPendingPrint, saveSession, scopeOf } from './src/storage'
import { orderTimer } from './src/orderTimer'

type Page = 'tables' | 'menu' | 'review' | 'account'
const money = (paise: number) => `₹${(paise / 100).toFixed(2)}`
const describe = (error: unknown) => error instanceof Error ? error.message : 'Please try again.'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [server, setServer] = useState('')
  const [branch, setBranch] = useState('main')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [menu, setMenu] = useState<Menu | null>(null)
  const [page, setPage] = useState<Page>('tables')
  const [floor, setFloor] = useState('Ground Floor')
  const [tableId, setTableId] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [pending, setPending] = useState<OrderInput | null>(null)
  const [pendingPrint, setPendingPrint] = useState<PrintInput | null>(null)
  const [printBusy, setPrintBusy] = useState(false)
  const [ticketId, setTicketId] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [connected, setConnected] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [notice, setNotice] = useState('')
  const draftWrites = useRef<Promise<void>>(Promise.resolve())
  const currentLines = useRef<Line[]>([])
  const printing = useRef(false)

  function replaceLines(next: Line[]) { currentLines.current = next; setLines(next) }

  const refresh = useCallback(async (active: Session) => {
    try { setMenu(await getMenu(active)); setConnected(true); setConnectionError('') }
    catch (cause) {
      setConnected(false)
      if (cause instanceof ApiError && cause.kind === 'http' && cause.status === 401) {
        await clearSession(); setSession(null); setMenu(null)
        setError('Your restaurant session expired. Sign in again. Saved drafts and pending orders are kept.')
      } else setConnectionError(describe(cause))
    }
  }, [])
  useEffect(() => {
    void (async () => {
      try {
        const saved = await loadSession()
        if (!saved) return
        setSession(saved); setServer(saved.server); setBranch(saved.branch.id)
        setPending(await getPending(scopeOf(saved)))
        setPendingPrint(await getPendingPrint(scopeOf(saved)))
        await refresh(saved)
      } catch (cause) { setError(describe(cause)) }
    })()
  }, [refresh])
  useEffect(() => {
    if (!session) return
    const timer = setInterval(() => { if (AppState.currentState === 'active') void refresh(session) }, 15000)
    const clock = setInterval(() => { if (AppState.currentState === 'active') setNow(Date.now()) }, 1000)
    const listener = AppState.addEventListener('change', state => { if (state === 'active') { setNow(Date.now()); void refresh(session) } })
    return () => { clearInterval(timer); clearInterval(clock); listener.remove() }
  }, [session, refresh])

  async function signIn() {
    setBusy(true); setError(''); setConnectionError('')
    try {
      const active = await login(serverUrl(server), branch.trim(), username.trim(), password)
      await saveSession(active)
      setPassword(''); setSession(active); setPending(await getPending(scopeOf(active)))
      setPendingPrint(await getPendingPrint(scopeOf(active)))
      await refresh(active)
    } catch (cause) { setError(describe(cause)) }
    finally { setBusy(false) }
  }
  async function openTable(id: string) {
    if (!session) return
    try { replaceLines(await getDraft(scopeOf(session), id)); setTableId(id); setTicketId(''); setPage('menu'); setError(''); setNotice('') }
    catch (cause) { setError(describe(cause)) }
  }
  async function changeLines(update: Line[] | ((current: Line[]) => Line[])) {
    if (!session || !tableId || pending || busy) return
    const next = typeof update === 'function' ? update(currentLines.current) : update
    replaceLines(next)
    const scope = scopeOf(session), selectedTable = tableId
    draftWrites.current = draftWrites.current.catch(() => {}).then(() => putDraft(scope, selectedTable, next))
    try { await draftWrites.current }
    catch (cause) { setError(describe(cause)) }
  }
  async function submit() {
    if (!session || busy || (!pending && (!menu || !tableId || !lines.length))) return
    setBusy(true); setError(''); setNotice('')
    try {
      await draftWrites.current
      const existing = menu?.activeOrders.find(order => order.tableId === tableId)
      const input: OrderInput = pending ?? { requestId: Crypto.randomUUID(), type: 'dine_in', tableId, customerName: existing?.customerName ?? '', deliveryAddress: '', discount: existing?.discount ?? null, items: lines, ...(existing ? { orderId: existing.id } : {}) }
      if (!pending) { await putPending(scopeOf(session), input); setPending(input) }
      await sendOrder(session, input)
      await putDraft(scopeOf(session), input.tableId, [])
      await clearPending(scopeOf(session))
      setPending(null); replaceLines([]); setPage('tables'); setNotice('Items accepted by the kitchen.')
      await refresh(session)
    } catch (cause) { setError(`${describe(cause)} Retry the saved pending order to confirm the result.`) }
    finally { setBusy(false) }
  }
  async function signOut() {
    if (!session || pending || pendingPrint || printBusy) return
    setBusy(true)
    try { await logout(session) } catch { /* Local sign-out clears the saved phone credential. */ }
    await clearSession(); setSession(null); setMenu(null); setConnected(false); setTableId(''); replaceLines([]); setPage('tables'); setFloor('Ground Floor'); setBusy(false)
  }
  async function sendPrint(input: PrintInput) {
    if (!session || printing.current) return
    printing.current = true; setPrintBusy(true); setError(''); setNotice('')
    try {
      await putPendingPrint(scopeOf(session), input); setPendingPrint(input)
      const job = await requestPrint(session, input)
      await clearPendingPrint(scopeOf(session)); setPendingPrint(null)
      setNotice(job.status === 'queued' ? 'Print queued. Keep the desktop open and signed in with its printer configured.' : `Print request: ${job.status}. ${job.error}`)
      await refresh(session)
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'http' && cause.status >= 400 && cause.status < 500) {
        await clearPendingPrint(scopeOf(session)); setPendingPrint(null); setError(describe(cause))
      } else setError(`${describe(cause)} Retry the saved print request to check its result.`)
    } finally { printing.current = false; setPrintBusy(false) }
  }
  function print(kind: 'bill' | 'kot') {
    if (!existing || pendingPrint || printBusy) return
    const input: PrintInput = { requestId: Crypto.randomUUID(), orderId: existing.id, kind, ...(kind === 'kot' ? { ticketId: selectedTicket } : {}) }
    const previous = menu?.printJobs?.some(job => job.orderId === existing.id && job.kind === kind && (job.ticketId ?? '') === (input.ticketId ?? '') && job.status !== 'failed')
    if (previous) Alert.alert('Print another copy?', 'A request already exists. Check the desktop queue and printer before making another copy.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Print copy', onPress: () => void sendPrint(input) }])
    else void sendPrint(input)
  }
  const table = menu?.tables.find(item => item.id === tableId)
  const existing = menu?.activeOrders.find(order => order.tableId === tableId)
  const tickets = existing?.kitchenTickets ?? []
  const selectedTicket = tickets.some(ticket => ticket.id === ticketId) ? ticketId : tickets.at(-1)?.id ?? ''
  const jobs = menu?.printJobs?.filter(job => job.orderId === existing?.id).slice(0, 4) ?? []
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0)
  const total = lines.reduce((sum, line) => sum + (menu?.products.find(product => product.id === line.productId)?.pricePaise ?? 0) * line.quantity, 0)
  const products = menu?.products.filter(product => product.available && (!category || product.categoryId === category) && product.name.toLowerCase().includes(query.toLowerCase())) ?? []
  const floors = tableFloors(menu?.tables ?? [])
  const selectedFloor = floors.includes(floor) ? floor : floors[0]
  const visibleTables = menu?.tables.filter(item => item.floor === selectedFloor) ?? []

  return <SafeAreaView style={[styles.shell, Platform.OS === 'android' && { paddingTop: NativeStatusBar.currentHeight ?? 0 }]}><StatusBar style="dark" />
    <View style={styles.header}><View><Text style={styles.brand}>BillMitra</Text><Text style={styles.muted}>{session?.branch.name ?? 'Waiter application'}{session ? ` · ${session.staff.displayName}` : ''}</Text></View>{session && <Text style={connected ? styles.green : styles.muted}>{connected ? 'Connected' : 'Offline'}</Text>}</View>
    {!!(error || connectionError) && <Text accessibilityRole="alert" style={styles.error}>{error || connectionError}</Text>}
    {!!notice && <Text style={styles.notice}>{notice}</Text>}
    {!session ? <ScrollView contentContainerStyle={styles.content}><Text style={styles.title}>Staff sign in</Text><Text style={styles.muted}>Ask your manager for the secure restaurant address and waiter account.</Text>
      <Text style={styles.label}>HTTPS restaurant address</Text><TextInput style={styles.input} autoCapitalize="none" autoCorrect={false} keyboardType="url" value={server} onChangeText={setServer} placeholder="https://restaurant.example.com" />
      <Text style={styles.label}>Branch ID</Text><TextInput style={styles.input} autoCapitalize="none" value={branch} onChangeText={setBranch} />
      <Text style={styles.label}>Username</Text><TextInput style={styles.input} autoCapitalize="none" value={username} onChangeText={setUsername} />
      <Text style={styles.label}>Password</Text><TextInput style={styles.input} secureTextEntry value={password} onChangeText={setPassword} />
      <Action title={busy ? 'Signing in…' : 'Sign in'} onPress={() => void signIn()} disabled={busy || !server || !username || !password} primary /></ScrollView>
      : <><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {pendingPrint && <View style={styles.pending}><Text style={styles.bold}>Unconfirmed print request</Text><Text>Retry checks the same request without printing it twice.</Text><Action title={printBusy ? 'Checking…' : 'Retry print request'} disabled={printBusy} onPress={() => void sendPrint(pendingPrint)} /></View>}
        {pending && <View style={styles.pending}><Text style={styles.bold}>Pending kitchen confirmation</Text><Text>Retry the exact saved order for table {menu?.tables.find(item => item.id === pending.tableId)?.name ?? pending.tableId}. Editing is paused until confirmed.</Text><Action title={busy ? 'Checking…' : 'Retry pending order'} onPress={() => void submit()} disabled={busy} /></View>}
        {page === 'tables' && <><Text style={styles.title}>Tables</Text><Text style={styles.muted}>Choose a floor, then tap a table.</Text>
          <View style={styles.floorTabs}>{floors.map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: item === selectedFloor }} onPress={() => setFloor(item)} style={[styles.floorTab, item === selectedFloor && styles.floorSelected]}><Text style={[styles.buttonText, item === selectedFloor && styles.primaryText]}>{item}</Text><Text style={[styles.floorCount, item === selectedFloor && styles.primaryText]}>{menu?.tables.filter(table => table.floor === item).length} tables</Text></Pressable>)}</View>
          <View style={styles.grid}>{visibleTables.map(item => { const timer = orderTimer(item.startedAt ?? menu?.activeOrders.find(order => order.id === item.orderId)?.createdAt, now); return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Table ${item.name}, ${item.orderId ? `open ${timer.label}${timer.overdue ? ', over one hour' : ''}` : 'available'}`} style={[styles.table, !!item.orderId && (timer.overdue ? styles.tableLate : styles.tableOpen)]} onPress={() => void openTable(item.id)}><Text style={[styles.tableName, !!item.orderId && styles.occupiedText]}>{item.name}</Text><Text style={item.orderId ? styles.occupiedText : styles.muted}>{item.floor}</Text><Text style={item.orderId ? styles.occupiedText : styles.green}>{item.orderId ? 'Open order' : 'Available'}</Text>{item.orderId && <><Text style={styles.timer}>{timer.label}</Text>{timer.overdue && <Text style={styles.occupiedText}>Over 1 hour</Text>}</>}</Pressable> })}</View>{!menu && <Action title="Refresh tables" onPress={() => void refresh(session)} />}</>}
        {page === 'menu' && <><Action title="← Tables" onPress={() => setPage('tables')} /><Text style={styles.title}>{table?.name ?? 'Table'} · Menu</Text><TextInput style={styles.input} value={query} onChangeText={setQuery} placeholder="Search food" />
          {existing && <View style={styles.printPanel}><Text style={styles.bold}>Order #{existing.orderNumber} · {orderTimer(existing.createdAt, now).label}</Text><Text style={styles.muted}>Print saved items through the desktop.{itemCount ? ' New draft items are not included.' : ''}</Text><Action title="Print bill" disabled={printBusy || !!pendingPrint || !connected} onPress={() => print('bill')} />
            {!!tickets.length && <><Text style={styles.label}>KOT batch</Text><ScrollView horizontal>{tickets.map((ticket, index) => <Pressable key={ticket.id} accessibilityRole="radio" accessibilityState={{ checked: ticket.id === selectedTicket }} onPress={() => setTicketId(ticket.id)} style={[styles.batch, ticket.id === selectedTicket && styles.floorSelected]}><Text style={ticket.id === selectedTicket ? styles.primaryText : styles.buttonText}>Batch {index + 1}{index === tickets.length - 1 ? ' · latest' : ''}</Text></Pressable>)}</ScrollView><Action title="Print KOT" disabled={printBusy || !!pendingPrint || !connected || !selectedTicket} onPress={() => print('kot')} /></>}
            {!tickets.length && <Text style={styles.muted}>Update the restaurant server to enable KOT printing.</Text>}{jobs.map(job => <View key={job.id}><Text style={styles.bold}>{job.kind.toUpperCase()}{job.copy ? ' copy' : ''}: {job.status === 'submitted' ? 'Submitted to desktop printer' : job.status}</Text>{!!job.error && <Text>{job.error}</Text>}</View>)}<Text style={styles.muted}>Submitted means accepted by the desktop printer system. Check paper output.</Text></View>}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categories}><Action title="All" onPress={() => setCategory('')} />{menu?.categories.map(item => <Action key={item.id} title={item.name} onPress={() => setCategory(item.id)} />)}</ScrollView>
          <Text style={styles.muted}>Use + and − to adjust new items before sending.</Text>
          {products.map(product => { const quantity = productQuantity(lines, product.id); return <View key={product.id} style={styles.row}><View style={styles.flex}><Text style={styles.bold}>{product.name}</Text><Text style={styles.muted}>{money(product.pricePaise)}</Text></View><View style={styles.quantityControl}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove one ${product.name}`} accessibilityState={{disabled:!!pending || busy || quantity === 0}} disabled={!!pending || busy || quantity === 0} onPress={() => void changeLines(current => adjustProduct(current, product.id, -1))} style={[styles.quantityButton, (!!pending || busy || quantity === 0) && styles.disabled]}><Text style={styles.quantitySymbol}>−</Text></Pressable>
            <Text accessibilityLabel={`${product.name}: ${quantity} in draft`} style={styles.quantityValue}>{quantity}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Add one ${product.name}`} accessibilityState={{disabled:!!pending || busy || quantity >= 99}} disabled={!!pending || busy || quantity >= 99} onPress={() => void changeLines(current => adjustProduct(current, product.id, 1))} style={[styles.quantityButton, (!!pending || busy || quantity >= 99) && styles.disabled]}><Text style={styles.quantitySymbol}>+</Text></Pressable>
          </View></View> })}
          <Action title={`Review ${itemCount} items · ${money(total)}`} onPress={() => setPage('review')} disabled={!itemCount} primary /></>}
        {page === 'review' && <><Action title="← Menu" onPress={() => setPage('menu')} /><Text style={styles.title}>Review · {table?.name}</Text>{existing && <Text style={styles.muted}>Already sent: {existing.items.map(line => `${line.quantity} ${line.productName}`).join(', ')}</Text>}
          {lines.map((line,index) => <View key={`${line.productId}-${index}`} style={styles.orderLine}><Text style={styles.bold}>{menu?.products.find(product => product.id === line.productId)?.name}</Text><View style={styles.stepper}><Action title="−" onPress={() => void changeLines(lines.flatMap((item,i) => i !== index ? [item] : item.quantity > 1 ? [{...item,quantity:item.quantity-1}] : []))} disabled={!!pending} /><Text>{line.quantity}</Text><Action title="+" onPress={() => void changeLines(lines.map((item,i) => i === index ? {...item,quantity:Math.min(99,item.quantity+1)} : item))} disabled={!!pending} /></View><TextInput style={styles.input} value={line.note} onChangeText={note => void changeLines(lines.map((item,i) => i === index ? {...item,note:note.slice(0,200)} : item))} placeholder="Kitchen note" editable={!pending} /></View>)}
          <Text style={styles.bold}>Estimated item subtotal: {money(total)}</Text><Text style={styles.muted}>The server checks final prices and availability.</Text><Action title={busy ? 'Sending…' : 'Send new items to kitchen'} onPress={() => void submit()} disabled={busy || !itemCount || (!!pending && pending.tableId !== tableId)} primary /></>}
        {page === 'account' && <><Text style={styles.title}>Account</Text><Text>{session.staff.displayName} · {session.staff.role}</Text><Text style={styles.muted}>{session.branch.name}</Text><Action title="Refresh restaurant data" onPress={() => void refresh(session)} /><Action title="Sign out" onPress={() => void signOut()} disabled={!!pending || !!pendingPrint || printBusy || busy} />{(pending || pendingPrint) && <Text style={styles.muted}>Resolve pending requests before signing out.</Text>}</>}
      </ScrollView><View style={styles.nav}><Action title="Tables" onPress={() => setPage('tables')} /><Action title="Account" onPress={() => setPage('account')} /></View></>}
  </SafeAreaView>
}

function Action({title,onPress,disabled,primary}: {title:string;onPress:()=>void;disabled?:boolean;primary?:boolean}) {
  return <Pressable accessibilityRole="button" accessibilityState={{disabled:!!disabled}} onPress={onPress} disabled={disabled} style={[styles.button,primary && styles.primary,disabled && styles.disabled]}><Text style={[styles.buttonText,primary && styles.primaryText]}>{title}</Text></Pressable>
}
const floorAndQuantityStyles = StyleSheet.create({
  tableOpen: { backgroundColor: '#1461a5', borderColor: '#0d518e' },
  tableLate: { backgroundColor: '#b63832', borderColor: '#972923' },
  occupiedText: { color: '#fff', marginTop: 4 },
  timer: { color: '#fff', fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'], marginTop: 10 },
  printPanel: { borderWidth: 1, borderColor: '#bcd0c2', backgroundColor: '#fff', borderRadius: 12, padding: 14, marginTop: 14, gap: 8 },
  batch: { borderWidth: 1, borderColor: '#cbdacf', borderRadius: 10, padding: 12, marginRight: 8, minHeight: 44, justifyContent: 'center' },
  floorTabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 18 },
  floorTab: { flexGrow: 1, minWidth: 130, minHeight: 64, justifyContent: 'center', alignItems: 'center', borderRadius: 12, borderWidth: 1, borderColor: '#cbdacf', backgroundColor: '#fff', padding: 12 },
  floorSelected: { backgroundColor: '#246b49', borderColor: '#246b49' },
  floorCount: { color: '#64736a', fontSize: 12, marginTop: 4 },
  quantityControl: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#cbdacf', borderRadius: 12, backgroundColor: '#fff' },
  quantityButton: { minWidth: 44, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  quantitySymbol: { color: '#245f40', fontWeight: '700', fontSize: 24 },
  quantityValue: { minWidth: 28, textAlign: 'center', fontSize: 18, fontWeight: '700', color: '#203c2c' },
})
const styles=StyleSheet.create({...floorAndQuantityStyles,shell:{flex:1,backgroundColor:'#f4f8f5'},header:{padding:18,backgroundColor:'#fff',flexDirection:'row',justifyContent:'space-between',alignItems:'center'},brand:{fontSize:24,fontWeight:'700',color:'#205c3d'},muted:{color:'#64736a',marginTop:4},title:{fontSize:24,fontWeight:'700',color:'#203c2c',marginVertical:14},content:{padding:18,paddingBottom:50},label:{marginTop:16,marginBottom:6,fontWeight:'600',color:'#355141'},input:{borderWidth:1,borderColor:'#cbdacf',borderRadius:10,backgroundColor:'#fff',minHeight:48,padding:12,fontSize:16,color:'#203c2c'},button:{borderWidth:1,borderColor:'#cbdacf',borderRadius:10,backgroundColor:'#fff',minHeight:48,justifyContent:'center',alignItems:'center',paddingHorizontal:14,marginVertical:4},buttonText:{color:'#245f40',fontWeight:'600'},primary:{backgroundColor:'#246b49',borderColor:'#246b49',marginTop:18},primaryText:{color:'#fff'},disabled:{opacity:0.5},error:{color:'#9b3028',backgroundColor:'#fff2ef',padding:12},notice:{color:'#22603f',backgroundColor:'#eaf7ed',padding:12},pending:{backgroundColor:'#fff2da',padding:14,borderRadius:12,marginBottom:12},grid:{flexDirection:'row',flexWrap:'wrap',gap:12,marginTop:16},table:{width:'47%',minHeight:118,padding:16,borderRadius:12,backgroundColor:'#fff',borderWidth:1,borderColor:'#dce6de'},tableName:{fontSize:22,fontWeight:'700',color:'#203c2c'},green:{color:'#246b49',marginTop:8},categories:{marginVertical:12},row:{flexDirection:'row',alignItems:'center',borderBottomWidth:1,borderColor:'#e0e8e2',paddingVertical:12,gap:10},flex:{flex:1},bold:{fontWeight:'700',color:'#203c2c'},orderLine:{padding:14,backgroundColor:'#fff',borderRadius:12,marginVertical:7},stepper:{flexDirection:'row',alignItems:'center',gap:12},nav:{flexDirection:'row',justifyContent:'space-around',padding:8,backgroundColor:'#fff',borderTopWidth:1,borderColor:'#dce6de'}})
