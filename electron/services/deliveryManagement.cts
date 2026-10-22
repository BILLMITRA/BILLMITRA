import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DatabaseSync } from 'node:sqlite'
import type {
  DeliveryEvent,
  DeliveryOperation,
  DeliveryRider,
  DeliveryRiderInput,
  DeliveryScheduleEntry,
  DeliveryScheduleInput,
  StaffIdentity,
} from '../../shared/domain.js'
import { STAFF_ROLES } from '../../shared/domain.js'
import { staffHasPermission } from '../../shared/staffPermissions.js'

type TransactionRunner = <T>(action: () => T) => T

const dateTimeSchema = z.string().datetime({ offset: true }).nullable()
const riderSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  employeeCode: z.string().trim().max(40).default(''),
  contactNumber: z.string().trim().max(30).default(''),
  active: z.boolean(),
  availability: z.enum(['available', 'unavailable', 'off_shift']),
  maxActiveDeliveries: z.number().int().min(1).max(20),
})
const scheduleSchema = z.object({
  orderId: z.string().uuid(),
  scheduledPickupAt: dateTimeSchema,
  promisedDeliveryAt: dateTimeSchema,
})
const assignmentSchema = z.object({
  orderId: z.string().uuid(),
  riderId: z.string().uuid(),
  reason: z.string().trim().max(250).default(''),
})
const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready_for_pickup'), orderId: z.string().uuid() }),
  z.object({ kind: z.literal('dispatch'), orderId: z.string().uuid() }),
  z.object({ kind: z.literal('delivered'), orderId: z.string().uuid(), notes: z.string().trim().max(250).default('') }),
  z.object({ kind: z.literal('failed'), orderId: z.string().uuid(), reason: z.string().trim().min(3).max(250) }),
  z.object({ kind: z.literal('cancelled'), orderId: z.string().uuid(), reason: z.string().trim().min(3).max(250) }),
])
const scheduleItemSchema = z.object({
  id: z.string(),
  productId: z.string(),
  productName: z.string(),
  unitPricePaise: z.number(),
  taxRateBps: z.number(),
  quantity: z.number(),
  note: z.string(),
})
const deliveryEventSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  eventType: z.string(),
  previousStatus: z.string().nullable(),
  newStatus: z.string().nullable(),
  previousRiderId: z.string().nullable(),
  newRiderId: z.string().nullable(),
  actor: z.string(),
  reason: z.string(),
  createdAt: z.string(),
})

type RiderRow = {
  id: string
  name: string
  employeeCode: string | null
  contactNumber: string
  active: number
  availability: DeliveryRider['availability']
  maxActiveDeliveries: number
  activeDeliveryCount: number
  completedDeliveryCount: number
  lastStatusUpdate: string
}

function hasRolePermission(actor: StaffIdentity, permission: Parameters<typeof staffHasPermission>[1]): void {
  if (!(STAFF_ROLES as readonly string[]).includes(actor.role) || !staffHasPermission(actor.role, permission)) {
    throw new Error(`Your ${actor.role} role does not have permission for this delivery action.`)
  }
}

export class DeliveryManagementService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: TransactionRunner,
  ) {}

  listRiders(): DeliveryRider[] {
    return this.riderRows().map((row) => this.riderFromRow(row))
  }

  listSchedule(): DeliveryScheduleEntry[] {
    const riders = new Map(this.listRiders().map((rider) => [rider.id, rider]))
    const rows = this.database.prepare(`
      SELECT id, display_number AS orderNumber, delivery_number AS deliveryNumber,
        created_at AS createdAt, scheduled_pickup_at AS scheduledPickupAt,
        ready_for_pickup_at AS readyForPickupAt,
        scheduled_delivery_at AS promisedDeliveryAt, actual_pickup_at AS actualPickupAt,
        dispatched_at AS dispatchedAt, delivered_at AS deliveredAt,
        delivery_status AS deliveryStatus, status AS foodStatus,
        paid_at AS paidAt, voided_at AS voidedAt, customer_name AS customerName,
        contact_number AS contactNumber, delivery_address AS deliveryAddress,
        delivery_area AS deliveryArea, delivery_landmark AS deliveryLandmark,
        delivery_instructions AS deliveryInstructions,
        assigned_delivery_to AS assignedDeliveryTo, delivery_rider_id AS riderId,
        total_paise AS totalPaise
      FROM orders WHERE type = 'delivery'
      ORDER BY CASE WHEN delivered_at IS NULL THEN 0 ELSE 1 END,
        COALESCE(scheduled_delivery_at, created_at), created_at DESC
    `).all() as Array<{
      id: string; orderNumber: number; deliveryNumber: number | null; createdAt: string
      scheduledPickupAt: string | null; readyForPickupAt: string | null; promisedDeliveryAt: string | null
      actualPickupAt: string | null; dispatchedAt: string | null; deliveredAt: string | null
      deliveryStatus: DeliveryScheduleEntry['deliveryStatus']; foodStatus: DeliveryScheduleEntry['foodStatus']
      paidAt: string | null; voidedAt: string | null; customerName: string; contactNumber: string
      deliveryAddress: string; deliveryArea: string; deliveryLandmark: string
      deliveryInstructions: string; assignedDeliveryTo: string; riderId: string | null; totalPaise: number
    }>
    const itemQuery = this.database.prepare(`
      SELECT id, product_id AS productId, product_name AS productName,
        unit_price_paise AS unitPricePaise, tax_rate_bps AS taxRateBps, quantity, note
      FROM order_items WHERE order_id = ? ORDER BY rowid
    `)
    return rows.map((row) => ({
      ...row,
      reference: row.deliveryNumber === null ? `#${row.orderNumber}` : `HD-${row.deliveryNumber}`,
      paymentStatus: row.voidedAt ? 'voided' : row.paidAt ? 'paid' : 'unpaid',
      rider: row.riderId ? riders.get(row.riderId) ?? null : null,
      items: z.array(scheduleItemSchema).parse(itemQuery.all(row.id)),
    }))
  }

  saveRider(actor: StaffIdentity, rawInput: unknown): DeliveryRider {
    hasRolePermission(actor, 'delivery:riders')
    const input: DeliveryRiderInput = riderSchema.parse(rawInput)
    const id = input.id ?? randomUUID()
    const employeeCode = input.employeeCode.trim() || null
    try {
      this.transaction(() => {
        if (input.id) {
          const result = this.database.prepare(`
            UPDATE delivery_riders SET name = ?, employee_code = ?, contact_number = ?,
              active = ?, availability = ?, max_active_deliveries = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(input.name, employeeCode, input.contactNumber, Number(input.active),
            input.availability, input.maxActiveDeliveries, id)
          if (result.changes !== 1) throw new Error('Delivery rider was not found. Refresh the rider list.')
          this.audit(actor, 'delivery.rider_updated', id, 'rider_updated', input)
        } else {
          this.database.prepare(`
            INSERT INTO delivery_riders
              (id, name, employee_code, contact_number, active, availability, max_active_deliveries)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(id, input.name, employeeCode, input.contactNumber, Number(input.active),
            input.availability, input.maxActiveDeliveries)
          this.audit(actor, 'delivery.rider_created', id, 'rider_created', input)
        }
      })
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('delivery_riders.employee_code')) {
        throw new Error('That employee code is already in use.')
      }
      throw cause
    }
    const rider = this.listRiders().find((item) => item.id === id)
    if (!rider) throw new Error('Rider was saved but could not be reloaded.')
    return rider
  }

  updateSchedule(actor: StaffIdentity, rawInput: unknown): void {
    hasRolePermission(actor, 'delivery:operate')
    const input: DeliveryScheduleInput = scheduleSchema.parse(rawInput)
    const pickupAt = input.scheduledPickupAt ? new Date(input.scheduledPickupAt).getTime() : null
    const promiseAt = input.promisedDeliveryAt ? new Date(input.promisedDeliveryAt).getTime() : null
    if (pickupAt !== null && promiseAt !== null && pickupAt > promiseAt) {
      throw new Error('Scheduled pickup must be before the promised delivery time.')
    }
    this.transaction(() => {
      const order = this.orderForUpdate(input.orderId)
      if (order.deliveryStatus === 'delivered' || order.deliveryStatus === 'cancelled') {
        throw new Error('A completed or cancelled delivery cannot be rescheduled.')
      }
      const result = this.database.prepare(`
        UPDATE orders SET scheduled_pickup_at = ?, scheduled_delivery_at = ?
        WHERE id = ? AND type = 'delivery' AND voided_at IS NULL
      `).run(input.scheduledPickupAt, input.promisedDeliveryAt, input.orderId)
      if (result.changes !== 1) throw new Error('Delivery schedule could not be saved. Refresh and retry.')
      this.recordEvent(actor, input.orderId, 'schedule_updated', order.deliveryStatus, order.deliveryStatus,
        order.riderId, order.riderId, '', {
          scheduledPickupAt: input.scheduledPickupAt,
          promisedDeliveryAt: input.promisedDeliveryAt,
        })
    })
  }

  recordCustomerDetailsUpdated(
    actor: StaffIdentity,
    orderId: string,
    previous: {
      customerName: string; contactNumber: string; deliveryAddress: string
      deliveryArea: string; deliveryLandmark: string; deliveryInstructions: string
    },
    next: {
      customerName: string; contactNumber: string; deliveryAddress: string
      deliveryArea: string; deliveryLandmark: string; deliveryInstructions: string
    },
  ): void {
    const order = this.orderForUpdate(orderId)
    if (previous.customerName === next.customerName
      && previous.contactNumber === next.contactNumber
      && previous.deliveryAddress === next.deliveryAddress
      && previous.deliveryArea === next.deliveryArea
      && previous.deliveryLandmark === next.deliveryLandmark
      && previous.deliveryInstructions === next.deliveryInstructions) return
    this.recordEvent(actor, orderId, 'customer_details_updated', order.deliveryStatus,
      order.deliveryStatus, order.riderId, order.riderId, 'customer_details_corrected', {
        previous,
        next,
      })
  }

  assignRider(actor: StaffIdentity, rawInput: unknown): void {
    hasRolePermission(actor, 'delivery:assign')
    const input = assignmentSchema.parse(rawInput)
    this.transaction(() => {
      const order = this.orderForUpdate(input.orderId)
      if (order.foodStatus !== 'ready') throw new Error('Mark the order ready for pickup before assigning a rider.')
      if (order.voidedAt) throw new Error('A voided bill cannot receive a delivery assignment.')
      if (order.deliveryStatus === 'delivered' || order.deliveryStatus === 'cancelled') {
        throw new Error('This delivery is already closed.')
      }
      if (order.riderId === input.riderId && order.deliveryStatus === 'assigned') return
      if (order.riderId && order.riderId !== input.riderId) {
        hasRolePermission(actor, 'delivery:reassign')
        if (input.reason.length < 3) throw new Error('Enter a reason when reassigning a delivery.')
      }
      const rider = this.database.prepare(`
        SELECT id, active, availability, max_active_deliveries AS capacity
        FROM delivery_riders WHERE id = ?
      `).get(input.riderId) as {
        id: string; active: number; availability: DeliveryRider['availability']; capacity: number
      } | undefined
      if (!rider) throw new Error('The selected delivery rider no longer exists.')
      if (rider.active !== 1) throw new Error('An inactive rider cannot receive a delivery.')
      if (rider.availability !== 'available') throw new Error('This rider is unavailable or off shift.')
      const workload = (this.database.prepare(`
        SELECT COUNT(*) AS count FROM orders
        WHERE delivery_rider_id = ? AND delivery_status IN ('assigned', 'dispatched')
          AND voided_at IS NULL
      `).get(rider.id) as { count: number }).count
      if (workload >= rider.capacity) throw new Error('This rider has reached their active delivery capacity.')

      const eventType = order.riderId && order.riderId !== rider.id ? 'reassigned' : 'assigned'
      const result = this.database.prepare(`
        UPDATE orders SET delivery_rider_id = ?, assigned_delivery_to = ?, delivery_status = 'assigned'
        WHERE id = ? AND type = 'delivery' AND delivery_status = ? AND delivery_rider_id IS ?
          AND voided_at IS NULL
      `).run(rider.id, this.riderName(rider.id), input.orderId, order.deliveryStatus, order.riderId)
      if (result.changes !== 1) throw new Error('The delivery changed while assigning it. Refresh and try again.')
      this.recordEvent(actor, input.orderId, eventType, order.deliveryStatus, 'assigned',
        order.riderId, rider.id, input.reason, { riderId: rider.id })
    })
  }

  operate(actor: StaffIdentity, rawInput: unknown): void {
    const input: DeliveryOperation = operationSchema.parse(rawInput)
    const permission = input.kind === 'cancelled' ? 'delivery:cancel' : 'delivery:operate'
    hasRolePermission(actor, permission)
    this.transaction(() => {
      const order = this.orderForUpdate(input.orderId)
      if (input.kind === 'ready_for_pickup') {
        if (order.foodStatus === 'ready') throw new Error('This order is already ready for pickup.')
        if (order.foodStatus !== 'ordering' && order.foodStatus !== 'preparing') {
          throw new Error('This order cannot be marked ready in its current food-preparation state.')
        }
        const result = this.database.prepare(`
          UPDATE orders SET status = 'ready', ready_for_pickup_at = COALESCE(ready_for_pickup_at, datetime('now'))
          WHERE id = ? AND type = 'delivery' AND status IN ('ordering', 'preparing')
        `).run(input.orderId)
        if (result.changes !== 1) throw new Error('Order readiness changed. Refresh and try again.')
        this.recordEvent(actor, input.orderId, 'ready_for_pickup', order.deliveryStatus,
          order.deliveryStatus, order.riderId, order.riderId, '', {})
        return
      }

      if (input.kind === 'dispatch') {
        if (order.deliveryStatus !== 'assigned' || !order.riderId) {
          throw new Error('Assign an eligible rider before dispatching this order.')
        }
        if (!order.contactNumber.trim() || !order.deliveryAddress.trim()) {
          throw new Error('Enter the customer contact number and full delivery address before dispatch.')
        }
        const result = this.database.prepare(`
          UPDATE orders SET delivery_status = 'dispatched',
            actual_pickup_at = COALESCE(actual_pickup_at, datetime('now')),
            dispatched_at = datetime('now')
          WHERE id = ? AND type = 'delivery' AND delivery_status = 'assigned' AND delivery_rider_id = ?
        `).run(input.orderId, order.riderId)
        if (result.changes !== 1) throw new Error('Delivery assignment changed. Refresh and try again.')
        this.recordEvent(actor, input.orderId, 'dispatched', 'assigned', 'dispatched',
          order.riderId, order.riderId, '', {})
        return
      }

      if (input.kind === 'delivered') {
        if (order.deliveryStatus !== 'dispatched') throw new Error('Only an out-for-delivery order can be completed.')
        const result = this.database.prepare(`
          UPDATE orders SET delivery_status = 'delivered', delivered_at = datetime('now')
          WHERE id = ? AND type = 'delivery' AND delivery_status = 'dispatched' AND delivered_at IS NULL
        `).run(input.orderId)
        if (result.changes !== 1) throw new Error('Delivery completion was already recorded. Refresh the schedule.')
        this.recordEvent(actor, input.orderId, 'delivered', 'dispatched', 'delivered',
          order.riderId, order.riderId, input.notes ?? '', {})
        return
      }

      if (input.kind === 'failed') {
        if (order.deliveryStatus !== 'dispatched') throw new Error('Only an out-for-delivery order can be marked failed.')
        this.updateDeliveryStatus(input.orderId, 'dispatched', 'failed')
        this.recordEvent(actor, input.orderId, 'failed', 'dispatched', 'failed',
          order.riderId, order.riderId, input.reason, {})
        return
      }

      if (input.kind === 'cancelled') {
        if (order.deliveryStatus === 'delivered' || order.deliveryStatus === 'cancelled') {
          throw new Error('This delivery is already closed.')
        }
        if (order.paidAt) throw new Error('A paid delivery cannot be cancelled here; use the separate refund/correction workflow.')
        this.updateDeliveryStatus(input.orderId, order.deliveryStatus, 'cancelled')
        this.recordEvent(actor, input.orderId, 'cancelled', order.deliveryStatus, 'cancelled',
          order.riderId, order.riderId, input.reason, {})
      }
    })
  }

  listEvents(orderId: string): DeliveryEvent[] {
    const id = z.string().uuid().parse(orderId)
    return z.array(deliveryEventSchema).parse(this.database.prepare(`
      SELECT id, order_id AS orderId, event_type AS eventType,
        previous_status AS previousStatus, new_status AS newStatus,
        previous_rider_id AS previousRiderId, new_rider_id AS newRiderId,
        actor, reason, created_at AS createdAt
      FROM delivery_events WHERE order_id = ? ORDER BY created_at DESC, rowid DESC
    `).all(id))
  }

  private riderRows(): RiderRow[] {
    return this.database.prepare(`
      SELECT r.id, r.name, r.employee_code AS employeeCode,
        r.contact_number AS contactNumber, r.active, r.availability,
        r.max_active_deliveries AS maxActiveDeliveries,
        COALESCE((SELECT MAX(e.created_at) FROM delivery_events e
          WHERE e.new_rider_id = r.id OR e.previous_rider_id = r.id), r.updated_at) AS lastStatusUpdate,
        (SELECT COUNT(*) FROM orders o WHERE o.delivery_rider_id = r.id
          AND o.delivery_status IN ('assigned', 'dispatched')
          AND o.voided_at IS NULL) AS activeDeliveryCount,
        (SELECT COUNT(*) FROM orders o WHERE o.delivery_rider_id = r.id
          AND o.delivery_status = 'delivered') AS completedDeliveryCount
      FROM delivery_riders r ORDER BY r.active DESC, r.name COLLATE NOCASE
    `).all() as RiderRow[]
  }

  private riderFromRow(row: RiderRow): DeliveryRider {
    const active = row.active === 1
    const derivedAvailability = !active ? 'inactive'
      : row.availability === 'off_shift' ? 'off_shift'
        : row.availability === 'unavailable' ? 'unavailable'
          : row.activeDeliveryCount > 0 ? 'busy' : 'available'
    const canAcceptDelivery = active && row.availability === 'available'
      && row.activeDeliveryCount < row.maxActiveDeliveries
    return {
      id: row.id,
      name: row.name,
      employeeCode: row.employeeCode ?? '',
      contactNumber: row.contactNumber,
      active,
      availability: row.availability,
      maxActiveDeliveries: row.maxActiveDeliveries,
      activeDeliveryCount: row.activeDeliveryCount,
      completedDeliveryCount: row.completedDeliveryCount,
      lastStatusUpdate: row.lastStatusUpdate,
      canAcceptDelivery,
      derivedAvailability,
    }
  }

  private orderForUpdate(orderId: string): {
    foodStatus: string
    deliveryStatus: DeliveryScheduleEntry['deliveryStatus']
    riderId: string | null
    paidAt: string | null
    voidedAt: string | null
    customerName: string
    contactNumber: string
    deliveryAddress: string
  } {
    const order = this.database.prepare(`
      SELECT status AS foodStatus, delivery_status AS deliveryStatus,
        delivery_rider_id AS riderId, paid_at AS paidAt, voided_at AS voidedAt,
        customer_name AS customerName, contact_number AS contactNumber,
        delivery_address AS deliveryAddress
      FROM orders WHERE id = ? AND type = 'delivery'
    `).get(orderId) as {
      foodStatus: string; deliveryStatus: DeliveryScheduleEntry['deliveryStatus']
      riderId: string | null; paidAt: string | null; voidedAt: string | null
      customerName: string; contactNumber: string; deliveryAddress: string
    } | undefined
    if (!order) throw new Error('Delivery order not found.')
    if (order.voidedAt) throw new Error('A voided bill cannot be changed in delivery management.')
    return order
  }

  private riderName(riderId: string): string {
    const rider = this.database.prepare('SELECT name FROM delivery_riders WHERE id = ?').get(riderId) as { name: string } | undefined
    if (!rider) throw new Error('The selected delivery rider no longer exists.')
    return rider.name
  }

  private updateDeliveryStatus(orderId: string, previous: string, next: string): void {
    const result = this.database.prepare(`
      UPDATE orders SET delivery_status = ?
      WHERE id = ? AND type = 'delivery' AND delivery_status = ?
    `).run(next, orderId, previous)
    if (result.changes !== 1) throw new Error('Delivery status changed. Refresh and try again.')
  }

  private recordEvent(
    actor: StaffIdentity,
    orderId: string,
    eventType: string,
    previousStatus: string,
    newStatus: string,
    previousRiderId: string | null,
    newRiderId: string | null,
    reason: string,
    details: object,
  ): void {
    const id = randomUUID()
    this.database.prepare(`
      INSERT INTO delivery_events
        (id, order_id, event_type, previous_status, new_status, previous_rider_id,
          new_rider_id, actor_id, actor, reason, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orderId, eventType, previousStatus, newStatus, previousRiderId,
      newRiderId, actor.id, actor.username, reason, JSON.stringify(details))
    this.database.prepare(`
      INSERT INTO audit_log (id, action, entity_type, entity_id, actor, reason, details_json)
      VALUES (?, ?, 'delivery', ?, ?, ?, ?)
    `).run(randomUUID(), `delivery.${eventType}`, orderId, actor.username, reason, JSON.stringify({
      staffRole: actor.role,
      previousStatus,
      newStatus,
      previousRiderId,
      newRiderId,
      ...details,
    }))
  }

  private audit(actor: StaffIdentity, action: string, entityId: string, reason: string, details: object): void {
    this.database.prepare(`
      INSERT INTO audit_log (id, action, entity_type, entity_id, actor, reason, details_json)
      VALUES (?, ?, 'delivery_rider', ?, ?, ?, ?)
    `).run(randomUUID(), action, entityId, actor.username, reason, JSON.stringify({
      staffRole: actor.role,
      ...details,
    }))
  }
}
