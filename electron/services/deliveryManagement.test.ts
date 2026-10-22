import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { StaffIdentity } from '../../shared/domain'
import { deliverySchemaMigration } from '../database/deliverySchema.cjs'
import { DeliveryManagementService } from './deliveryManagement.cjs'

const owner: StaffIdentity = { id: 'owner-id', username: 'owner', displayName: 'Owner', role: 'owner' }
const manager: StaffIdentity = { id: 'manager-id', username: 'manager', displayName: 'Manager', role: 'manager' }
const cashier: StaffIdentity = { id: 'cashier-id', username: 'cashier', displayName: 'Cashier', role: 'cashier' }

let database: DatabaseSync
let service: DeliveryManagementService
let nextOrder = 0

function withTransaction<T>(action: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function seedOrder(options: {
  type?: 'delivery' | 'parcel'
  status?: 'ordering' | 'preparing' | 'ready' | 'payment_pending'
  deliveryStatus?: string
  riderId?: string | null
  paidAt?: string | null
} = {}): string {
  const id = `00000000-0000-4000-8000-${String(++nextOrder).padStart(12, '0')}`
  const displayNumber = nextOrder
  const type = options.type ?? 'delivery'
  database.prepare(`
    INSERT INTO orders (
      id, display_number, type, status, delivery_number, created_at,
      customer_name, contact_number, delivery_address, delivery_area,
      delivery_landmark, delivery_instructions, assigned_delivery_to,
      total_paise, delivery_status, delivery_rider_id, paid_at
    ) VALUES (?, ?, ?, ?, ?, '2026-10-14 10:00:00', 'Maya Rao', '9876543210',
      '18 Market Road', 'Central', 'Near Clock Tower', 'Call on arrival', '',
      15000, ?, ?, ?)
  `).run(id, displayNumber, type, options.status ?? 'ready',
    type === 'delivery' ? displayNumber : null, options.deliveryStatus ?? 'pending',
    options.riderId ?? null, options.paidAt ?? null)
  database.prepare(`
    INSERT INTO order_items
      (id, order_id, product_id, product_name, unit_price_paise, tax_rate_bps, quantity, note)
    VALUES (?, ?, 'meal-1', 'Paneer Meal', 15000, 500, 1, 'No onion')
  `).run(`item-${displayNumber}`, id)
  return id
}

async function makeRider(overrides: Partial<{
  name: string
  active: boolean
  availability: 'available' | 'unavailable' | 'off_shift'
  maxActiveDeliveries: number
}> = {}): Promise<string> {
  return service.saveRider(owner, {
    name: overrides.name ?? 'Rider One',
    employeeCode: '',
    contactNumber: '9876501234',
    active: overrides.active ?? true,
    availability: overrides.availability ?? 'available',
    maxActiveDeliveries: overrides.maxActiveDeliveries ?? 1,
  }).id
}

beforeEach(() => {
  nextOrder = 0
  database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      display_number INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      delivery_number INTEGER,
      created_at TEXT NOT NULL,
      scheduled_delivery_at TEXT,
      customer_name TEXT NOT NULL DEFAULT '',
      contact_number TEXT NOT NULL DEFAULT '',
      delivery_address TEXT NOT NULL DEFAULT '',
      assigned_delivery_to TEXT NOT NULL DEFAULT '',
      total_paise INTEGER NOT NULL DEFAULT 0,
      paid_at TEXT,
      voided_at TEXT
    );
    CREATE TABLE order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      unit_price_paise INTEGER NOT NULL,
      tax_rate_bps INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  database.exec(deliverySchemaMigration)
  service = new DeliveryManagementService(database, withTransaction)
})

afterEach(() => database.close())

describe('delivery persistence and operations', () => {
  it('shows only persisted delivery orders in the schedule with real items and customer data', () => {
    const id = seedOrder()
    seedOrder({ type: 'parcel' })

    const entries = service.listSchedule()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id,
      reference: 'HD-1',
      customerName: 'Maya Rao',
      contactNumber: '9876543210',
      deliveryAddress: '18 Market Road',
      deliveryArea: 'Central',
      deliveryLandmark: 'Near Clock Tower',
      deliveryInstructions: 'Call on arrival',
      totalPaise: 15000,
      paymentStatus: 'unpaid',
    })
    expect(entries[0].items[0]).toMatchObject({ productName: 'Paneer Meal', note: 'No onion' })
  })

  it('assigns an eligible rider and updates workload using the saved assignment', async () => {
    const orderId = seedOrder()
    const riderId = await makeRider()

    service.assignRider(cashier, { orderId, riderId })

    expect(service.listSchedule()[0].rider?.id).toBe(riderId)
    expect(service.listRiders()[0]).toMatchObject({
      activeDeliveryCount: 1,
      derivedAvailability: 'busy',
      canAcceptDelivery: false,
    })
  })

  it('rejects an inactive or unavailable rider and a rider at capacity', async () => {
    const order1 = seedOrder()
    const inactiveRider = await makeRider({ active: false })
    expect(() => service.assignRider(cashier, { orderId: order1, riderId: inactiveRider }))
      .toThrow('An inactive rider cannot receive a delivery.')

    const unavailableOrder = seedOrder()
    const offShiftRider = await makeRider({ name: 'Off shift', availability: 'off_shift' })
    expect(() => service.assignRider(cashier, { orderId: unavailableOrder, riderId: offShiftRider }))
      .toThrow('This rider is unavailable or off shift.')

    const capacityOrder1 = seedOrder()
    const capacityOrder2 = seedOrder()
    const fullRider = await makeRider({ name: 'At capacity', maxActiveDeliveries: 1 })
    service.assignRider(cashier, { orderId: capacityOrder1, riderId: fullRider })
    expect(() => service.assignRider(cashier, { orderId: capacityOrder2, riderId: fullRider }))
      .toThrow('This rider has reached their active delivery capacity.')
  })

  it('rejects a non-delivery order and an order that is not ready for pickup', async () => {
    const riderId = await makeRider()
    const parcelId = seedOrder({ type: 'parcel' })
    expect(() => service.assignRider(cashier, { orderId: parcelId, riderId })).toThrow('Delivery order not found.')
    const preparingId = seedOrder({ status: 'preparing' })
    expect(() => service.assignRider(cashier, { orderId: preparingId, riderId }))
      .toThrow('Mark the order ready for pickup before assigning a rider.')
  })

  it('requires contact number and full address before dispatch', async () => {
    const orderId = seedOrder()
    const riderId = await makeRider()
    service.assignRider(cashier, { orderId, riderId })
    database.prepare('UPDATE orders SET contact_number = ?, delivery_address = ? WHERE id = ?')
      .run('', '', orderId)
    expect(() => service.operate(cashier, { kind: 'dispatch', orderId }))
      .toThrow('Enter the customer contact number and full delivery address before dispatch.')
    expect(service.listSchedule()[0].deliveryStatus).toBe('assigned')
  })

  it('allows dispatch without an optional customer name when contact and address are present', async () => {
    const orderId = seedOrder()
    const riderId = await makeRider()
    service.assignRider(cashier, { orderId, riderId })
    database.prepare('UPDATE orders SET customer_name = ? WHERE id = ?').run('', orderId)

    service.operate(cashier, { kind: 'dispatch', orderId })

    expect(service.listSchedule()[0].deliveryStatus).toBe('dispatched')
  })

  it('prevents incompatible cashier reassignments and keeps the original rider and history', async () => {
    const orderId = seedOrder()
    const rider1 = await makeRider({ name: 'Rider A' })
    const rider2 = await makeRider({ name: 'Rider B' })
    service.assignRider(cashier, { orderId, riderId: rider1 })

    expect(() => service.assignRider(cashier, { orderId, riderId: rider2, reason: 'Workload change' }))
      .toThrow(/does not have permission/)
    expect(service.listSchedule()[0].rider?.id).toBe(rider1)

    service.assignRider(manager, { orderId, riderId: rider2, reason: 'Workload change' })
    expect(service.listSchedule()[0].rider?.id).toBe(rider2)
    expect(service.listEvents(orderId).map((event) => event.eventType)).toEqual(['reassigned', 'assigned'])
    expect(service.listEvents(orderId)[0]).toMatchObject({
      previousRiderId: rider1,
      newRiderId: rider2,
      actor: 'manager',
      reason: 'Workload change',
    })
  })

  it('marks pickup ready, dispatches with a timestamp, and delivers without altering payment', async () => {
    const orderId = seedOrder({ status: 'preparing' })
    const riderId = await makeRider()
    service.operate(cashier, { kind: 'ready_for_pickup', orderId })
    expect(service.listSchedule()[0]).toMatchObject({
      foodStatus: 'ready',
      readyForPickupAt: expect.any(String),
      actualPickupAt: null,
      dispatchedAt: null,
    })
    service.assignRider(cashier, { orderId, riderId })
    service.operate(cashier, { kind: 'dispatch', orderId })

    const dispatched = service.listSchedule()[0]
    expect(dispatched.deliveryStatus).toBe('dispatched')
    expect(dispatched.dispatchedAt).toBeTruthy()
    expect(dispatched.actualPickupAt).toBeTruthy()
    expect(dispatched.readyForPickupAt).toBeTruthy()

    service.operate(cashier, { kind: 'delivered', orderId, notes: 'Left at reception' })
    const delivered = service.listSchedule()[0]
    expect(delivered).toMatchObject({ deliveryStatus: 'delivered', paymentStatus: 'unpaid', totalPaise: 15000 })
    expect(delivered.deliveredAt).toBeTruthy()
    expect(database.prepare('SELECT paid_at AS paidAt, total_paise AS totalPaise FROM orders WHERE id = ?').get(orderId))
      .toEqual({ paidAt: null, totalPaise: 15000 })
  })

  it('does not complete an order twice or count completed deliveries as active', async () => {
    const orderId = seedOrder()
    const riderId = await makeRider({ maxActiveDeliveries: 2 })
    service.assignRider(cashier, { orderId, riderId })
    service.operate(cashier, { kind: 'dispatch', orderId })
    service.operate(cashier, { kind: 'delivered', orderId })
    expect(() => service.operate(cashier, { kind: 'delivered', orderId }))
      .toThrow('Only an out-for-delivery order can be completed.')
    expect(service.listRiders()[0]).toMatchObject({
      activeDeliveryCount: 0,
      completedDeliveryCount: 1,
      derivedAvailability: 'available',
    })
  })

  it('keeps a rider busy while another delivery remains active', async () => {
    const riderId = await makeRider({ maxActiveDeliveries: 2 })
    const first = seedOrder()
    const second = seedOrder()
    service.assignRider(cashier, { orderId: first, riderId })
    service.assignRider(cashier, { orderId: second, riderId })
    service.operate(cashier, { kind: 'dispatch', orderId: first })
    service.operate(cashier, { kind: 'delivered', orderId: first })

    expect(service.listRiders()[0]).toMatchObject({
      activeDeliveryCount: 1,
      derivedAvailability: 'busy',
      canAcceptDelivery: true,
    })
  })

  it('requires reason and elevated permissions for cancellation and delivery failure', async () => {
    const pendingOrder = seedOrder()
    expect(() => service.operate(cashier, { kind: 'cancelled', orderId: pendingOrder, reason: 'Customer changed' }))
      .toThrow(/does not have permission/)
    expect(() => service.operate(manager, { kind: 'cancelled', orderId: pendingOrder, reason: 'x' }))
      .toThrow()
    service.operate(manager, { kind: 'cancelled', orderId: pendingOrder, reason: 'Customer cancelled' })
    expect(service.listSchedule()[0].deliveryStatus).toBe('cancelled')
  })

  it('records delivery failure reasons and permits a later authorized retry', async () => {
    const orderId = seedOrder()
    const riderId = await makeRider()
    service.assignRider(cashier, { orderId, riderId })
    service.operate(cashier, { kind: 'dispatch', orderId })
    service.operate(cashier, { kind: 'failed', orderId, reason: 'Customer unavailable' })
    expect(service.listSchedule()[0].deliveryStatus).toBe('failed')
    expect(service.listRiders()[0].activeDeliveryCount).toBe(0)
    expect(service.listEvents(orderId)[0]).toMatchObject({
      eventType: 'failed',
      reason: 'Customer unavailable',
    })

    service.assignRider(cashier, { orderId, riderId })
    expect(service.listSchedule()[0].deliveryStatus).toBe('assigned')
    expect(service.listEvents(orderId)[0].eventType).toBe('assigned')
  })

  it('enforces operation and schedule permissions and rejects invalid delivery times', async () => {
    const orderId = seedOrder()
    const kitchen: StaffIdentity = { id: 'kitchen-id', username: 'kitchen', displayName: 'Kitchen', role: 'kitchen' }
    expect(() => service.operate(kitchen, { kind: 'ready_for_pickup', orderId }))
      .toThrow(/does not have permission/)
    expect(() => service.updateSchedule(kitchen, {
      orderId,
      scheduledPickupAt: '2026-10-14T12:00:00.000Z',
      promisedDeliveryAt: '2026-10-14T11:00:00.000Z',
    })).toThrow('Your kitchen role does not have permission for this delivery action.')
    expect(() => service.updateSchedule(cashier, {
      orderId,
      scheduledPickupAt: '2026-10-14T12:00:00.000Z',
      promisedDeliveryAt: '2026-10-14T11:00:00.000Z',
    })).toThrow('Scheduled pickup must be before the promised delivery time.')
    service.updateSchedule(cashier, {
      orderId,
      scheduledPickupAt: '2026-10-14T10:30:00.000Z',
      promisedDeliveryAt: '2026-10-14T11:00:00.000Z',
    })
    expect(service.listSchedule()[0].promisedDeliveryAt).toBe('2026-10-14T11:00:00.000Z')
  })

  it('allows assignment of a prepaid bill and preserves its payment state', async () => {
    const orderId = seedOrder({ paidAt: '2026-10-14 11:00:00' })
    const riderId = await makeRider()
    service.assignRider(cashier, { orderId, riderId })
    expect(service.listSchedule()[0].paymentStatus).toBe('paid')
    expect(database.prepare('SELECT paid_at AS paidAt FROM orders WHERE id = ?').get(orderId))
      .toEqual({ paidAt: '2026-10-14 11:00:00' })
  })

  it('retains assignments and event history when the service is recreated', async () => {
    const orderId = seedOrder()
    const riderId = await makeRider()
    service.assignRider(cashier, { orderId, riderId })
    service.operate(cashier, { kind: 'dispatch', orderId })
    service = new DeliveryManagementService(database, withTransaction)

    expect(service.listSchedule()[0]).toMatchObject({ deliveryStatus: 'dispatched', rider: { id: riderId } })
    expect(service.listEvents(orderId)).toHaveLength(2)
  })

  it('rolls back status changes when persistence of the event fails', async () => {
    const orderId = seedOrder({ status: 'preparing' })
    database.exec(`
      CREATE TRIGGER fail_delivery_event BEFORE INSERT ON delivery_events
      BEGIN SELECT RAISE(ABORT, 'event storage unavailable'); END;
    `)
    expect(() => service.operate(cashier, { kind: 'ready_for_pickup', orderId })).toThrow('event storage unavailable')
    expect(database.prepare('SELECT status FROM orders WHERE id = ?').get(orderId)).toEqual({ status: 'preparing' })
  })

  it('does not permit duplicate assignment actions to create duplicate events', async () => {
    const orderId = seedOrder()
    const riderId = await makeRider()
    service.assignRider(cashier, { orderId, riderId })
    service.assignRider(cashier, { orderId, riderId })
    expect(service.listEvents(orderId)).toHaveLength(1)
  })
})
