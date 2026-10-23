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
export class ApiError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status } }

export function serverUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter the restaurant HTTPS address only.')
  return url.origin
}

async function request<T>(server: string, action: string, input: unknown, token?: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${server}/api/mobile/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ input }),
    })
  } catch { throw new Error('Cannot reach the restaurant server. Keep your draft and try again.') }
  const payload = await response.json() as { result?: T; error?: string }
  if (!response.ok) throw new ApiError(payload.error ?? 'The operation failed.', response.status)
  return payload.result as T
}

export async function login(server: string, branchId: string, username: string, password: string): Promise<Session> {
  const result = await request<{ token: string; staff: Staff; branch: Branch }>(server, 'login', { branchId, username, password })
  return { ...result, server }
}
export const getMenu = (session: Session) => request<Menu>(session.server, 'menu', null, session.token)
export const requestPrint = (session: Session, input: PrintInput) => request<PrintJob>(session.server, 'print', input, session.token)
export const sendOrder = (session: Session, input: OrderInput) => request<unknown>(session.server, 'order', input, session.token)
export const logout = (session: Session) => request<void>(session.server, 'logout', null, session.token)
