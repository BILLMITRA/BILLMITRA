export type Staff = { id: string; displayName: string; username: string; role: string }
export type Branch = { id: string; name: string }
export type Product = { id: string; categoryId: string; name: string; pricePaise: number; available: boolean }
export type Table = { id: string; name: string; floor: string; orderId: string | null; startedAt: string | null }
export type ExistingOrder = { id: string; orderNumber: number; createdAt: string; type: 'dine_in' | 'parcel' | 'delivery'; tableId: string | null; customerName: string; kitchenMessage?: string; totalPaise: number; savedAt?: string | null; discount: null | { kind: 'percentage'; valueBps: number } | { kind: 'fixed'; valuePaise: number }; items: { id: string; productName: string; quantity: number; unitPricePaise: number; note: string }[]; kitchenTickets?: { id: string; createdAt: string }[] }
export type PrintInput = { requestId: string; orderId: string; kind: 'bill' | 'kot'; ticketId?: string; copy?: boolean }
export type SaveBillInput = { orderId: string }
export type PrintJob = { id: string; orderId: string; kind: 'bill' | 'kot'; ticketId: string | null; status: 'queued' | 'printing' | 'submitted' | 'failed' | 'unknown'; error: string; copy: boolean }
export type KitchenNotice = { id: string; kind: 'delay' | 'availability'; orderId: string | null; productId: string | null;
  available: number | null; delayMinutes: number | null; reason: string; actor: string; createdAt: string;
  productName: string | null; tableId: string | null; tableName: string | null }
export type KitchenTicket = ExistingOrder & { ticketId: string; tableName: string | null; status: 'ordering' | 'preparing' | 'ready';
  items: ExistingOrder['items'] }
export type KitchenQueue = { orders: KitchenTicket[]; products: { id: string; name: string; available: number }[] }
export type VoiceMessage = { id: string; senderName: string; mime: 'audio/mp4' | 'audio/3gpp'; createdAt: string }
export type StaffMessage = { id: string; kind: 'voice' | 'text'; senderId: string; senderName: string;
  target: 'dining' | 'kitchen'; text: string | null; mime: VoiceMessage['mime'] | null; createdAt: string; tableId?: string | null; tableName?: string | null }
export type KitchenRequest = { kind: 'delay'; input: { requestId: string; orderId: string; delayMinutes: number; reason: string } }
  | { kind: 'availability'; input: { requestId: string; productId: string; available: boolean } }
export type WaitingAlert = { id: string; tableId: string; tableName: string; seatedAt: number; createdAt: number; acknowledgedAt: number | null }
export type WaitingState = { alerts: WaitingAlert[]; seatedTableIds: string[] }
export type Menu = { categories: { id: string; name: string }[]; products: Product[]; tables: Table[]; activeOrders: ExistingOrder[]; printJobs?: PrintJob[]; notices?: KitchenNotice[]; waiting?: WaitingState }
export type Session = { token: string; staff: Staff; branch: Branch; server: string; workspace?: 'dining' | 'kitchen' }
export const RESTAURANT_SERVER = 'https://mobile.billmitra.shop'
export type Line = { productId: string; quantity: number; note: string }
export type OrderInput = { requestId: string; type: 'dine_in'; tableId: string; customerName: string; deliveryAddress: ''; discount: ExistingOrder['discount']; items: Line[]; orderId?: string }
export class ApiError extends Error {
  status: number
  kind: 'http' | 'protocol' | 'network' | 'timeout'
  constructor(message: string, status = 0, kind: ApiError['kind'] = 'http') { super(message); this.name = 'ApiError'; this.status = status; this.kind = kind }
}

export function serverUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Enter the restaurant HTTPS address only.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter the restaurant HTTPS address only.')
  return url.origin
}

async function request<T>(server: string, action: string, input: unknown, token?: string): Promise<T> {
  const origin = serverUrl(server)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(`${origin}/api/mobile/${action}`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ input }), signal: controller.signal,
    })
    const text = await response.text()
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
    const unavailable = `Restaurant server unavailable (HTTP ${response.status}). Ask your manager to check the server or tunnel.`
    const malformed = `The restaurant server returned an invalid API response (HTTP ${response.status}). Ask your manager to check server routing.`
    // Proxy responses are untrusted: never display or log their body, which may contain secrets.
    if (!/^application\/(?:[\w.-]+\+)?json$/.test(type)) {
      const edgeCode = /^error code:\s*(\d{3,5})\s*$/i.exec(text.trim())?.[1]
      throw new ApiError(edgeCode ? `${unavailable} (Gateway code ${edgeCode}.)` : response.status >= 500 ? unavailable : malformed, response.status, 'protocol')
    }
    let payload: unknown
    try { payload = JSON.parse(text) } catch { throw new ApiError(response.status >= 500 ? unavailable : malformed, response.status, 'protocol') }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ApiError(malformed, response.status, 'protocol')
    const record = payload as Record<string, unknown>
    if (!response.ok) {
      if (typeof record.error !== 'string' || !record.error.trim()) throw new ApiError(malformed, response.status, 'protocol')
      throw new ApiError(response.status >= 500 ? unavailable : record.error, response.status)
    }
    if (!Object.hasOwn(record, 'result') || record.error != null || record.ok === false) throw new ApiError(malformed, response.status, 'protocol')
    return record.result as T
  } catch (cause) {
    if (cause instanceof ApiError) throw cause
    if (controller.signal.aborted) throw new ApiError('The restaurant server timed out. Check the connection and retry. Your saved drafts are kept.', 0, 'timeout')
    throw new ApiError('Cannot reach the restaurant server. Check your connection and ask your manager to check the server. Your saved drafts are kept.', 0, 'network')
  } finally { clearTimeout(timeout) }
}

export async function login(server: string, branchId: string, username: string, password: string, workspace: 'dining' | 'kitchen' = 'dining'): Promise<Session> {
  const origin = serverUrl(server)
  const result = await request<{ token: string; staff: Staff; branch: Branch; workspace: 'dining' | 'kitchen' }>(origin, 'login', { branchId, username, password, workspace })
  const strings = (value: unknown, keys: string[]): boolean => !!value && typeof value === 'object' && keys.every(key => typeof (value as Record<string, unknown>)[key] === 'string' && Boolean((value as Record<string, unknown>)[key]))
  if (!result || typeof result.token !== 'string' || !/^[a-f0-9]{64}$/.test(result.token) || !strings(result.staff, ['id', 'displayName', 'username', 'role']) || !strings(result.branch, ['id', 'name']) || result.branch.id !== branchId) {
    throw new ApiError('The restaurant server returned invalid sign-in details. Ask your manager to check the server version.', 200, 'protocol')
  }
  if ((result.workspace ?? 'dining') !== workspace) throw new ApiError('The restaurant server returned the wrong workspace.', 200, 'protocol')
  return { ...result, workspace, server: origin }
}
export async function getMenu(session: Session): Promise<Menu> {
  const menu = await request<Menu>(session.server, 'menu', null, session.token)
  if (!menu || !['categories', 'products', 'tables', 'activeOrders'].every(key => Array.isArray((menu as unknown as Record<string, unknown>)[key]))) {
    throw new ApiError('The restaurant server returned invalid menu data. Ask your manager to check the server version.', 200, 'protocol')
  }
  return menu
}
export const requestPrint = (session: Session, input: PrintInput) => request<PrintJob>(session.server, 'print', input, session.token)
export const sendOrder = (session: Session, input: OrderInput) => request<ExistingOrder>(session.server, 'order', input, session.token)
export const saveBill = (session: Session, input: SaveBillInput) => request<ExistingOrder>(session.server, 'save-bill', input, session.token)
export const transferTable = (session: Session, input: { orderId: string; fromTableId: string; toTableId: string }) =>
  request<ExistingOrder>(session.server, 'transfer-table', input, session.token)
export const logout = (session: Session) => request<void>(session.server, 'logout', null, session.token)
export const registerPushToken = (session: Session, token: string) => request<void>(session.server, 'push-token', { token }, session.token)
export const removePushToken = (session: Session) => request<void>(session.server, 'push-token-delete', null, session.token)
export async function getKitchenQueue(session: Session): Promise<KitchenQueue> {
  const queue = await request<KitchenQueue>(session.server, 'queue', null, session.token)
  if (!queue || !Array.isArray(queue.orders) || !Array.isArray(queue.products)) throw new ApiError('The restaurant server returned an invalid kitchen queue.', 200, 'protocol')
  return queue
}
export const updateKitchenStatus = (session: Session, input: { orderId: string; ticketId: string; status: 'preparing' | 'ready' | 'payment_pending' }) => request<void>(session.server, 'status', input, session.token)
export const setKitchenAvailability = (session: Session, input: { requestId: string; productId: string; available: boolean }) => request<void>(session.server, 'availability', input, session.token)
export const sendKitchenDelay = (session: Session, input: { requestId: string; orderId: string; delayMinutes: number; reason: string }) => request<void>(session.server, 'delay', input, session.token)
export const acknowledgeKitchenNotice = (session: Session, noticeId: string) => request<void>(session.server, 'ack-notice', noticeId, session.token)
export const confirmWaitingSeat = (session: Session, tableId: string, occupied: boolean) => request<WaitingState>(session.server, 'waiting-confirm', { tableId, occupied }, session.token)
export const acknowledgeWaitingAlert = (session: Session, alertId: string) => request<WaitingState>(session.server, 'waiting-ack', alertId, session.token)
export const listVoiceMessages = (session: Session) => request<VoiceMessage[]>(session.server, 'voice-list', null, session.token)
export const listStaffMessages = (session: Session) => request<StaffMessage[]>(session.server, 'message-list', null, session.token)
export const sendTextMessage = (session: Session, input: { requestId: string; text: string; tableId?: string }) =>
  request<{ id: string }>(session.server, 'message-send', input, session.token)
export const sendVoiceMessage = (session: Session, input: { requestId: string; mime: VoiceMessage['mime']; audio: string; tableId?: string }) =>
  request<{ id: string }>(session.server, 'voice-send', input, session.token)
export const voiceMessageUrl = (session: Session, id: string) => `${session.server}/api/mobile/voice/${encodeURIComponent(id)}`
