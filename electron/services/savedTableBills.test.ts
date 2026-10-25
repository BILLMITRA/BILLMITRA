import { afterEach, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPosBackend } from '../backend.cjs'
import type { CreateOrderInput, MenuData, SavedOrder } from '../../shared/domain'
import type { ClaimedPrintJob, PrintJobSummary } from '../../shared/printing'

let backend: ReturnType<typeof createPosBackend>
let directory: string
let path: string
let input: CreateOrderInput
let order: SavedOrder
const owner = { username: 'owner', displayName: 'Owner', password: 'test-saved-owner-123' }
const menu = () => backend.invoke('pos:load-menu', 1) as MenuData
const save = () => backend.invoke('waiter:save-bill', 2, { orderId: order.id }) as SavedOrder
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'billmitra-saved-bill-')); path = join(directory, 'test.sqlite')
  backend = createPosBackend(path); backend.invoke('staff:setup-owner', 1, owner)
  for (const [id, role] of [[2, 'waiter'], [3, 'cashier'], [4, 'kitchen']] as const) {
    backend.invoke('staff:create', 1, { username: role, displayName: role, role, password: 'test-saved-staff-123' })
    backend.invoke('staff:login', id, { username: role, password: 'test-saved-staff-123' })
  }
  const data = menu()
  input = { requestId: randomUUID(), type: 'dine_in', tableId: data.tables[0].id, customerName: '', deliveryAddress: '', discount: null, items: [{ productId: data.products.find(product => product.available)!.id, quantity: 2, note: 'No chilli' }] }
  order = backend.invoke('pos:create-order', 2, input) as SavedOrder
})
afterEach(() => { backend.close(); rmSync(directory, { recursive: true, force: true }) })

it('releases the table, preserves the unpaid bill and kitchen items, and records its waiter', () => {
  const tickets = backend.invoke('kitchen:queue', 4) as { orders: SavedOrder[] }
  const saved = save()
  expect(saved).toMatchObject({ id: order.id, totalPaise: order.totalPaise, items: order.items, tableId: order.tableId, savedBy: 'waiter' })
  expect(saved.savedAt).toBeTruthy(); expect(saved.savedTableName).toBeTruthy(); expect(saved.status).not.toBe('paid')
  expect(menu().tables.find(table => table.id === order.tableId)?.orderId).toBeNull()
  expect(menu().activeOrders.find(bill => bill.id === order.id)?.savedAt).toBe(saved.savedAt)
  expect((backend.invoke('waiter:menu', 2) as MenuData).activeOrders).toEqual([])
  const kitchen = backend.invoke('kitchen:queue', 4) as { orders: SavedOrder[] }
  expect(kitchen.orders.map(item => ({ id: item.id, items: item.items, totalPaise: item.totalPaise }))).toEqual(tickets.orders.map(item => ({ id: item.id, items: item.items, totalPaise: item.totalPaise })))
})
it('supports a new order at the released table and lets the cashier settle only the saved bill', () => {
  save()
  const next = backend.invoke('pos:create-order', 2, { ...input, requestId: randomUUID() }) as SavedOrder
  backend.invoke('pos:record-payment', 3, { requestId: randomUUID(), orderId: order.id, method: 'cash' })
  expect((backend.invoke('pos:get-order', 3, order.id) as SavedOrder).status).toBe('paid')
  expect(menu().tables.find(table => table.id === order.tableId)?.orderId).toBe(next.id)
  expect(menu().activeOrders.map(bill => bill.id)).toEqual([next.id])
})
it('safely retries saving after table reuse and after payment without duplicating the audit event', () => {
  const saved = save()
  const next = backend.invoke('pos:create-order', 2, { ...input, requestId: randomUUID() }) as SavedOrder
  expect(save()).toEqual(saved)
  backend.invoke('pos:record-payment', 3, { requestId: randomUUID(), orderId: order.id, method: 'cash' })
  expect(save().status).toBe('paid')
  expect(menu().tables.find(table => table.id === order.tableId)?.orderId).toBe(next.id)
  const db = new DatabaseSync(path, { readOnly: true })
  try { expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='order.saved_for_cashier' AND entity_id=?").get(order.id)).toEqual({ count: 1 }) }
  finally { db.close() }
})
it('rejects further edits to a saved bill while preserving the original order-request retry', () => {
  save()
  expect(() => backend.invoke('pos:create-order', 2, { ...input, requestId: randomUUID(), orderId: order.id })).toThrow('saved for the cashier')
  expect((backend.invoke('pos:create-order', 2, input) as SavedOrder).id).toBe(order.id)
})
it('rejects unauthenticated, kitchen and cashier saves, paid bills and non-table orders', () => {
  for (const sender of [99, 3, 4]) expect(() => backend.invoke('waiter:save-bill', sender, { orderId: order.id })).toThrow()
  backend.invoke('pos:record-payment', 3, { requestId: randomUUID(), orderId: order.id, method: 'cash' })
  expect(() => save()).toThrow('unpaid table bill')
  const parcel = backend.invoke('pos:create-order', 1, { ...input, requestId: randomUUID(), type: 'parcel', tableId: null, parcelNumber: 1, customerName: 'Guest' }) as SavedOrder
  expect(() => backend.invoke('waiter:save-bill', 2, { orderId: parcel.id })).toThrow('unpaid table bill')
})
it('survives server restart with the saved bill still available to the cashier', () => {
  const saved = save(); backend.close(); backend = createPosBackend(path); backend.invoke('staff:login', 1, owner)
  expect(menu().activeOrders.find(bill => bill.id === order.id)).toEqual(saved)
  expect(menu().tables.find(table => table.id === order.tableId)?.orderId).toBeNull()
})
it('upgrades the previous schema without losing open orders or table occupancy', () => {
  backend.close()
  const db = new DatabaseSync(path)
  db.exec(`DROP INDEX IF EXISTS open_orders_by_table;
    DROP INDEX IF EXISTS one_open_order_per_table;
    ALTER TABLE orders DROP COLUMN saved_at; ALTER TABLE orders DROP COLUMN saved_by;
    ALTER TABLE orders DROP COLUMN saved_table_name; ALTER TABLE orders DROP COLUMN saved_table_floor;
    CREATE UNIQUE INDEX one_open_order_per_table ON orders(table_id) WHERE table_id IS NOT NULL AND paid_at IS NULL AND voided_at IS NULL;
    DELETE FROM schema_migrations WHERE version IN (17,21);`)
  db.close(); backend = createPosBackend(path); backend.invoke('staff:login', 1, owner)
  expect(menu().activeOrders[0]).toMatchObject({ id: order.id, items: order.items, totalPaise: order.totalPaise, savedAt: null })
  expect(menu().tables.find(table => table.id === order.tableId)?.orderId).toBe(order.id)
})
it('marks an explicitly requested duplicate KOT as a copy even without earlier queued jobs', () => {
  const data = backend.invoke('waiter:menu', 2) as { activeOrders: { kitchenTickets: { id: string }[] }[] }
  const request = { requestId: randomUUID(), orderId: order.id, kind: 'kot', ticketId: data.activeOrders[0].kitchenTickets[0].id, copy: true }
  const job = backend.invoke('print:request', 2, request) as PrintJobSummary
  expect(job.copy).toBe(true); expect(backend.invoke('print:request', 2, request)).toEqual(job)
  save()
  const claimed = backend.invoke('print:claim', 4, { deviceId: randomUUID(), kinds: ['kot'] }) as ClaimedPrintJob
  expect(claimed.document).toMatchObject({ copy: true, order: { id: order.id, items: order.items } })
})
