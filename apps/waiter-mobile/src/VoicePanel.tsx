import { useEffect, useRef, useState, type ComponentRef } from 'react'
import { AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import * as Crypto from 'expo-crypto'
import { AudioModule, createAudioPlayer, RecordingPresets, setAudioModeAsync, useAudioRecorder, type AudioPlayer } from 'expo-audio'
import { File } from 'expo-file-system'
import { listStaffMessages, sendTextMessage, sendVoiceMessage, voiceMessageUrl, type Session, type StaffMessage } from './api'
import { getStaffMessageRead, hasHeardStaffNotification, markStaffMessagesRead, markStaffNotificationHeard, scopeOf } from './storage'
import { isFreshNotification, notificationTime } from './notificationTime'
import { trackVisibleStaffChat } from './pushNotifications'

const messageTime = (value: string) => {
  const time = new Date(notificationTime(value))
  return Number.isNaN(time.getTime()) ? value : time.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}
const messageDay = (value: string) => {
  const time = new Date(notificationTime(value))
  return Number.isNaN(time.getTime()) ? value.slice(0, 10) : time.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function VoicePanel({ session, onNotification, tableContext, openConversationSignal = 0, visible = true, onUnreadCountChange }: { session: Session; onNotification: (title: string, message: string, messageId?: string) => void; tableContext?: { tableId: string; tableName: string }; openConversationSignal?: number; visible?: boolean; onUnreadCountChange?: (count: number) => void }) {
  const recorder = useAudioRecorder(RecordingPresets.LOW_QUALITY)
  const player = useRef<AudioPlayer | null>(null)
  const threadScroll = useRef<ComponentRef<typeof ScrollView> | null>(null)
  const alerting = useRef(false)
  const recordingRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef(false)
  const [recording, setRecording] = useState(false)
  const [messages, setMessages] = useState<StaffMessage[]>([])
  const [draft, setDraft] = useState('')
  const [pendingText, setPendingText] = useState<{ requestId: string; text: string; tableId?: string } | null>(null)
  const [sendingText, setSendingText] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [playingId, setPlayingId] = useState('')
  const [conversationOpen, setConversationOpen] = useState(!!tableContext)
  const [conversationQuery, setConversationQuery] = useState('')
  const [unreadCount, setUnreadCount] = useState(0)
  const otherTeam = session.workspace === 'kitchen' ? 'Dining' : 'Kitchen'
  useEffect(() => { if (openConversationSignal) setConversationOpen(true) }, [openConversationSignal])
  useEffect(() => visible && conversationOpen ? trackVisibleStaffChat() : undefined, [visible, conversationOpen])

  async function refresh() {
    const next = await listStaffMessages(session)
    if (!Array.isArray(next)) return
    setMessages(next)
    const scope = scopeOf(session)
    const read = await getStaffMessageRead(scope)
    const incoming = next.filter(message => message.target === (session.workspace ?? 'dining'))
    if (visible && conversationOpen && AppState.currentState === 'active' && incoming.length) {
      await markStaffMessagesRead(scope, incoming[0].createdAt, incoming[0].id)
      setUnreadCount(0)
      onUnreadCountChange?.(0)
    } else {
      const unread = incoming.filter(message => !read || message.createdAt > read.created_at || (message.createdAt === read.created_at && message.id > read.message_id)).length
      setUnreadCount(unread)
      onUnreadCountChange?.(unread)
    }
    if (alerting.current || AppState.currentState !== 'active') return
    alerting.current = true
    try {
      let newest: StaffMessage | undefined
      for (const message of next) {
        if (message.target !== (session.workspace ?? 'dining')) continue
        if (await hasHeardStaffNotification(scope, 'voice', message.id)) continue
        await markStaffNotificationHeard(scope, 'voice', message.id)
        if (!newest && isFreshNotification(message.createdAt)) newest = message
      }
      if (newest && !recordingRef.current && !(visible && conversationOpen)) {
        onNotification(newest.tableName ? `${newest.senderName || otherTeam} · Table ${newest.tableName}` : newest.senderName || otherTeam, newest.kind === 'voice' ? 'Voice message' : newest.text || 'New message', newest.id)
      }
    } finally { alerting.current = false }
  }
  useEffect(() => {
    void refresh().catch(() => {})
    const interval = setInterval(() => { if (AppState.currentState === 'active') void refresh().catch(() => {}) }, 5000)
    return () => {
      clearInterval(interval)
      if (timer.current) clearTimeout(timer.current)
      player.current?.release()
    }
  }, [session, onNotification, visible, conversationOpen])

  async function finish() {
    if (inFlight.current) return
    inFlight.current = true
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    setError(''); setInfo('Sending voice message...')
    try {
      await recorder.stop()
      recordingRef.current = false
      setRecording(false)
      const uri = recorder.uri
      if (!uri) throw new Error('No recording was saved. Try again.')
      const file = new File(uri)
      if (file.size > 192 * 1024) throw new Error('Recording is too large. Keep it under 15 seconds.')
      const mime = uri.toLowerCase().endsWith('.3gp') ? 'audio/3gpp' : 'audio/mp4'
      await sendVoiceMessage(session, { requestId: Crypto.randomUUID(), mime, audio: await file.base64(), tableId: tableContext?.tableId })
      setInfo(`Sent to ${session.workspace === 'kitchen' ? 'Dining' : 'Kitchen'}.`)
      await refresh()
    } catch (cause) {
      recordingRef.current = false
      setRecording(false)
      setInfo('')
      setError(cause instanceof Error ? cause.message : 'Could not send the voice message.')
    } finally { inFlight.current = false }
  }
  async function sendText() {
    const payload = pendingText ?? { requestId: Crypto.randomUUID(), text: draft.trim(), tableId: tableContext?.tableId }
    if (!payload.text || sendingText) return
    setPendingText(payload); setSendingText(true); setError('')
    try {
      await sendTextMessage(session, payload)
      setPendingText(null); setDraft('')
      setInfo(`Sent to ${session.workspace === 'kitchen' ? 'Dining' : 'Kitchen'}.`)
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send the message. Retry to confirm it was sent once.') }
    finally { setSendingText(false) }
  }
  async function start() {
    if (inFlight.current) return
    inFlight.current = true
    setError(''); setInfo('')
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync()
      if (!permission.granted) throw new Error('Microphone permission is needed for push to talk.')
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true })
      await recorder.prepareToRecordAsync()
      recorder.record({ forDuration: 15 })
      recordingRef.current = true
      setRecording(true)
      timer.current = setTimeout(() => { void finish() }, 14_500)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start recording.') }
    finally { inFlight.current = false }
  }
  async function play(message: StaffMessage) {
    try {
      player.current?.release()
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false })
      const next = createAudioPlayer({ uri: voiceMessageUrl(session, message.id),
        headers: { Authorization: `Bearer ${session.token}` } })
      player.current = next
      setPlayingId(message.id)
      next.play()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not play the voice message.') }
  }

  const latest = messages[0]
  const orderedMessages = [...messages].reverse()
  const quickReplies = session.workspace === 'kitchen'
    ? ['Preparing', 'Order ready', 'Please wait', 'Item unavailable']
    : ['Order collected', 'Please wait', 'Customer is waiting']
  if (!conversationOpen) return <View style={styles.inbox}>
    <Text style={styles.title}>Messages</Text>
    <Text style={styles.hint}>Staff updates for this branch</Text>
    <TextInput accessibilityLabel="Search conversations" placeholder="Search conversations" placeholderTextColor="#9a8986" value={conversationQuery} onChangeText={setConversationQuery} style={styles.search} />
    {(otherTeam + ' team').toLowerCase().includes(conversationQuery.trim().toLowerCase()) &&
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${otherTeam} conversation`} onPress={() => setConversationOpen(true)} style={styles.conversation}>
      <View style={styles.avatar}><Text style={styles.avatarText}>{otherTeam[0]}</Text></View>
      <View style={styles.conversationCopy}>
        <Text style={styles.heading}>{otherTeam} team</Text>
        <Text numberOfLines={1} style={styles.preview}>{latest ? `${latest.senderId === session.staff.id ? 'You' : latest.senderName}: ${latest.kind === 'voice' ? '🎤 Voice message' : latest.text || 'Message'}` : 'Start a conversation'}</Text>
      </View>
      <View style={styles.conversationMeta}><Text style={styles.listTime}>{latest ? messageTime(latest.createdAt) : ''}</Text>{unreadCount > 0 && <Text style={styles.unread}>{unreadCount}</Text>}</View>
    </Pressable>}
    {!((otherTeam + ' team').toLowerCase().includes(conversationQuery.trim().toLowerCase())) && <Text style={styles.empty}>No conversations found</Text>}
  </View>
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.chat}>
    <View style={styles.chatHeader}>
      {!tableContext && <Pressable accessibilityRole="button" accessibilityLabel="Back to conversations" onPress={() => setConversationOpen(false)} style={styles.back}><Text style={styles.backText}>‹</Text></Pressable>}
      <View style={styles.avatarSmall}><Text style={styles.avatarText}>{otherTeam[0]}</Text></View>
      <View style={styles.conversationCopy}><Text style={styles.chatTitle}>{otherTeam} team</Text><Text style={styles.chatSubtitle}>{tableContext ? `Table ${tableContext.tableName} · ` : ''}Staff conversation</Text></View>
    </View>
    <ScrollView style={styles.thread} contentContainerStyle={styles.threadContent} onContentSizeChange={() => { threadScroll.current?.scrollToEnd({ animated: false }) }} ref={threadScroll}>
      {!messages.length && <Text style={styles.emptyChat}>No messages yet. Send the first update.</Text>}
      {orderedMessages.map((message, index) => <View key={message.id}>
        {(index === 0 || messageDay(orderedMessages[index - 1].createdAt) !== messageDay(message.createdAt)) && <Text style={styles.day}>{messageDay(message.createdAt)}</Text>}
        <View style={[styles.bubble, message.senderId === session.staff.id ? styles.outgoing : styles.incoming]}>
        <Text style={styles.messageText}>{message.senderId === session.staff.id ? 'You' : message.senderName}{message.tableName ? ' · Table ' + message.tableName : ''}</Text>
        {message.kind === 'text' ? <Text style={styles.messageBody}>{message.text}</Text> :
          <Pressable style={styles.voicePlay} accessibilityRole="button" accessibilityLabel={`Play voice message from ${message.senderName}`} onPress={() => { void play(message) }}>
            <Text style={styles.voicePlayText}>{playingId === message.id ? '▶ Playing voice message' : '▶ Play voice message'}</Text></Pressable>}
        <Text style={styles.time}>{messageTime(message.createdAt)}</Text>
        </View>
      </View>)}
    </ScrollView>
    {tableContext && <Pressable accessibilityRole="button" onPress={() => setDraft(`Customer at Table ${tableContext.tableName} is waiting for the order. Please update the expected time.`)} disabled={!!pendingText || sendingText} style={styles.quickReply}><Text style={styles.quickReplyText}>Customer waiting at Table {tableContext.tableName}</Text></Pressable>}
    <View style={styles.quickReplies}>{quickReplies.map(reply => <Pressable key={reply} accessibilityRole="button" accessibilityLabel={`Use quick reply: ${reply}`}
      disabled={!!pendingText || sendingText} onPress={() => setDraft(tableContext ? `Table ${tableContext.tableName}: ${reply}.` : `${reply}.`)} style={styles.quickReply}>
      <Text style={styles.quickReplyText}>{reply}</Text>
    </Pressable>)}</View>
    <View style={styles.composer}>
      <TextInput accessibilityLabel="Type a message" style={styles.composerInput} placeholder={`Message ${session.workspace === 'kitchen' ? 'Dining' : 'Kitchen'}`} placeholderTextColor="#9a8986" value={draft} onChangeText={setDraft} editable={!pendingText && !sendingText} maxLength={500} multiline />
      {draft.trim() || pendingText ? <Pressable accessibilityRole="button" accessibilityLabel={pendingText ? 'Retry sending message' : 'Send message'} onPress={() => void sendText()} disabled={sendingText} style={styles.roundAction}><Text style={styles.roundActionText}>{sendingText ? '…' : '➤'}</Text></Pressable> : <Pressable accessibilityRole="button" accessibilityLabel={recording ? 'Send voice message' : 'Record voice message'} onPress={() => { void (recording ? finish() : start()) }} style={[styles.roundAction, recording && styles.recording]}><Text style={styles.roundActionText}>{recording ? '■' : '🎤'}</Text></Pressable>}
    </View>
    {recording && <Text style={styles.recordingHint}>Recording · Tap the stop button to send (15 seconds maximum)</Text>}
    {pendingText && <Pressable accessibilityRole="button" onPress={() => { setPendingText(null); setDraft(''); setError('') }}>
      <Text style={styles.error}>Discard unsent message</Text></Pressable>}
    {!!info && <Text style={styles.info}>{info}</Text>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </KeyboardAvoidingView>
}

const styles = StyleSheet.create({
  inbox: { padding: 18, minHeight: 420, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: '800', color: '#2e2423' },
  hint: { marginTop: 4, color: '#82716f', fontSize: 13 },
  search: { marginTop: 20, minHeight: 48, paddingHorizontal: 16, borderRadius: 24, backgroundColor: '#f8f2f1', color: '#302525' },
  heading: { fontSize: 16, fontWeight: '700', color: '#302525' },
  preview: { marginTop: 5, color: '#756b69', fontSize: 13 },
  info: { marginHorizontal: 12, marginVertical: 5, color: '#8c302b' }, error: { marginHorizontal: 12, marginVertical: 5, color: '#a02b26' },
  conversation: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 82, borderBottomWidth: 1, borderBottomColor: '#f0e4e2' },
  conversationCopy: { flex: 1 },
  conversationMeta: { alignItems: 'flex-end', gap: 6 },
  listTime: { color: '#93817e', fontSize: 11 },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#b33732', alignItems: 'center', justifyContent: 'center' },
  avatarSmall: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#b33732', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: 20 },
  empty: { color: '#82716f', textAlign: 'center', marginTop: 30 },
  chat: { backgroundColor: '#f8f3f1', minHeight: 520, borderWidth: 1, borderColor: '#ead8d5', borderRadius: 15, overflow: 'hidden' },
  chatHeader: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#ead8d5' },
  back: { width: 28, justifyContent: 'center' }, backText: { color: '#a62f2b', fontSize: 36, lineHeight: 40 },
  chatTitle: { color: '#2e2423', fontWeight: '800', fontSize: 17 },
  chatSubtitle: { color: '#82716f', fontSize: 12, marginTop: 2 },
  thread: { minHeight: 260, maxHeight: 440 },
  threadContent: { padding: 14, gap: 8, flexGrow: 1 },
  emptyChat: { alignSelf: 'center', marginTop: 90, padding: 12, color: '#82716f', backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' },
  unread: { backgroundColor: '#b33732', color: '#fff', fontWeight: '700', overflow: 'hidden', borderRadius: 12, minWidth: 22, textAlign: 'center', paddingHorizontal: 6, paddingVertical: 3 },
  bubble: { maxWidth: '86%', minWidth: 100, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 15, elevation: 1 },
  outgoing: { alignSelf: 'flex-end', backgroundColor: '#f9dfdc', borderBottomRightRadius: 3 },
  incoming: { alignSelf: 'flex-start', backgroundColor: '#fff', borderBottomLeftRadius: 3 },
  messageText: { color: '#9c302c', fontSize: 12, fontWeight: '700' },
  messageBody: { color: '#2e2423', fontSize: 15, lineHeight: 21, marginTop: 4 },
  voicePlay: { paddingVertical: 8 }, voicePlayText: { color: '#9c302c', fontWeight: '700' },
  time: { color: '#817775', fontSize: 11, marginTop: 6, alignSelf: 'flex-end' },
  day: { alignSelf: 'center', color: '#82716f', backgroundColor: '#fff', overflow: 'hidden', borderRadius: 10, fontSize: 11, paddingHorizontal: 10, paddingVertical: 5, marginVertical: 8 },
  quickReplies: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingHorizontal: 10, paddingVertical: 8 },
  quickReply: { borderWidth: 1, borderColor: '#dfbdb9', backgroundColor: '#fff', borderRadius: 18, paddingHorizontal: 10, paddingVertical: 7 },
  quickReplyText: { color: '#9c302c', fontWeight: '600', fontSize: 12 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#ead8d5' },
  composerInput: { flex: 1, maxHeight: 120, minHeight: 46, borderWidth: 1, borderColor: '#e2c9c7', borderRadius: 23, paddingHorizontal: 15, paddingVertical: 10, color: '#302525', backgroundColor: '#fff' },
  roundAction: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: '#b33732' },
  roundActionText: { color: '#fff', fontSize: 22, fontWeight: '700' },
  recording: { backgroundColor: '#83221f' },
  recordingHint: { color: '#a02b26', fontSize: 12, paddingHorizontal: 14, paddingBottom: 8 },
})
