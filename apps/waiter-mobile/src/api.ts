export type Staff = { id: string; displayName: string; username: string; role: string }
export type Branch = { id: string; name: string }
export type Product = { id: string; categoryId: string; name: string; pricePaise: number; available: boolean }
export type Table = { id: string; name: string; floor: string; orderId: string | null; startedAt: string | null }
export type ExistingOrder = { id: string; orderNumber: number; createdAt: string; tableId: string | null; customerName: string; discount: null | { kind: 'percentage'; valueBps: number } | { kind: 'fixed'; valuePaise: number }; items: { id: string; productName: string; quantity: number; note: string }[]; kitchenTickets?: { id: string; createdAt: string }[] }
export type PrintInput = { requestId: string; orderId: string; kind: 'bill' | 'kot'; ticketId?: string }
export type PrintJob = { id: string; orderId: string; kind: 'bill' | 'kot'; ticketId: string | null; status: 'queued' | 'printing' | 'submitted' | 'failed' | 'unknown'; error: string; copy: boolean }
export type Menu = { categories: { id: string; name: string }[]; products: Product[]; tables: Table[]; activeOrders: ExistingOrder[]; printJobs?: PrintJob[] }
export type Session = { token: string; staff: Staff; branch: Branch; server: string }
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
    const unavailable = `Restaurant server unavailable (HTTP ${response.status}). Check the restaurant address and ask your manager to check the server or tunnel.`
    const malformed = `The restaurant server returned an invalid API response (HTTP ${response.status}). Check the restaurant address and server routing.`
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
    throw new ApiError('Cannot reach the restaurant server. Check your connection and the restaurant address. Your saved drafts are kept.', 0, 'network')
  } finally { clearTimeout(timeout) }
}

export async function login(server: string, branchId: string, username: string, password: string): Promise<Session> {
  const origin = serverUrl(server)
  const result = await request<{ token: string; staff: Staff; branch: Branch }>(origin, 'login', { branchId, username, password })
  const strings = (value: unknown, keys: string[]): boolean => !!value && typeof value === 'object' && keys.every(key => typeof (value as Record<string, unknown>)[key] === 'string' && Boolean((value as Record<string, unknown>)[key]))
  if (!result || typeof result.token !== 'string' || !/^[a-f0-9]{64}$/.test(result.token) || !strings(result.staff, ['id', 'displayName', 'username', 'role']) || !strings(result.branch, ['id', 'name']) || result.branch.id !== branchId) {
    throw new ApiError('The restaurant server returned invalid sign-in details. Check the restaurant address and server version.', 200, 'protocol')
  }
  return { ...result, server: origin }
}
export async function getMenu(session: Session): Promise<Menu> {
  const menu = await request<Menu>(session.server, 'menu', null, session.token)
  if (!menu || !['categories', 'products', 'tables', 'activeOrders'].every(key => Array.isArray((menu as unknown as Record<string, unknown>)[key]))) {
    throw new ApiError('The restaurant server returned invalid menu data. Ask your manager to check the server version.', 200, 'protocol')
  }
  return menu
}
export const requestPrint = (session: Session, input: PrintInput) => request<PrintJob>(session.server, 'print', input, session.token)
export const sendOrder = (session: Session, input: OrderInput) => request<unknown>(session.server, 'order', input, session.token)
export const logout = (session: Session) => request<void>(session.server, 'logout', null, session.token)
