import { afterEach, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPosBackend } from '../backend.cjs'
import type { MenuData, RiderRunState, SavedOrder } from '../../shared/domain'
import type { PaymentLedger } from '../../shared/restaurant'

let directory: string
let backend: ReturnType<typeof createPosBackend>
let databasePath: string
let riderId: string
let productId: string

function createDelivery(number: number, delivered = true): SavedOrder {
  const order = backend.invoke('pos:create-order', 1, {
    requestId: randomUUID(), type: 'delivery', deliveryNumber: number, tableId: null,
    customerName: `Customer ${number}`, contactNumber: '9876543210', deliveryAddress: 'Vengara Market',
    discount: null, items: [{ productId, quantity: 1, note: '' }],
  }) as SavedOrder
  backend.invoke('delivery:assign-rider', 1, { orderId: order.id, riderId })
  if (delivered) {
    backend.invoke('delivery:operate', 1, { kind: 'ready_for_pickup', orderId: order.id })
    backend.invoke('delivery:operate', 1, { kind: 'dispatch', orderId: order.id })
    backend.invoke('delivery:operate', 1, { kind: 'delivered', orderId: order.id })
  }
  return order
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'billmitra-run-'))
  databasePath = join(directory, 'pos.sqlite')
  backend = createPosBackend(databasePath)
  backend.invoke('staff:setup-owner', 1, { username: 'owner', displayName: 'Owner', password: 'settlement-owner-123' })
  backend.invoke('staff:create', 1, { username: 'cashier', displayName: 'Cashier', role: 'cashier', password: 'settlement-cashier-123' })
  backend.invoke('staff:login', 2, { username: 'cashier', password: 'settlement-cashier-123' })
  backend.invoke('staff:create', 1, { username: 'waiter', displayName: 'Waiter', role: 'waiter', password: 'settlement-waiter-123' })
  backend.invoke('staff:login', 3, { username: 'waiter', password: 'settlement-waiter-123' })
  productId = (backend.invoke('pos:load-menu', 1) as MenuData).products[0].id
  riderId = (backend.invoke('delivery:save-rider', 1, {
    name: 'Rider One', employeeCode: '', contactNumber: '9000000000',
    active: true, availability: 'available', maxActiveDeliveries: 5,
  }) as { id: string }).id
})
afterEach(() => { backend.close(); rmSync(directory, { recursive: true, force: true }) })

it('issues change money, then closes two HD bills atomically and frees their cards', () => {
  const hd1 = createDelivery(1)
  const hd5 = createDelivery(5)
  const float = { requestId: randomUUID(), riderId, amountPaise: 50000, notes: 'Change for customers' }
  expect(() => backend.invoke('delivery:issue-float', 3, float)).toThrow('permission')
  expect(backend.invoke('delivery:issue-float', 2, float)).toMatchObject({ riderId, amountPaise: 50000 })
  expect(backend.invoke('delivery:issue-float', 1, float)).toMatchObject({ id: float.requestId })
  expect((backend.invoke('delivery:rider-run-state', 1, riderId) as RiderRunState).bills.map(bill => bill.reference)).toEqual(['HD-1', 'HD-5'])
  expect(backend.invoke('cash:summary', 1)).toMatchObject({ receiptsPaise: -50000 })
  expect((backend.invoke('pos:load-menu', 1) as MenuData).activeOrders.filter(order => order.type === 'delivery')).toHaveLength(2)
  const receivedPaise = 50000 + hd1.totalPaise + hd5.totalPaise
  const close = { requestId: randomUUID(), riderId, receivedPaise, notes: 'Counted by cashier' }
  expect(() => backend.invoke('delivery:close-run', 3, close)).toThrow('permission')
  expect(() => backend.invoke('delivery:close-run', 2, { ...close, receivedPaise: receivedPaise - 100 })).toThrow('Cash count differs')
  expect((backend.invoke('pos:load-menu', 1) as MenuData).activeOrders.filter(order => order.type === 'delivery')).toHaveLength(2)
  const result = backend.invoke('delivery:close-run', 2, close) as { items: { reference: string }[]; floatPaise: number; billsPaise: number }
  expect(result).toMatchObject({ floatPaise: 50000, billsPaise: hd1.totalPaise + hd5.totalPaise })
  expect(result.items.map(item => item.reference)).toEqual(['HD-1', 'HD-5'])
  expect(backend.invoke('delivery:close-run', 1, close)).toMatchObject(result)
  expect((backend.invoke('pos:load-menu', 1) as MenuData).activeOrders.filter(order => order.type === 'delivery')).toHaveLength(0)
  expect((backend.invoke('delivery:rider-run-state', 1, riderId) as RiderRunState)).toMatchObject({ outstandingFloatPaise: 0, bills: [] })
  expect(backend.invoke('cash:summary', 1)).toMatchObject({ receiptsPaise: hd1.totalPaise + hd5.totalPaise })
  expect((backend.invoke('payments:ledger', 1, hd1.id) as PaymentLedger).balancePaise).toBe(0)
  expect((backend.invoke('payments:ledger', 1, hd5.id) as PaymentLedger).balancePaise).toBe(0)
  expect(() => createDelivery(1)).not.toThrow()
})

it('keeps a paid HD card until settlement and blocks closure while another bill is in flight', () => {
  const hd1 = createDelivery(1)
  const hd5 = createDelivery(5, false)
  backend.invoke('payments:collect', 1, { requestId: randomUUID(), orderId: hd1.id, method: 'upi' })
  expect((backend.invoke('pos:load-menu', 1) as MenuData).activeOrders.some(order => order.id === hd1.id)).toBe(true)
  const close = { requestId: randomUUID(), riderId, receivedPaise: 0, notes: '' }
  expect(() => backend.invoke('delivery:close-run', 1, close)).toThrow('marked delivered')
  backend.invoke('delivery:operate', 1, { kind: 'ready_for_pickup', orderId: hd5.id })
  backend.invoke('delivery:operate', 1, { kind: 'dispatch', orderId: hd5.id })
  backend.invoke('delivery:operate', 1, { kind: 'delivered', orderId: hd5.id })
  backend.invoke('delivery:close-run', 1, { ...close, receivedPaise: hd5.totalPaise })
  expect(backend.invoke('cash:summary', 1)).toMatchObject({ receiptsPaise: hd5.totalPaise })
})

it('rolls back float return and every payment if a later bill fails', () => {
  const hd1 = createDelivery(1)
  const hd5 = createDelivery(5)
  backend.invoke('delivery:issue-float', 1, { requestId: randomUUID(), riderId, amountPaise: 1000, notes: '' })
  const db = new DatabaseSync(databasePath)
  db.exec(`CREATE TRIGGER reject_run_payment BEFORE INSERT ON payment_tenders
    WHEN NEW.order_id='${hd5.id}' BEGIN SELECT RAISE(ABORT, 'simulated payment failure'); END;`)
  db.close()
  expect(() => backend.invoke('delivery:close-run', 1, {
    requestId: randomUUID(), riderId, receivedPaise: 1000 + hd1.totalPaise + hd5.totalPaise, notes: '',
  })).toThrow('simulated payment failure')
  expect((backend.invoke('delivery:rider-run-state', 1, riderId) as RiderRunState)).toMatchObject({ outstandingFloatPaise: 1000 })
  expect((backend.invoke('pos:load-menu', 1) as MenuData).activeOrders.filter(order => order.type === 'delivery')).toHaveLength(2)
  expect((backend.invoke('payments:ledger', 1, hd1.id) as PaymentLedger).collectedPaise).toBe(0)
  expect(backend.invoke('cash:summary', 1)).toMatchObject({ receiptsPaise: -1000 })
})

it('allows unused change money to be returned without a delivery bill', () => {
  backend.invoke('delivery:issue-float', 1, { requestId: randomUUID(), riderId, amountPaise: 1200, notes: '' })
  const closed = backend.invoke('delivery:close-run', 1, {
    requestId: randomUUID(), riderId, receivedPaise: 1200, notes: 'No deliveries taken',
  }) as { items: unknown[]; floatPaise: number; billsPaise: number }
  expect(closed).toMatchObject({ items: [], floatPaise: 1200, billsPaise: 0 })
  expect(backend.invoke('cash:summary', 1)).toMatchObject({ receiptsPaise: 0 })
})
