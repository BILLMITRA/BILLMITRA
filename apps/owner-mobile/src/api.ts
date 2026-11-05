export type Branch = { id: string; name: string; timezone: string; currencyCode: string }
export type Session = { token: string; server: string; owner: { id: string; displayName: string; username: string }; branches: Branch[]; writableBranchIds: string[] }
export type BranchSummary = Branch & { paidBills: number; paidSalesPaise: number; previousPaidSalesPaise: number; discountPaise: number; taxPaise: number; collectedPaise: number; refundedPaise: number; statuses: { status: string; count: number }[]; hours: { hourLocal: number; amountPaise: number }[] | null; payments: { method: string; amountPaise: number }[]; topProducts: { name: string; quantity: number }[]; recentSales: { id: string; orderNumber: number; paidAt: string; totalPaise: number }[] }
export type Summary = { date: string; updatedAt: string; branches: BranchSummary[]; totals: { paidBills: number; paidSalesPaise: number; previousPaidSalesPaise: number; discountPaise: number; taxPaise: number; collectedPaise: number; refundedPaise: number; netCollectionsPaise: number } }
export type Order = { id: string; branchId: string; branchName: string; orderNumber: number; orderType: string; status: string; customerName: string; totalPaise: number; createdAt: string; paidAt: string | null; voidedAt: string | null; tableName: string | null }
export type Product = { id: string; name: string; description: string; taxRateBps: number; active: number; categoryId: string; category: string; branchId: string; pricePaise: number | string; available: number }
export type InventoryItem = { id: string; branchId: string; name: string; unit: string; quantityMilli: number | string; reorderMilli: number | string }

function privateLanHost(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31))
}

export function normalizeServer(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Enter the restaurant HTTPS address.') }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && (['127.0.0.1', 'localhost'].includes(url.hostname)
      || ((__DEV__ || process.env.EXPO_PUBLIC_LAN_PREVIEW === '1') && privateLanHost(url.hostname)))))) {
    throw new Error('Enter the HTTPS restaurant address. A private Wi-Fi address is allowed only in Expo development.')
  }
  return url.origin
}

export async function ownerRequest<T>(session: Pick<Session, 'server' | 'token'>, action: string, input?: unknown): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(`${normalizeServer(session.server)}/api/owner/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: JSON.stringify({ input: input ?? null }), signal: controller.signal,
    })
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The restaurant server returned an unexpected response.')
    const result = await response.json() as { ok: boolean; result: T; error: string | null }
    if (!response.ok || !result.ok) throw new Error(result.error || 'The request failed.')
    return result.result
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The restaurant server timed out. Try again.')
    if (error instanceof TypeError) throw new Error('Cannot reach the restaurant server. Check its HTTPS address and connection.')
    throw error
  } finally { clearTimeout(timeout) }
}

export async function ownerLogin(server: string, username: string, password: string): Promise<Session> {
  const origin = normalizeServer(server)
  const result = await ownerRequest<Omit<Session, 'server'>>({ server: origin, token: '' }, 'login', { username, password })
  if (!/^[a-f0-9]{64}$/.test(result.token) || !Array.isArray(result.branches) || !result.owner?.id) throw new Error('The server returned invalid owner sign-in details.')
  return { ...result, server: origin }
}
