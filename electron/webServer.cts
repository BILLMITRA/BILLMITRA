import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import { ZodError } from 'zod'
import { posChannels } from '../shared/posChannels.js'
import type { createPosBackend } from './backend.cjs'
import { OwnerApiError, type OwnerApi } from './ownerApi.cjs'

type Backend = ReturnType<typeof createPosBackend>
type Branch = { id: string; name: string; backend: Backend }
type Options = { backend: Backend; branches?: Branch[]; assetsDirectory: string; origin?: string; setupToken?: string; sessionLifetimeMs?: number;
  beforeOrderWrite?: (branchId: string) => Promise<void>; afterOrderWrite?: (branchId: string) => Promise<void>; ownerApi?: OwnerApi; ownerOnly?: boolean }
type Session = { id: number; expiresAt: number; branchId: string; backend: Backend; workspace?: 'dining' | 'kitchen'; pushToken?: string }
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.jpg': 'image/jpeg',
}
const mysqlOrderWrites = new Set([
  'createOrder', 'recordPayment', 'collectPayment', 'refundPayment', 'voidOrder', 'voidOrderItem',
  'splitOrder', 'joinOrders', 'updateKitchenStatus', 'saveCategory', 'saveProduct', 'addTable', 'saveCardSettings', 'createStaff', 'resetManagerPassword',
  'updateDeliverySchedule', 'assignDeliveryRider', 'assignDeliveryRiderBatch', 'operateDelivery',
  'recordDeliveryCashHandover', 'closeDeliveryRun',
  'saveDeliveryCustomer',
])
class MySqlOrderSyncError extends Error {}

export function createWebServer(options: Options) {
  const branches = options.branches ?? [{ id: 'main', name: 'Main branch', backend: options.backend }]
  if (!branches.length || branches.some(branch => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(branch.id) || !branch.name.trim()) || new Set(branches.map(branch => branch.id)).size !== branches.length) throw new Error('Branch IDs must be unique lowercase slugs and branch names are required.')
  if (options.origin && new URL(options.origin).origin !== options.origin) throw new Error('Configure an origin without a path or trailing slash.')
  const sessions = new Map<string, Session>()
  const mobileSessions = new Map<string, Session>()
  const pushNotified = new Set<string>()
  let nextId = 0
  const lifetime = options.sessionLifetimeMs ?? 8 * 60 * 60 * 1000

  function discard(token: string, session: Session) {
    session.backend.logout(session.id)
    sessions.delete(token)
  }
  const sweep = setInterval(() => {
    for (const [token, session] of sessions) if (session.expiresAt <= Date.now()) discard(token, session)
    for (const [token, session] of mobileSessions) if (session.expiresAt <= Date.now()) {
      session.backend.logout(session.id)
      mobileSessions.delete(token)
    }
  }, 60_000)
  sweep.unref()

  function json(response: ServerResponse, status: number, value: { result?: unknown; error?: string; branches?: unknown }) {
    const contents = JSON.stringify({ ...value, ok: status >= 200 && status < 300, result: value.result ?? (value.branches ? { branches: value.branches } : null), error: value.error ?? null })
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(contents)
  }

  function notifyMobileStaff(branchId: string, workspace: 'dining' | 'kitchen', key: string, title: string, message: string, data: Record<string, string> = {}) {
    if (pushNotified.has(key)) return
    pushNotified.add(key)
    if (pushNotified.size > 5000) pushNotified.clear()
    const tokens = [...new Set([...mobileSessions.values()]
      .filter(candidate => candidate.branchId === branchId && candidate.workspace === workspace && candidate.pushToken)
      .map(candidate => candidate.pushToken!))]
    if (!tokens.length) return
    void (async () => {
      for (let start = 0; start < tokens.length; start += 100) {
        const batch = tokens.slice(start, start + 100)
        try {
          const response = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate', 'Content-Type': 'application/json' },
            body: JSON.stringify(batch.map(to => ({ to, title, body: message,
              channelId: data.type === 'staff-message' ? 'billmitra_staff_messages' : 'staff-alerts',
              priority: 'high', data: { workspace, ...data } }))),
            signal: AbortSignal.timeout(5000),
          })
          if (!response.ok) return
          const payload = await response.json() as { data?: { status?: string; details?: { error?: string } }[] }
          for (const [index, ticket] of (payload.data ?? []).entries()) {
            if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
              for (const candidate of mobileSessions.values()) if (candidate.pushToken === batch[index]) delete candidate.pushToken
            }
          }
        } catch { /* Push delivery is best-effort; the saved operation remains successful. */ }
      }
    })()
  }

  const stopWaitingPush = branches.map(branch => branch.backend.onWaitingAlertCreated(alert => {
    notifyMobileStaff(branch.id, 'dining', `customer-waiting:${branch.id}:${alert.id}`,
      `Customer waiting · ${alert.tableName}`, `Please check ${alert.tableName}. The customer has waited five minutes without an order.`,
      { type: 'customer-waiting', tableId: alert.tableId, alertId: alert.id })
  }))

  async function body(request: IncomingMessage, maxBytes = 128 * 1024): Promise<{ input?: unknown }> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > maxBytes) throw new Error('Request too large.')
      chunks.push(Buffer.from(chunk))
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request.')
    return parsed
  }

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'same-origin')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    const address = server.address()
    const origin = options.origin ?? `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const expected = new URL(origin)
    if (request.headers.host !== expected.host) {
      json(response, 403, { error: 'Unrecognized server address.' })
      return
    }
    const path = (request.url ?? '/').split('?')[0]
    if (options.ownerOnly && path !== '/api/health' && !path.startsWith('/api/owner/')) {
      json(response, 404, { error: 'Unknown owner route.' })
      return
    }
    if (path === '/api/health' && request.method === 'GET') {
      try {
        for (const branch of branches) branch.backend.invoke(posChannels.getStaffAccessState, 0)
        json(response, 200, { result: { service: 'billmitra', ready: true } })
      } catch { json(response, 503, { error: 'The restaurant database is unavailable. Ask your manager to check the server.' }) }
      return
    }
    if (path === '/api/branches' && request.method === 'GET') {
      json(response, 200, { branches: branches.map(({ id, name }) => ({ id, name })) })
      return
    }
    if (path.startsWith('/api/owner/')) {
      if (request.method !== 'POST') { json(response, 405, { error: 'Use POST.' }); return }
      if (!request.headers['content-type']?.startsWith('application/json')) { json(response, 415, { error: 'JSON is required.' }); return }
      if (!options.ownerApi) { json(response, 503, { error: 'Owner service is unavailable.' }); return }
      try {
        const input = (await body(request)).input
        const action = path.slice('/api/owner/'.length)
        const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
        const result = action === 'login' ? await options.ownerApi.login(input) : await options.ownerApi.invoke(token, action, input)
        json(response, 200, { result })
      } catch (error) {
        if (error instanceof OwnerApiError) json(response, error.status, { error: error.message })
        else if (error instanceof ZodError || error instanceof SyntaxError) json(response, 400, { error: 'Check the information and try again.' })
        else { console.error('Owner API failed:', error instanceof Error ? error.message : 'unknown error'); json(response, 503, { error: 'Owner data is temporarily unavailable. Retry shortly.' }) }
      }
      return
    }
    if (path.startsWith('/api/mobile/voice/')) {
      if (request.method !== 'GET') { json(response, 405, { error: 'Use GET.' }); return }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
      const session = mobileSessions.get(token)
      if (!session || session.expiresAt <= Date.now()) { json(response, 401, { error: 'Sign in again on this phone.' }); return }
      const id = path.slice('/api/mobile/voice/'.length)
      try {
        session.backend.invoke(session.workspace === 'dining' ? posChannels.getWaiterMenu : posChannels.getKitchenQueue, session.id)
        const clip = session.backend.invoke('voice:get', session.id, { workspace: session.workspace, id }) as { mime: string; audio: Buffer } | undefined
        if (!clip) { json(response, 404, { error: 'Voice message not found.' }); return }
        response.writeHead(200, { 'Content-Type': clip.mime, 'Content-Length': clip.audio.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        response.end(clip.audio)
      } catch { json(response, 403, { error: 'Voice message unavailable.' }) }
      return
    }
    if (path.startsWith('/api/mobile/')) {
      if (request.method !== 'POST') { json(response, 405, { error: 'Use POST.' }); return }
      if (!request.headers['content-type']?.startsWith('application/json')) { json(response, 415, { error: 'JSON is required.' }); return }
      let input: unknown
      try { input = (await body(request, path === '/api/mobile/voice-send' ? 384 * 1024 : 128 * 1024)).input }
      catch (cause) { json(response, cause instanceof Error && cause.message === 'Request too large.' ? 413 : 400, { error: 'Invalid or oversized JSON request.' }); return }
      const action = path.slice('/api/mobile/'.length)
      if (action === 'login') {
        if (mobileSessions.size >= 1000) { json(response, 503, { error: 'Too many mobile sessions.' }); return }
        const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
        const branch = branches.find(item => item.id === record.branchId)
        if (!branch) { json(response, 403, { error: 'Select a configured branch.' }); return }
        const workspace = record.workspace === undefined ? 'dining' : record.workspace
        if (workspace !== 'dining' && workspace !== 'kitchen') { json(response, 400, { error: 'Choose Dining or Kitchen.' }); return }
        const id = ++nextId
        let phase: 'login' | 'access' = 'login'
        try {
          const staff = branch.backend.invoke(posChannels.loginStaff, id, { username: record.username, password: record.password })
          // The selected workspace is checked again on every mobile operation.
          phase = 'access'
          branch.backend.invoke(workspace === 'dining' ? posChannels.getWaiterMenu : posChannels.getKitchenQueue, id)
          const token = randomBytes(32).toString('hex')
          mobileSessions.set(token, { id, backend: branch.backend, branchId: branch.id, workspace, expiresAt: Date.now() + lifetime })
          json(response, 200, { result: { token, staff, branch: { id: branch.id, name: branch.name }, workspace } })
        } catch (error) {
          try { branch.backend.logout(id) } catch { /* Cleanup must not mask the JSON error response. */ }
          const message = error instanceof Error ? error.message : ''
          if (error instanceof ZodError && phase === 'login') json(response, 400, { error: 'Enter a valid username and password.' })
          else if (phase === 'login' && message === 'Invalid username or password.') json(response, 401, { error: message })
          else if (phase === 'login' && message === 'This account is temporarily locked. Try again in five minutes.') json(response, 429, { error: message })
          else if (phase === 'access' && /does not have permission/.test(message)) json(response, 403, { error: `This staff account does not have ${workspace === 'dining' ? 'waiter' : 'kitchen'} access.` })
          else json(response, 500, { error: 'Restaurant sign-in is unavailable. Ask your manager to check the server and database.' })
        }
        return
      }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
      const session = mobileSessions.get(token)
      if (!session || session.expiresAt <= Date.now()) {
        if (session) { session.backend.logout(session.id); mobileSessions.delete(token) }
        json(response, 401, { error: 'Sign in again on this phone.' }); return
      }
      if (action === 'logout') {
        session.backend.logout(session.id); mobileSessions.delete(token)
        json(response, 200, { result: null }); return
      }
      if (action === 'push-token' || action === 'push-token-delete') {
        if (action === 'push-token-delete') delete session.pushToken
        else {
          const pushToken = input && typeof input === 'object' ? (input as Record<string, unknown>).token : null
          if (typeof pushToken !== 'string' || pushToken.length > 200 || !/^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/.test(pushToken)) {
            json(response, 400, { error: 'Invalid push notification token.' }); return
          }
          session.pushToken = pushToken
        }
        session.expiresAt = Date.now() + lifetime
        json(response, 200, { result: null }); return
      }
      if (action === 'voice-list' || action === 'voice-send' || action === 'message-list' || action === 'message-send') {
        try {
          session.backend.invoke(session.workspace === 'dining' ? posChannels.getWaiterMenu : posChannels.getKitchenQueue, session.id)
          const listing = action === 'voice-list' || action === 'message-list'
          const channel = action.startsWith('voice-') ? (listing ? 'voice:list' : 'voice:send') : (listing ? 'message:list' : 'message:send')
          const result = session.backend.invoke(channel, session.id,
            listing ? session.workspace : { ...(input as object), target: session.workspace === 'kitchen' ? 'dining' : 'kitchen' })
          session.expiresAt = Date.now() + lifetime
          if (!listing) {
            const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
            const messageId = result && typeof result === 'object' && typeof (result as { id?: unknown }).id === 'string' ? (result as { id: string }).id : String(record.requestId ?? Date.now())
            const target = session.workspace === 'kitchen' ? 'dining' : 'kitchen'
            const senderName = result && typeof result === 'object' && typeof (result as { senderName?: unknown }).senderName === 'string'
              ? (result as { senderName: string }).senderName : session.workspace === 'kitchen' ? 'Kitchen' : 'Dining'
            const isVoice = action.startsWith('voice-')
            const preview = isVoice ? 'Voice message' : String(record.text ?? '').slice(0, 120)
            const tableId = typeof record.tableId === 'string' ? record.tableId : ''
            const tableName = result && typeof result === 'object' && typeof (result as { tableName?: unknown }).tableName === 'string'
              ? (result as { tableName: string }).tableName : ''
            notifyMobileStaff(session.branchId, target, `staff-message:${session.branchId}:${messageId}`,
              tableName ? `${senderName} | Table ${tableName}` : senderName, preview, { type: 'staff-message', messageId, tableId })
          }
          json(response, 200, { result })
        } catch (error) {
          json(response, error instanceof ZodError ? 400 : 403, { error: error instanceof Error ? error.message : 'Staff message unavailable.' })
        }
        return
      }
      const diningChannels: Record<string,string> = { menu: posChannels.getWaiterMenu, order: posChannels.createOrder,
        print: posChannels.requestWaiterPrint, 'save-bill': posChannels.saveWaiterBill, 'transfer-table': 'waiter:transfer-table',
        'ack-notice': 'waiter:ack-notice', 'waiting-confirm': 'waiter:waiting-confirm', 'waiting-ack': 'waiter:waiting-ack' }
      const kitchenChannels: Record<string,string> = { queue: posChannels.getKitchenQueue,
        status: posChannels.updateKitchenStatus, availability: 'kitchen:set-availability', delay: 'kitchen:delay-notice' }
      const channel = (session.workspace === 'dining' ? diningChannels : kitchenChannels)[action] ?? null
      if (!channel) { json(response, 404, { error: 'Unknown waiter operation.' }); return }
      try {
        // Recheck the chosen role before every operation, including after a role change.
        session.backend.invoke(session.workspace === 'dining' ? posChannels.getWaiterMenu : posChannels.getKitchenQueue, session.id)
        const mysqlWrite = ['order', 'save-bill', 'transfer-table', 'status', 'availability'].includes(action)
        if (mysqlWrite) {
          try { await options.beforeOrderWrite?.(session.branchId) }
          catch { throw new MySqlOrderSyncError('MySQL is unavailable. The operation was not accepted. Retry when the restaurant server is ready.') }
        }
        const result = session.backend.invoke(channel, session.id, input)
        if (mysqlWrite) {
          try { await options.afterOrderWrite?.(session.branchId) }
          catch { throw new MySqlOrderSyncError('The order was saved locally but MySQL confirmation failed. Retry the same order request.') }
        }
        session.expiresAt = Date.now() + lifetime
        const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
        const targetWorkspace = session.workspace === 'kitchen' ? 'dining' : 'kitchen'
        if (session.workspace === 'dining' && action === 'order') {
          notifyMobileStaff(session.branchId, 'kitchen', `new-order:${session.branchId}:${String(record.requestId ?? Date.now())}`, 'New kitchen order', 'A new order is waiting in Kitchen.')
        } else if (session.workspace === 'kitchen' && (action === 'delay' || action === 'availability' || action === 'status')) {
          const key = String(record.requestId ?? `${action}:${record.orderId ?? ''}:${record.ticketId ?? ''}:${record.status ?? ''}:${record.productId ?? ''}:${record.available ?? ''}`)
          const title = action === 'delay' ? 'Kitchen delay' : action === 'availability' ? 'Kitchen stock update' : 'Kitchen order update'
          const message = action === 'delay'
            ? `${String(record.delayMinutes ?? '')} minute delay${record.reason ? `: ${String(record.reason).slice(0, 120)}` : ''}`
            : action === 'availability'
              ? `Menu item ${String(record.productId ?? '')} is ${record.available ? 'available' : 'unavailable'}`
              : `Order is ${String(record.status ?? 'updated').replace(/_/g, ' ')}`
          notifyMobileStaff(session.branchId, 'dining', `kitchen-update:${session.branchId}:${key}`, title, message, { type: 'kitchen-notice' })
        }
        json(response, 200, { result })
      } catch (error) {
        if (error instanceof MySqlOrderSyncError) json(response, 503, { error: error.message })
        else if (error instanceof ZodError) json(response, 400, { error: error.issues.map(issue => issue.message).join(' ') })
        else {
          const message = error instanceof Error ? error.message : ''
          json(response, /SQLITE|no such (table|column)|constraint failed|syntax error/i.test(message) ? 500 : 400,
            { error: /SQLITE|no such (table|column)|constraint failed|syntax error/i.test(message) ? 'The operation could not be saved.' : message || 'The operation failed.' })
        }
      }
      return
    }
    if (path === '/api' || path.startsWith('/api/')) {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST')
        json(response, 405, { error: 'Use POST for restaurant operations.' })
        return
      }
      if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
        json(response, 403, { error: 'Requests must originate from this restaurant application.' })
        return
      }
      if (!request.headers['content-type']?.startsWith('application/json')) {
        json(response, 415, { error: 'JSON is required.' })
        return
      }
      const method = path.slice('/api/pos/'.length)
      if (!path.startsWith('/api/pos/') || !Object.hasOwn(posChannels, method)) {
        json(response, 404, { error: 'Unknown operation.' })
        return
      }
      let input: unknown
      try {
        input = (await body(request)).input
      } catch (error) {
        json(response, error instanceof Error && error.message === 'Request too large.' ? 413 : 400,
          { error: 'Invalid or oversized JSON request.' })
        return
      }
      const branchId = request.headers['x-billmitra-branch'] ?? branches[0].id
      const branch = branches.find(item => item.id === branchId)
      if (!branch) { json(response, 403, { error: 'Select a configured restaurant branch.' }); return }
      if (method === 'setupOwner' && options.setupToken) {
        const provided = typeof input === 'object' && input !== null && 'setupToken' in input && typeof input.setupToken === 'string' ? input.setupToken : ''
        const digest = (value: string) => createHash('sha256').update(value).digest()
        if (!timingSafeEqual(digest(provided), digest(options.setupToken))) { json(response, 403, { error: 'A valid server setup token is required to create a branch owner.' }); return }
      }
      const cookieName = `billmitra_session_${branch.id}=`
      let token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName))?.slice(cookieName.length) ?? ''
      let session = sessions.get(token)
      if (session && session.branchId !== branch.id) { json(response, 403, { error: 'This session belongs to a different branch.' }); return }
      if (session && session.expiresAt <= Date.now()) {
        discard(token, session)
        session = undefined
      }
      if (!session) {
        if (sessions.size >= 1000) {
          json(response, 503, { error: 'Too many active sessions. Try again later.' })
          return
        }
        session = { id: ++nextId, expiresAt: Date.now() + lifetime, branchId: branch.id, backend: branch.backend }
        token = randomBytes(32).toString('hex')
        sessions.set(token, session)
      }
      const cookie = (value: string, maxAge: number) => `${cookieName}${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${expected.protocol === 'https:' ? '; Secure' : ''}`
      session.expiresAt = Date.now() + lifetime
      response.setHeader('Set-Cookie', cookie(token, Math.floor(lifetime / 1000)))
      try {
        if (mysqlOrderWrites.has(method)) {
          try { await options.beforeOrderWrite?.(branch.id) }
          catch { throw new MySqlOrderSyncError('MySQL is unavailable. This order action was not accepted. Retry when the restaurant server is ready.') }
        }
        const result = branch.backend.invoke(posChannels[method as keyof typeof posChannels], session.id, input)
        if (mysqlOrderWrites.has(method)) {
          try { await options.afterOrderWrite?.(branch.id) }
          catch { throw new MySqlOrderSyncError('The action was saved locally but MySQL confirmation failed. Retry or refresh after the server reconnects.') }
        }
        if (method === 'loginStaff' || method === 'setupOwner') {
          sessions.delete(token)
          token = randomBytes(32).toString('hex')
          sessions.set(token, session)
          response.setHeader('Set-Cookie', cookie(token, Math.floor(lifetime / 1000)))
        } else if (method === 'logoutStaff') {
          discard(token, session)
          response.setHeader('Set-Cookie', cookie('', 0))
        }
        json(response, 200, { result: result ?? null })
      } catch (error) {
        if (error instanceof MySqlOrderSyncError) {
          json(response, 503, { error: error.message })
        } else if (error instanceof ZodError) {
          json(response, 400, { error: error.issues.map(issue => issue.message).join(' ') })
        } else {
          const message = error instanceof Error ? error.message : ''
          // Internal SQLite errors should never expose schema details to a browser.
          const internal = /SQLITE|no such (table|column)|constraint failed|syntax error/i.test(message)
          json(response, internal ? 500 : 400, { error: internal ? 'The operation could not be saved.' : message || 'The operation failed.' })
        }
      }
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    try {
      const root = await realpath(options.assetsDirectory)
      const filename = await realpath(join(root, decodeURIComponent(path === '/' ? '/index.html' : path)))
      const rel = relative(root, filename)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid asset path.')
      const contents = await readFile(filename)
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(filename)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
      response.end(request.method === 'HEAD' ? undefined : contents)
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Page not found.')
    }
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      // Do not log request bodies, cookies, bearer tokens or internal exception messages.
      if (!response.headersSent) json(response, 500, { error: 'The restaurant server could not complete the request.' })
      else response.destroy()
    })
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.on('close', () => {
    clearInterval(sweep)
    for (const stop of stopWaitingPush) stop()
    for (const [token, session] of sessions) discard(token, session)
  })
  return server
}
