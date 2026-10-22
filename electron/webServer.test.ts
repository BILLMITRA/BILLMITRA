import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MenuData, SavedOrder, PaymentRecord } from '../shared/domain'
import { createPosBackend } from './backend.cjs'
import { createWebServer } from './webServer.cjs'

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
