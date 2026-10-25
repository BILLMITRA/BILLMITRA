import { afterEach, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPosBackend } from '../backend.cjs'
import type { DeliveryCashHandover, MenuData, SavedOrder } from '../../shared/domain'
import type { PaymentLedger } from '../../shared/restaurant'

let directory: string
let databasePath: string
let backend: ReturnType<typeof createPosBackend>
let riderId: string
let productId: string

function delivery(number: number): SavedOrder {
  const order = backend.invoke('pos:create-order', 1, {
    requestId: randomUUID(), type: 'delivery', deliveryNumber: number, tableId: null,
    customerName: `Customer ${number}`, contactNumber: '9876543210', deliveryAddress: 'Vengara Market',
    discount: null, items: [{ productId, quantity: 1, note: '' }],
  }) as SavedOrder
  backend.invoke('delivery:assign-rider', 1, { orderId: order.id, riderId })
  backend.invoke('delivery:operate', 1, { kind: 'ready_for_pickup', orderId: order.id })
  backend.invoke('delivery:operate', 1, { kind: 'dispatch', orderId: order.id })
  backend.invoke('delivery:operate', 1, { kind: 'delivered', orderId: order.id })
  return order
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'billmitra-handover-'))
  databasePath = join(directory, 'pos.sqlite')
  backend = createPosBackend(databasePath)
  backend.invoke('staff:setup-owner', 1, { username: 'owner', displayName: 'Owner', password: 'handover-owner-123' })
  backend.invoke('staff:create', 1, { username: 'cashier', displayName: 'Cashier', role: 'cashier', password: 'handover-cashier-123' })
  backend.invoke('staff:login', 2, { username: 'cashier', password: 'handover-cashier-123' })
  backend.invoke('staff:create', 1, { username: 'waiter', displayName: 'Waiter', role: 'waiter', password: 'handover-waiter-123' })
  backend.invoke('staff:login', 3, { username: 'waiter', password: 'handover-waiter-123' })
  productId = (backend.invoke('pos:load-menu', 1) as MenuData).products[0].id
  riderId = (backend.invoke('delivery:save-rider', 1, {
    name: 'Rider One', employeeCode: '', contactNumber: '9000000000',
    active: true, availability: 'available', maxActiveDeliveries: 5,
  }) as { id: string }).id
})
afterEach(() => { backend.close(); rmSync(directory, { recursive: true, force: true }) })

it('records one cash handover across two delivered bills and supports an exact retry', () => {
  const hd1 = delivery(1)
  const hd5 = delivery(5)
  const input = { requestId: randomUUID(), riderId, notes: 'Received at cashier', lines: [
    { orderId: hd1.id, amountPaise: hd1.totalPaise },
    { orderId: hd5.id, amountPaise: Math.floor(hd5.totalPaise / 2) },
  ] }
  expect(() => backend.invoke('delivery:record-cash-handover', 3, input)).toThrow('permission')
  const handover = backend.invoke('delivery:record-cash-handover', 2, input) as DeliveryCashHandover
  expect(handover).toMatchObject({ riderId, riderName: 'Rider One', cashier: 'cashier', notes: input.notes,
    amountPaise: hd1.totalPaise + input.lines[1].amountPaise })
  expect(handover.lines.map(line => line.reference)).toEqual(['HD-1', 'HD-5'])
  expect(backend.invoke('delivery:record-cash-handover', 1, input)).toEqual(handover)
  expect(backend.invoke('delivery:cash-handovers', 1, riderId)).toEqual([handover])
  expect(backend.invoke('cash:summary', 1)).toMatchObject({ receiptsPaise: handover.amountPaise })
  expect((backend.invoke('payments:ledger', 1, hd1.id) as PaymentLedger).balancePaise).toBe(0)
  expect((backend.invoke('payments:ledger', 1, hd5.id) as PaymentLedger).balancePaise)
    .toBe(hd5.totalPaise - input.lines[1].amountPaise)
  const tenderId = (backend.invoke('payments:ledger', 1, hd1.id) as PaymentLedger).tenders[0].id
  backend.invoke('payments:refund', 1, { requestId: randomUUID(), tenderId, amountPaise: 100, reason: 'Cash count correction' })
  expect((backend.invoke('delivery:cash-handovers', 1, riderId) as DeliveryCashHandover[])[0].lines[0].refundedPaise).toBe(100)
  expect(backend.invoke('cash:summary', 1)).toMatchObject({ receiptsPaise: handover.amountPaise - 100 })
  expect(() => backend.invoke('delivery:record-cash-handover', 1,
    { ...input, notes: 'Changed' })).toThrow('already used')
})

it('rejects an undelivered bill, a different rider, and more cash than the balance', () => {
  const hd1 = delivery(1)
  const input = { requestId: randomUUID(), riderId, notes: '', lines: [{ orderId: hd1.id, amountPaise: hd1.totalPaise + 1 }] }
  expect(() => backend.invoke('delivery:record-cash-handover', 1, input)).toThrow('remaining balance')
  expect(() => backend.invoke('delivery:record-cash-handover', 1, { ...input, riderId: randomUUID() })).toThrow('not found')
  const hd5 = backend.invoke('pos:create-order', 1, {
    requestId: randomUUID(), type: 'delivery', deliveryNumber: 5, tableId: null,
    customerName: '', contactNumber: '', deliveryAddress: '', discount: null,
    items: [{ productId, quantity: 1, note: '' }],
  }) as SavedOrder
  expect(() => backend.invoke('delivery:record-cash-handover', 1, {
    ...input, lines: [{ orderId: hd5.id, amountPaise: 1 }],
  })).toThrow('assigned to this rider')
  expect(backend.invoke('delivery:cash-handovers', 1, riderId)).toEqual([])
})

it('rolls back every bill payment if a later cash tender cannot be stored', () => {
  const hd1 = delivery(1)
  const hd5 = delivery(5)
  const db = new DatabaseSync(databasePath)
  db.exec(`CREATE TRIGGER reject_second_handover_tender BEFORE INSERT ON payment_tenders
    WHEN NEW.order_id='${hd5.id}' BEGIN SELECT RAISE(ABORT, 'simulated payment failure'); END;`)
  db.close()
  expect(() => backend.invoke('delivery:record-cash-handover', 1, {
    requestId: randomUUID(), riderId, notes: '', lines: [
      { orderId: hd1.id, amountPaise: 100 }, { orderId: hd5.id, amountPaise: 100 },
    ],
  })).toThrow('simulated payment failure')
  expect((backend.invoke('payments:ledger', 1, hd1.id) as PaymentLedger).collectedPaise).toBe(0)
  expect((backend.invoke('payments:ledger', 1, hd5.id) as PaymentLedger).collectedPaise).toBe(0)
  expect(backend.invoke('delivery:cash-handovers', 1, riderId)).toEqual([])
})
