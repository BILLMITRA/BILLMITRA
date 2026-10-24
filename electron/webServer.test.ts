import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MenuData, SavedOrder, PaymentRecord } from '../shared/domain'
import { createPosBackend } from './backend.cjs'
import { createWebServer } from './webServer.cjs'
import { createRemotePos } from './remotePos.cjs'
import { ApiError, login as mobileLogin, getMenu as mobileMenu } from '../apps/waiter-mobile/src/api'

let directory: string
let backend: ReturnType<typeof createPosBackend>
let server: ReturnType<typeof createWebServer>
let origin: string
let cookie = ''
const owner = { username: 'restaurant-owner', displayName: 'Owner', password: 'test-owner-password-123' }

async function call<T = unknown>(method: string, input?: unknown, useCookie = cookie) {
  const response = await fetch(`${origin}/api/pos/${method}`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: useCookie },
    body: JSON.stringify({ input }),
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const data = await response.json() as { result: T; error?: string }
  return { response, ...data }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'billmitra-web-test-'))
  writeFileSync(join(directory, 'index.html'), '<html>Restaurant</html>')
  backend = createPosBackend(join(directory, 'test.sqlite'))
  server = createWebServer({ backend, assetsDirectory: directory })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address.')
  origin = `http://127.0.0.1:${address.port}`
  cookie = ''
})

afterEach(async () => {
  vi.restoreAllMocks()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  backend.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('restaurant browser backend', () => {
  it('runs the native login client against the real backend for success, invalid credentials and database errors', async () => {
    await call('setupOwner', owner)
    const actualFetch = globalThis.fetch
    const publicOrigin = 'https://restaurant-test.example'
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => actualFetch(String(input).replace(publicOrigin, origin), options))
    const session = await mobileLogin(publicOrigin, 'main', owner.username, owner.password)
    expect(session.branch.id).toBe('main')
    expect((await mobileMenu(session)).tables.length).toBeGreaterThan(0)
    await expect(mobileLogin(publicOrigin, 'main', owner.username, 'synthetic-invalid-password')).rejects.toMatchObject({ status: 401, kind: 'http', message: 'Invalid username or password.' })
    const invoke = backend.invoke.bind(backend)
    vi.spyOn(backend, 'invoke').mockImplementation((channel, senderId, input) => {
      if (channel === 'staff:login') throw new Error('SQLITE synthetic-private-details')
      return invoke(channel, senderId, input)
    })
    try { await mobileLogin(publicOrigin, 'main', owner.username, owner.password); throw new Error('Expected failure') }
    catch (cause) { expect(cause).toBeInstanceOf(ApiError); expect(cause).toMatchObject({ status: 500, kind: 'http' }); expect((cause as Error).message).not.toContain('synthetic-private') }
  })
  it('returns consistent JSON for login success, invalid credentials, malformed requests and missing routes', async () => {
    await call('setupOwner', owner)
    const mobile = (input: unknown) => fetch(`${origin}/api/mobile/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) })
    const valid = await mobile({ branchId: 'main', ...owner })
    expect(valid.status).toBe(200)
    expect(valid.headers.get('content-type')).toContain('application/json')
    expect(await valid.json()).toMatchObject({ ok: true, error: null, result: { branch: { id: 'main' } } })
    const invalid = await mobile({ branchId: 'main', username: owner.username, password: 'synthetic-invalid-password' })
    expect(invalid.status).toBe(401)
    expect(await invalid.json()).toEqual({ ok: false, result: null, error: 'Invalid username or password.' })
    for (const response of [
      await fetch(`${origin}/api`),
      await fetch(`${origin}/api/mobile/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }),
      await fetch(`${origin}/api/mobile/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }),
      await fetch(`${origin}/api/mobile/login`),
    ]) {
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toMatchObject({ ok: false, result: null, error: expect.any(String) })
    }
  })

  it('returns safe 500/503 JSON for database and unexpected failures, without leaking error details', async () => {
    const original = backend.invoke.bind(backend)
    const invoke = vi.spyOn(backend, 'invoke').mockImplementation((channel, senderId, input) => {
      if (channel === 'staff:login') throw new Error('SQLITE unavailable synthetic-secret-test-marker')
      return original(channel, senderId, input)
    })
    const failed = await fetch(`${origin}/api/mobile/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: { branchId: 'main', ...owner } }) })
    expect(failed.status).toBe(500)
    const body = await failed.text()
    expect(JSON.parse(body)).toMatchObject({ ok: false, result: null, error: expect.any(String) })
    expect(body).not.toContain('synthetic-secret-test-marker')
    invoke.mockImplementation(() => { throw new Error('synthetic-private-database-details') })
    const health = await fetch(`${origin}/api/health`)
    expect(health.status).toBe(503)
    expect(await health.json()).toEqual({ ok: false, result: null, error: 'The restaurant database is unavailable. Ask your manager to check the server.' })
  })

  it('keeps exceptions during sign-out inside the JSON response boundary', async () => {
    await call('setupOwner', owner)
    const response = await fetch(`${origin}/api/mobile/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: { branchId: 'main', ...owner } }) })
    const token = ((await response.json()) as { result: { token: string } }).result.token
    const logout = vi.spyOn(backend, 'logout').mockImplementation(() => { throw new Error('synthetic-private-signout-details') })
    const failed = await fetch(`${origin}/api/mobile/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{"input":null}' })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ ok: false, result: null, error: 'The restaurant server could not complete the request.' })
    logout.mockRestore()
  })

  it('exposes a safe readiness probe and distinguishes a non-waiter account from invalid credentials', async () => {
    expect(await (await fetch(`${origin}/api/health`)).json()).toEqual({ ok: true, result: { service: 'billmitra', ready: true }, error: null })
    await call('setupOwner', owner)
    await call('createStaff', { username: 'cashier-test', displayName: 'Cashier', role: 'cashier', password: 'synthetic-cashier-password' })
    const response = await fetch(`${origin}/api/mobile/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: { branchId: 'main', username: 'cashier-test', password: 'synthetic-cashier-password' } }) })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ ok: false, result: null, error: 'This staff account does not have waiter access.' })
  })
  it('lets connected Electron use the same branch orders as the phone API', async () => {
    await call('setupOwner', owner)
    await call('createStaff', { username: 'waiter', displayName: 'Waiter', role: 'waiter', password: 'test-waiter-password-123' })
    const desktop = createRemotePos(origin, 'main')
    try {
      await desktop.invoke('staff:login', 501, { username: 'restaurant-owner', password: owner.password })
      const menu = await desktop.invoke('pos:load-menu', 501) as MenuData
      const saved = await desktop.invoke('pos:create-order', 501, {
        requestId: randomUUID(), type: 'dine_in', tableId: menu.tables[0].id,
        customerName: '', deliveryAddress: '', discount: null,
        items: [{ productId: menu.products[0].id, quantity: 1, note: '' }],
      }) as SavedOrder
      const login = await fetch(`${origin}/api/mobile/login`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { branchId: 'main', username: 'waiter', password: 'test-waiter-password-123' } }),
      })
      const token = ((await login.json()) as { result: { token: string } }).result.token
      const response = await fetch(`${origin}/api/mobile/menu`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ input: null }),
      })
      const phoneMenu = ((await response.json()) as { result: MenuData }).result
      expect(phoneMenu.activeOrders.some(order => order.id === saved.id)).toBe(true)
    } finally { desktop.close() }
  })

  it('authenticates a phone waiter, limits its operations, and revokes sign-out', async () => {
    await call('setupOwner', owner)
    await call('createStaff', { username: 'phone-waiter', displayName: 'Phone waiter', role: 'waiter', password: 'test-waiter-password-123' })
    const mobile = (action: string, input?: unknown, token = '') => fetch(`${origin}/api/mobile/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ input }),
    })
    expect((await mobile('menu')).status).toBe(401)
    expect((await mobile('login', { branchId: 'wrong', username: 'phone-waiter', password: 'test-waiter-password-123' })).status).toBe(403)
    const signed = await mobile('login', { branchId: 'main', username: 'phone-waiter', password: 'test-waiter-password-123' })
    expect(signed.status).toBe(200)
    const token = ((await signed.json()) as { result: { token: string } }).result.token
    const menuResponse = await mobile('menu', null, token)
    expect(menuResponse.status).toBe(200)
    const menu = ((await menuResponse.json()) as { result: MenuData }).result
    const input = { requestId: randomUUID(), type: 'dine_in', tableId: menu.tables[0].id,
      customerName: '', deliveryAddress: '', discount: null,
      items: [{ productId: menu.products[0].id, quantity: 1, note: '' }] }
    const saved = await mobile('order', input, token)
    expect(saved.status).toBe(200)
    const orderId = ((await saved.json()) as { result: SavedOrder }).result.id
    const repeated = await mobile('order', input, token)
    expect(((await repeated.json()) as { result: SavedOrder }).result.id).toBe(orderId)
    const printInput = { requestId: randomUUID(), orderId, kind: 'bill' }
    const printResponse = await mobile('print', printInput, token)
    expect(printResponse.status).toBe(200)
    expect(((await printResponse.json()) as { result: { status: string } }).result.status).toBe('queued')
    expect((await mobile('print', printInput, token)).status).toBe(200)
    expect((await mobile('claimPrintJob', { deviceId: randomUUID(), kinds: ['bill'] }, token)).status).toBe(404)
    const phoneStatus = ((await (await mobile('menu', null, token)).json()) as { result: { printJobs: { claimToken?: string; document?: unknown }[] } }).result.printJobs
    expect(phoneStatus).toHaveLength(1)
    expect(phoneStatus[0].claimToken).toBeUndefined(); expect(phoneStatus[0].document).toBeUndefined()
    const desktopClaim = await call<{ id: string; claimToken: string }>('claimPrintJob', { deviceId: 'fd76cd86-6a7a-478f-a609-2ce69382160a', kinds: ['bill'] })
    expect(desktopClaim.result.id).toBe(printInput.requestId)
    expect((await call('finishPrintJob', { id: printInput.requestId, deviceId: 'fd76cd86-6a7a-478f-a609-2ce69382160a', claimToken: desktopClaim.result.claimToken, status: 'submitted' })).response.status).toBe(200)
    expect((await mobile('collectPayment', { orderId }, token)).status).toBe(404)
    const parked = await mobile('save-bill', { orderId }, token)
    expect(parked.status).toBe(200)
    const parkedOrder = ((await parked.json()) as { result: SavedOrder }).result
    expect(parkedOrder).toMatchObject({ id: orderId, savedBy: 'Phone waiter', tableId: input.tableId })
    expect((await mobile('save-bill', { orderId }, token)).status).toBe(200)
    const desktopMenu = (await call<MenuData>('loadMenu')).result
    expect(desktopMenu.tables.find(table => table.id === input.tableId)?.orderId).toBeNull()
    expect(desktopMenu.activeOrders.find(order => order.id === orderId)?.savedAt).toBeTruthy()
    expect(((await (await mobile('menu', null, token)).json()) as { result: MenuData }).result.activeOrders).toEqual([])
    const reused = await mobile('order', { ...input, requestId: randomUUID() }, token)
    expect(reused.status).toBe(200)
    expect((await call('recordPayment', { requestId: randomUUID(), orderId, method: 'cash' })).response.status).toBe(200)
    expect((await mobile('logout', null, token)).status).toBe(200)
    expect((await mobile('menu', null, token)).status).toBe(401)
  })

  it('serves the app and rejects cross-origin, unsupported, and malformed requests', async () => {
    const page = await fetch(origin)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Restaurant')
    const crossOrigin = await fetch(`${origin}/api/pos/setupOwner`, {
      method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: owner }),
    })
    expect(crossOrigin.status).toBe(403)
    expect((await call<{ needsOwnerSetup: boolean }>('getStaffAccessState')).result.needsOwnerSetup).toBe(true)
    expect((await call('constructor')).response.status).toBe(404)
    const malformed = await fetch(`${origin}/api/pos/setupOwner`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{',
    })
    expect(malformed.status).toBe(400)
    const oversized = await fetch(`${origin}/api/pos/setupOwner`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'x'.repeat(129 * 1024) }),
    })
    expect(oversized.status).toBe(413)
    expect((await fetch(`${origin}/api/pos/loadMenu`)).status).toBe(405)
  })

  it('isolates staff sessions, rotates sign-in cookies, and revokes logout', async () => {
    expect((await call('loadMenu')).error).toContain('Sign in')
    const anonymousCookie = cookie
    const setup = await call('setupOwner', owner)
    expect(setup.response.status).toBe(200)
    expect(cookie).not.toBe(anonymousCookie)
    expect(setup.response.headers.get('set-cookie')).toContain('HttpOnly')
    const ownerCookie = cookie
    expect((await call('listStaff', undefined, '')).error).toContain('Sign in')
    cookie = ownerCookie
    await call('createStaff', { username: 'cashier', displayName: 'Cashier', role: 'cashier', password: 'test-cashier-password-123' })
    await call('logoutStaff')
    expect((await call('loadMenu', undefined, ownerCookie)).error).toContain('Sign in')
    await call('loginStaff', { username: 'cashier', password: 'test-cashier-password-123' })
    expect((await call('loadMenu')).response.status).toBe(200)
    expect((await call('createStaff', { ...owner, role: 'manager' })).error).toContain('permission')
  })

  it('saves and pays a real order once despite repeated HTTP requests', async () => {
    await call('setupOwner', owner)
    const menu = (await call<MenuData>('loadMenu')).result
    const product = menu.products[0]
    const input = {
      requestId: randomUUID(), type: 'parcel', tableId: null, parcelNumber: 1,
      customerName: 'Test guest', deliveryAddress: '', discount: null,
      items: [{ productId: product.id, quantity: 2, note: '' }],
    }
    const saved = await call<SavedOrder>('createOrder', input)
    expect(saved.response.status, saved.error).toBe(200)
    expect(saved.result.totalPaise).toBeGreaterThan(0)
    const repeated = await call<SavedOrder>('createOrder', input)
    expect(repeated.result.id).toBe(saved.result.id)
    const payment = { requestId: randomUUID(), orderId: saved.result.id, method: 'cash' }
    const paid = await call<PaymentRecord>('recordPayment', payment)
    expect(paid.response.status).toBe(200)
    expect((await call<PaymentRecord>('recordPayment', payment)).result.id).toBe(paid.result.id)
    expect((await call<SavedOrder>('getOrder', saved.result.id)).result.status).toBe('paid')
    expect((await call('recordPayment', { ...payment, requestId: randomUUID() })).error).toContain('already been paid')
    expect((await call('createOrder', { ...input, requestId: randomUUID(), items: [{ ...input.items[0], quantity: -1 }] })).response.status).toBe(400)
  })

  it('preserves orders and owner accounts when the database is reopened', () => {
    backend.invoke('staff:setup-owner', 1, owner)
    const menu = backend.invoke('pos:load-menu', 1) as MenuData
    const saved = backend.invoke('pos:create-order', 1, {
      requestId: randomUUID(), type: 'parcel', tableId: null, parcelNumber: 1,
      customerName: 'Returning guest', deliveryAddress: '', discount: null,
      items: [{ productId: menu.products[0].id, quantity: 1, note: '' }],
    }) as SavedOrder
    backend.close()
    backend = createPosBackend(join(directory, 'test.sqlite'))
    expect(backend.invoke('staff:get-access-state', 1)).toEqual({ needsOwnerSetup: false, staff: null })
    expect(() => backend.invoke('staff:setup-owner', 2, owner)).toThrow('already complete')
    expect(backend.invoke('staff:login', 2, owner)).toMatchObject({ role: 'owner' })
    expect(backend.invoke('pos:get-order', 2, saved.id)).toMatchObject({ id: saved.id, totalPaise: saved.totalPaise })
  })

  it('requires sign-in again after a browser session expires', async () => {
    await call('setupOwner', owner)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 60 * 60 * 1000)
    expect((await call('loadMenu')).error).toContain('Sign in')
  })

  it('isolates branch authentication and data and rejects a session token reused for another branch', async () => {
    const second = createPosBackend(join(directory, 'second.sqlite'))
    const branchServer = createWebServer({ backend, assetsDirectory: directory, branches: [
      { id: 'east', name: 'East branch', backend }, { id: 'west', name: 'West branch', backend: second },
    ], setupToken: 'test-setup-token' })
    branchServer.listen(0, '127.0.0.1'); await once(branchServer, 'listening')
    const address = branchServer.address()
    if (!address || typeof address === 'string') throw new Error('Missing address.')
    const branchOrigin = `http://127.0.0.1:${address.port}`
    const request = (branch: string, method: string, input?: unknown, cookie = '') => fetch(`${branchOrigin}/api/pos/${method}`, {
      method: 'POST', headers: { Origin: branchOrigin, 'Content-Type': 'application/json', 'X-Billmitra-Branch': branch, Cookie: cookie }, body: JSON.stringify({ input }),
    })
    try {
      expect((await (await fetch(`${branchOrigin}/api/branches`)).json()).branches).toHaveLength(2)
      expect((await request('east', 'setupOwner', owner)).status).toBe(403)
      const setup = await request('east', 'setupOwner', { ...owner, setupToken: 'test-setup-token' })
      expect(setup.status).toBe(200)
      const eastCookie = setup.headers.get('set-cookie')!.split(';')[0]
      expect((await request('east', 'loadMenu', undefined, eastCookie)).status).toBe(200)
      const west = await request('west', 'getStaffAccessState', undefined, eastCookie)
      expect((await west.json()).result).toEqual({ needsOwnerSetup: true, staff: null })
      expect((await request('west', 'loadMenu', undefined, eastCookie.replace('session_east=', 'session_west='))).status).toBe(403)
      expect((await request('unknown', 'loadMenu')).status).toBe(403)
      const westSetup = await request('west', 'setupOwner', { ...owner, username: 'west-owner', setupToken: 'test-setup-token' })
      const westCookie = westSetup.headers.get('set-cookie')!.split(';')[0]
      const eastStaff = await (await request('east', 'listStaff', undefined, eastCookie)).json()
      const westStaff = await (await request('west', 'listStaff', undefined, westCookie)).json()
      expect(eastStaff.result[0].username).toBe('restaurant-owner')
      expect(westStaff.result[0].username).toBe('west-owner')
    } finally { await new Promise<void>(resolve => branchServer.close(() => resolve())); second.close() }
  })
})
