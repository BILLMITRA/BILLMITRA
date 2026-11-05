import { afterEach, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPosBackend } from '../backend.cjs'
import type { MenuData, SavedOrder } from '../../shared/domain'
import type { PaymentLedger } from '../../shared/restaurant'

let directory: string
let backend: ReturnType<typeof createPosBackend>
let dbPath: string
let productId: string

function delivery(number: number): SavedOrder {
  return backend.invoke('pos:create-order', 1, {
    requestId: randomUUID(), type: 'delivery', deliveryNumber: number, tableId: null,
    customerName: 'Shan', contactNumber: '9656684727', deliveryAddress: 'Vengara',
    discount: null, items: [{ productId, quantity: 1, note: '' }],
  }) as SavedOrder
}

function active(id: string): boolean {
  return (backend.invoke('pos:load-menu', 1) as MenuData).activeOrders.some(order => order.id === id)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'billmitra-delivery-cashout-'))
  dbPath = join(directory, 'pos.sqlite')
  backend = createPosBackend(dbPath)
  backend.invoke('staff:setup-owner', 1, { username: 'owner', displayName: 'Owner', password: 'cashout-owner-123' })
  backend.invoke('staff:create', 1, { username: 'cashier', displayName: 'Cashier', role: 'cashier', password: 'cashout-cashier-123' })
  backend.invoke('staff:login', 2, { username: 'cashier', password: 'cashout-cashier-123' })
  backend.invoke('staff:create', 1, { username: 'waiter', displayName: 'Waiter', role: 'waiter', password: 'cashout-waiter-123' })
  backend.invoke('staff:login', 3, { username: 'waiter', password: 'cashout-waiter-123' })
  backend.invoke('pos:set-manager-pin', 1, '1111')
  productId = (backend.invoke('pos:load-menu', 1) as MenuData).products[0].id
})

afterEach(() => { backend.close(); rmSync(directory, { recursive: true, force: true }) })

it('requires manager PIN, records exact cash once, and clears an HD card', () => {
  const order = delivery(1)
  const request = { requestId: randomUUID(), orderId: order.id, expectedBalancePaise: order.totalPaise, pin: '2222' }
  expect(() => backend.invoke('delivery:cash-out', 3, request)).toThrow('permission')
  expect(() => backend.invoke('delivery:cash-out', 2, request)).toThrow('Incorrect manager PIN')
  expect(active(order.id)).toBe(true)
  expect((backend.invoke('payments:ledger', 1, order.id) as PaymentLedger).collectedPaise).toBe(0)
  const valid = { ...request, pin: '1111' }
  expect(() => backend.invoke('delivery:cash-out', 2, { ...valid, expectedBalancePaise: order.totalPaise - 1 })).toThrow('amount due changed')
  const result = backend.invoke('delivery:cash-out', 2, valid) as { order: SavedOrder; collectedPaise: number }
  expect(result).toMatchObject({ collectedPaise: order.totalPaise, order: { status: 'paid', deliveryStatus: 'delivered' } })
  expect(active(order.id)).toBe(false)
  expect((backend.invoke('payments:ledger', 1, order.id) as PaymentLedger).collectedPaise).toBe(order.totalPaise)
  expect(backend.invoke('delivery:cash-out', 2, valid)).toEqual(result)
  expect(() => backend.invoke('delivery:cash-out', 2, { ...valid, requestId: randomUUID() })).toThrow('already closed')
  expect(() => delivery(1)).not.toThrow()
  const db = new DatabaseSync(dbPath)
  expect((db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='delivery.bill_cashed_out' AND entity_id=?")
    .get(order.id) as { count: number }).count).toBe(1)
  db.close()
})

it('releases a cancelled HD card while retaining the cancelled bill in history', () => {
  const cancelled = delivery(1)
  backend.invoke('delivery:operate', 1, {
    kind: 'cancelled', orderId: cancelled.id, reason: 'Customer cancelled the order',
  })
  expect(active(cancelled.id)).toBe(false)
  const history = backend.invoke('pos:list-bill-history', 1) as Array<{ order: SavedOrder }>
  expect(history.find(entry => entry.order.id === cancelled.id)?.order).toMatchObject({
    deliveryNumber: 1, deliveryStatus: 'cancelled',
  })
  const replacement = delivery(1)
  expect(active(replacement.id)).toBe(true)
  expect(active(cancelled.id)).toBe(false)
})

it('saves a kitchen message and creates a kitchen ticket when it changes', () => {
  const order = backend.invoke('pos:create-order', 1, {
    requestId: randomUUID(), type: 'delivery', deliveryNumber: 2, tableId: null,
    customerName: 'Shan', contactNumber: '9656684727', deliveryAddress: 'Vengara',
    kitchenMessage: 'No onion', discount: null, items: [{ productId, quantity: 1, note: '' }],
  }) as SavedOrder
  expect(order.kitchenMessage).toBe('No onion')
  const changed = backend.invoke('pos:create-order', 1, {
    requestId: randomUUID(), type: 'delivery', deliveryNumber: 2, tableId: null, orderId: order.id,
    customerName: order.customerName, contactNumber: order.contactNumber,
    deliveryAddress: order.deliveryAddress, kitchenMessage: 'No onion; less spicy',
    discount: null, items: [],
  }) as SavedOrder
  expect(changed.kitchenMessage).toBe('No onion; less spicy')
  const db = new DatabaseSync(dbPath)
  expect((db.prepare('SELECT COUNT(*) AS count FROM kitchen_tickets WHERE order_id=?')
    .get(order.id) as { count: number }).count).toBe(2)
  db.close()
})

it('closes a previously paid assigned bill without collecting cash again', () => {
  const order = delivery(6)
  const rider = backend.invoke('delivery:save-rider', 1, { name: 'Rider', employeeCode: '', contactNumber: '9000000000',
    active: true, availability: 'available', maxActiveDeliveries: 5 }) as { id: string }
  backend.invoke('delivery:assign-rider', 1, { orderId: order.id, riderId: rider.id })
  backend.invoke('payments:collect', 1, { requestId: randomUUID(), orderId: order.id, method: 'upi' })
  expect(active(order.id)).toBe(true)
  const result = backend.invoke('delivery:cash-out', 2, {
    requestId: randomUUID(), orderId: order.id, pin: '1111', expectedBalancePaise: 0,
  }) as { collectedPaise: number }
  expect(result.collectedPaise).toBe(0)
  expect(active(order.id)).toBe(false)
  const ledger = backend.invoke('payments:ledger', 1, order.id) as PaymentLedger
  expect(ledger.tenders).toHaveLength(1)
  expect(ledger.tenders[0].method).toBe('upi')
  expect((backend.invoke('delivery:rider-run-state', 1, rider.id) as { bills: unknown[] }).bills).toHaveLength(0)
})
