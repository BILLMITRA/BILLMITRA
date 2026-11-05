import { useEffect, useRef, useState, type ComponentRef } from 'react'
import { Alert, BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import * as Crypto from 'expo-crypto'
import { getKitchenQueue, sendKitchenDelay, setKitchenAvailability, updateKitchenStatus,
  type KitchenQueue, type KitchenRequest, type KitchenTicket, type Session } from './api'
import { clearPendingKitchen, getPendingKitchen, putPendingKitchen, scopeOf } from './storage'
import { VoicePanel } from './VoicePanel'
import { kitchenCounts, visibleKitchenOrders, visibleKitchenProducts, type OrderFilter } from './kitchenView'
import { NotificationSettings, type AlertSound } from './NotificationSettings'

export function KitchenScreen({ session, queue, onQueue, onSignOut, alertSound, onAlertSoundChange, onPreviewSound, onNotification, messageOpenSignal = 0 }: {
  session: Session; queue: KitchenQueue | null; onQueue: (queue: KitchenQueue) => void; onSignOut: () => void; alertSound: AlertSound; onAlertSoundChange: (sound: AlertSound) => void; onPreviewSound: () => void; onNotification: (title: string, message: string, messageId?: string) => void; messageOpenSignal?: number
}) {
  const [tab, setTab] = useState<'orders' | 'stock' | 'messages' | 'settings'>('orders')
  const [staffUnreadCount, setStaffUnreadCount] = useState(0)
  const tabRef = useRef(tab)
  const tabHistory = useRef<Array<typeof tab>>([])
  const scroll = useRef<ComponentRef<typeof ScrollView> | null>(null)
  const selectTab = (next: typeof tab) => { if (next === tabRef.current) return; if (tabHistory.current.at(-1) === next) tabHistory.current.pop(); else tabHistory.current.push(tabRef.current); tabRef.current = next; setTab(next); scroll.current?.scrollTo({ y: 0, animated: false }) }
  useEffect(() => { if (messageOpenSignal) selectTab('messages') }, [messageOpenSignal])
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      const previous = tabHistory.current.pop()
      if (!previous) { if (tabRef.current !== 'orders') { tabRef.current = 'orders'; setTab('orders') } return true }
      tabRef.current = previous; setTab(previous); scroll.current?.scrollTo({ y: 0, animated: false }); return true
    })
    return () => listener.remove()
  }, [tab])
  const [orderFilter, setOrderFilter] = useState<OrderFilter>('all')
  const [orderSearch, setOrderSearch] = useState('')
  const [stockSearch, setStockSearch] = useState('')
  const [unavailableOnly, setUnavailableOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<KitchenRequest | null>(null)
  const [reason, setReason] = useState('Kitchen is busy')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { void getPendingKitchen(scopeOf(session)).then(setPending).catch(cause => setError(cause instanceof Error ? cause.message : 'Could not restore the pending kitchen request.')) }, [session])

  async function refresh() { onQueue(await getKitchenQueue(session)) }
  async function update(ticket: KitchenTicket, status: 'preparing' | 'ready' | 'payment_pending') {
    if (busy || pending) return
    setBusy(true); setError(''); setNotice('')
    try {
      await updateKitchenStatus(session, { orderId: ticket.id, ticketId: ticket.ticketId, status })
      await refresh()
      setNotice(`Order #${ticket.orderNumber} is now ${status.replace('_', ' ')}.`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update the ticket. Refresh and retry.') }
    finally { setBusy(false) }
  }
  async function send(action: KitchenRequest) {
    if (busy) return
    setPending(action); setBusy(true); setError(''); setNotice('')
    try {
      await putPendingKitchen(scopeOf(session), action)
      if (action.kind === 'delay') await sendKitchenDelay(session, action.input)
      else await setKitchenAvailability(session, action.input)
      await clearPendingKitchen(scopeOf(session)); setPending(null)
      await refresh()
      setNotice(action.kind === 'delay' ? 'Delay sent to Dining.' : 'Menu availability updated for Dining.')
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : 'Could not confirm the change.'} Retry the same request before making another change.`)
    } finally { setBusy(false) }
  }
  function delay(ticket: KitchenTicket, minutes: number) {
    const trimmed = reason.trim()
    if (trimmed.length < 3) { setError('Enter a reason for the delay.'); return }
    void send({ kind: 'delay', input: { requestId: Crypto.randomUUID(), orderId: ticket.id, delayMinutes: minutes, reason: trimmed } })
  }
  function availability(product: KitchenQueue['products'][number]) {
    const available = !product.available
    Alert.alert(available ? 'Make available?' : 'Mark unavailable?', `${product.name} will ${available ? 'appear on' : 'be removed from'} the Dining menu.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', onPress: () => void send({ kind: 'availability', input: { requestId: Crypto.randomUUID(), productId: product.id, available } }) },
    ])
  }
  const counts = kitchenCounts(queue?.orders ?? [])
  const orders = visibleKitchenOrders(queue?.orders ?? [], orderFilter, orderSearch)
  const products = visibleKitchenProducts(queue?.products ?? [], stockSearch, unavailableOnly)
  const unavailableCount = queue?.products.filter(product => !product.available).length ?? 0
  return <><ScrollView ref={scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.title}>Kitchen</Text><Text style={styles.sub}>KOTs and menu availability for {session.branch.name}</Text>
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!!notice && <Text style={styles.notice}>{notice}</Text>}
    {pending && <View style={styles.pending}><Text style={styles.bold}>Unconfirmed kitchen request</Text>
      <Text>Retry the same request to confirm it was saved once.</Text>
      <Button title={busy ? 'Checking…' : 'Retry request'} disabled={busy} onPress={() => void send(pending)} /></View>}
    <View style={styles.tabs}><Button title={`Orders (${counts.all})`} onPress={() => selectTab('orders')} selected={tab === 'orders'} /><Button title={`Stock (${unavailableCount} out)`} onPress={() => selectTab('stock')} selected={tab === 'stock'} /><Button title={`Messages${staffUnreadCount ? ` (${staffUnreadCount})` : ''}`} onPress={() => selectTab('messages')} selected={tab === 'messages'} /><Button title="Settings" onPress={() => selectTab('settings')} selected={tab === 'settings'} /></View>
    <View style={{ display: tab === 'messages' ? 'flex' : 'none' }}><VoicePanel session={session} onNotification={onNotification} openConversationSignal={messageOpenSignal} visible={tab === 'messages'} onUnreadCountChange={setStaffUnreadCount} /></View>
    {tab === 'settings' && <NotificationSettings sound={alertSound} onChange={onAlertSoundChange} onPreview={onPreviewSound} />}
    {tab === 'orders' ? <>
      <Text style={styles.sub}>Oldest orders first. New: {counts.ordering} · Preparing: {counts.preparing} · Ready: {counts.ready}</Text>
      <TextInput style={styles.input} value={orderSearch} onChangeText={setOrderSearch} placeholder="Find table, order number or item" accessibilityLabel="Search kitchen orders" />
      <View style={styles.tabs}>{(['all', 'ordering', 'preparing', 'ready'] as const).map(status => <Button key={status} title={`${status === 'all' ? 'All' : status === 'ordering' ? 'New' : status === 'preparing' ? 'Preparing' : 'Ready'} (${counts[status]})`} onPress={() => setOrderFilter(status)} selected={orderFilter === status} />)}</View>
      {!orders.length && <Text style={styles.sub}>{counts.all ? 'No orders match this search or filter.' : 'No open KOTs. Refresh to check again.'}</Text>}
      {orders.map(ticket => <View key={ticket.ticketId} style={styles.card}>
        <Text style={styles.bold}>#{ticket.orderNumber} · {ticket.type === 'dine_in' ? `Table ${ticket.tableName ?? 'unknown'}` : ticket.type} · {ticket.status}</Text>
        <Text style={styles.sub}>Received {new Date(ticket.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {ticket.items.reduce((total, item) => total + item.quantity, 0)} items</Text>
        {ticket.items.map(item => <Text key={item.id} style={styles.item}>{item.quantity} × {item.productName}{item.note ? ` · ${item.note}` : ''}</Text>)}
        {!!ticket.kitchenMessage && <Text style={styles.bold}>Kitchen message: {ticket.kitchenMessage}</Text>}
        {ticket.status === 'ordering' && <Button title="Start preparing" disabled={busy || !!pending} onPress={() => void update(ticket, 'preparing')} />}
        {ticket.status === 'preparing' && <Button title="Ready to serve" selected disabled={busy || !!pending} onPress={() => void update(ticket, 'ready')} />}
        {ticket.status === 'ready' && <Button title="Served / hand to waiter" disabled={busy || !!pending} onPress={() => void update(ticket, 'payment_pending')} />}
        {ticket.type === 'dine_in' && ticket.status !== 'ready' && <View style={styles.delay}>
          <Text style={styles.bold}>Tell Dining about a delay</Text>
          <TextInput style={styles.input} value={reason} onChangeText={setReason} maxLength={250} placeholder="Reason, e.g. kitchen is busy" />
          <View style={styles.tabs}><Button title="Busy kitchen" onPress={() => setReason('Kitchen is busy')} /><Button title="Ingredient delay" onPress={() => setReason('Waiting for ingredients')} /></View>
          <View style={styles.tabs}><Button title="+5 min" disabled={busy || !!pending} onPress={() => delay(ticket, 5)} /><Button title="+10 min" disabled={busy || !!pending} onPress={() => delay(ticket, 10)} /></View>
        </View>}
      </View>)}</> : tab === 'stock' ? <>
      <TextInput style={styles.input} value={stockSearch} onChangeText={setStockSearch} placeholder="Find a menu item" accessibilityLabel="Search kitchen stock" />
      <View style={styles.tabs}><Button title="All items" onPress={() => setUnavailableOnly(false)} selected={!unavailableOnly} /><Button title={`Out of stock (${unavailableCount})`} onPress={() => setUnavailableOnly(true)} selected={unavailableOnly} /></View>
      {!products.length && <Text style={styles.sub}>{queue?.products.length ? 'No items match this search or filter.' : 'No menu products loaded.'}</Text>}
      {products.map(product => <View key={product.id} style={styles.stockRow}><View style={styles.grow}><Text style={styles.bold}>{product.name}</Text><Text style={product.available ? styles.available : styles.unavailable}>{product.available ? 'Available' : 'Unavailable'}</Text></View>
        <Button title={product.available ? 'Mark out' : 'Make available'} disabled={busy || !!pending} onPress={() => availability(product)} /></View>)}</> : null}
    <Button title="Refresh" disabled={busy} onPress={() => void refresh().catch(cause => setError(cause instanceof Error ? cause.message : 'Could not refresh.'))} />
    <Button title="Sign out" disabled={busy || !!pending} onPress={onSignOut} />
  </ScrollView></>
}

function Button({ title, onPress, disabled, selected }: { title: string; onPress: () => void; disabled?: boolean; selected?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={[styles.button, selected && styles.selected, disabled && styles.disabled]}><Text style={[styles.buttonText, selected && styles.selectedText]}>{title}</Text></Pressable>
}

const styles = StyleSheet.create({
  content: { padding: 18, paddingBottom: 50, gap: 10 }, title: { fontSize: 26, fontWeight: '700', color: '#302525' },
  sub: { color: '#756b69' }, bold: { fontWeight: '700', color: '#302525' }, item: { color: '#5e4543', paddingTop: 5 },
  card: { padding: 16, borderWidth: 1, borderColor: '#ead9d7', backgroundColor: '#fff', borderRadius: 12, gap: 6 },
  tabs: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' }, button: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 9, borderWidth: 1, borderColor: '#e5c9c6', backgroundColor: '#fff' },
  selected: { backgroundColor: '#b4342f', borderColor: '#b4342f' }, buttonText: { color: '#b4342f', fontWeight: '700' }, selectedText: { color: '#fff' }, disabled: { opacity: 0.5 },
  delay: { marginTop: 8, padding: 10, backgroundColor: '#fff8e9', borderRadius: 9, gap: 8 },
  input: { borderWidth: 1, borderColor: '#e5c9c6', borderRadius: 8, backgroundColor: '#fff', minHeight: 44, padding: 10 },
  stockRow: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 9, backgroundColor: '#fff', gap: 10 },
  grow: { flex: 1 }, available: { color: '#b4342f' }, unavailable: { color: '#a8322c' },
  error: { color: '#9b3028', backgroundColor: '#fff2ef', padding: 12 }, notice: { color: '#a52c28', backgroundColor: '#fff1ef', padding: 12 },
  pending: { backgroundColor: '#fff2da', padding: 12, borderRadius: 9, gap: 8 },
})
