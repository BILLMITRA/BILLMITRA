import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { desktopPrinting } from './desktopPrinting.cjs'
import { createPosBackend } from './backend.cjs'
import type { MenuData, SavedOrder } from '../shared/domain'
vi.mock('electron', () => ({ BrowserWindow: vi.fn() }))

let directory: string
let backend: ReturnType<typeof createPosBackend>
let order: SavedOrder
let cleanup: (() => void)[]
const scope = 'local-test|main'
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'billmitra-desktop-print-'))
  cleanup = []
  backend = createPosBackend(join(directory, 'pos.sqlite'))
  backend.invoke('staff:setup-owner', 1, { username: 'owner', displayName: 'Owner', password: 'printing-test-owner-123' })
  const menu = backend.invoke('pos:load-menu', 1) as MenuData
  order = backend.invoke('pos:create-order', 1, { requestId: randomUUID(), type: 'dine_in', tableId: menu.tables[0].id, customerName: '', deliveryAddress: '', discount: null, items: [{ productId: menu.products[0].id, quantity: 1, note: '' }] }) as SavedOrder
})
afterEach(() => { cleanup.forEach(close => close()); backend.close(); rmSync(directory, { recursive: true, force: true }) })
function windowStub() {
  return { webContents: { id: 1, getPrintersAsync: async () => [], once: (_event: string, close: () => void) => cleanup.push(close) } } as unknown as BrowserWindow
}
it('recovers a print request after a lost server response and desktop restart without creating a second job', async () => {
  let loseResponse = true
  const invoke = async (channel: Parameters<typeof backend.invoke>[0], senderId: number, input?: unknown) => {
    const result = backend.invoke(channel, senderId, input)
    if (channel === 'print:request-pos' && loseResponse) { loseResponse = false; throw new Error('Connection lost after commit') }
    return result
  }
  const first = desktopPrinting(windowStub(), directory, scope, invoke)
  const input = { orderId: order.id, kind: 'bill' }
  await expect(first.request(input)).rejects.toThrow('Connection lost')
  const before = await first.getOrderDetails(order.id)
  expect(before.jobs).toHaveLength(1)
  expect(before.pendingRequests).toHaveLength(1)
  const second = desktopPrinting(windowStub(), directory, scope, invoke)
  const result = await second.request(input)
  expect(result.id).toBe(before.jobs[0].id)
  const after = await second.getOrderDetails(order.id)
  expect(after.jobs).toHaveLength(1)
  expect(after.pendingRequests).toHaveLength(0)
})
it('upgrades existing printer settings without changing routes and rejects uninstalled printer names', async () => {
  const key = createHash('sha256').update(scope).digest('hex').slice(0, 24)
  const path = join(directory, `printing-${key}.json`)
  writeFileSync(path, JSON.stringify({ deviceId: randomUUID(), settings: { bill: '', kot: '', restaurant: 'Chick Buck', branch: 'Vengara' }, pending: null }))
  const controller = desktopPrinting(windowStub(), directory, scope, (channel, senderId, input) => backend.invoke(channel, senderId, input))
  expect((await controller.getState()).settings.restaurant).toBe('Chick Buck')
  expect(JSON.parse(readFileSync(path, 'utf8')).requests).toEqual({})
  await expect(controller.saveSettings({ bill: 'Missing B POS printer', kot: '', restaurant: '', branch: '' })).rejects.toThrow('installed printer')
})
it('keeps a previous staff member’s unconfirmed request separate after a different cashier signs in', async () => {
  let loseResponse = true
  const controller = desktopPrinting(windowStub(), directory, scope, async (channel, senderId, input) => {
    const result = backend.invoke(channel, senderId, input)
    if (channel === 'print:request-pos' && loseResponse) { loseResponse = false; throw new Error('Lost response') }
    return result
  })
  const input = { orderId: order.id, kind: 'bill' }
  await expect(controller.request(input)).rejects.toThrow('Lost response')
  const ownerDetails = await controller.getOrderDetails(order.id)
  backend.invoke('staff:create', 1, { username: 'cashier', displayName: 'Cashier', role: 'cashier', password: 'cashier-printing-123' })
  backend.invoke('staff:login', 1, { username: 'cashier', password: 'cashier-printing-123' })
  expect((await controller.getOrderDetails(order.id)).pendingRequests).toHaveLength(0)
  const cashierJob = await controller.request(input)
  expect(cashierJob.id).not.toBe(ownerDetails.jobs[0].id)
  expect(cashierJob.copy).toBe(true)
})
