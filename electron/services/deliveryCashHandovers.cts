import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DeliveryCashHandover, DeliveryCashHandoverInput, StaffIdentity } from '../../shared/domain.js'
import { staffHasPermission } from '../../shared/staffPermissions.js'
import type { FinancialManagementService } from './financialManagement.cjs'

const inputSchema = z.object({
  requestId: z.string().uuid(),
  riderId: z.string().uuid(),
  notes: z.string().trim().max(250),
  lines: z.array(z.object({ orderId: z.string().uuid(), amountPaise: z.number().int().positive().max(1_000_000_000_000) }))
    .min(1).max(50).refine(lines => new Set(lines.map(line => line.orderId)).size === lines.length, 'Select each bill only once.'),
}).strict()

type HandoverRow = {
  id: string; riderId: string; riderName: string; cashier: string; notes: string
  amountPaise: number; createdAt: string; fingerprint: string
}

export class DeliveryCashHandovers {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(action: () => T) => T,
    private readonly financial: FinancialManagementService,
  ) {}

  migrate(): void {
    this.transaction(() => {
      if (this.db.prepare('SELECT version FROM schema_migrations WHERE version=18').get()) return
      this.db.exec(`CREATE TABLE delivery_cash_handovers (
        id TEXT PRIMARY KEY, rider_id TEXT NOT NULL REFERENCES delivery_riders(id),
        rider_name TEXT NOT NULL, cashier_id TEXT NOT NULL, cashier TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL,
        amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
        created_at TEXT NOT NULL DEFAULT(datetime('now')));
        CREATE INDEX delivery_cash_handovers_rider_date ON delivery_cash_handovers(rider_id, created_at DESC);
        CREATE TABLE delivery_cash_handover_items (
          handover_id TEXT NOT NULL REFERENCES delivery_cash_handovers(id),
          order_id TEXT NOT NULL REFERENCES orders(id), tender_id TEXT NOT NULL UNIQUE REFERENCES payment_tenders(id),
          reference TEXT NOT NULL, amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
          PRIMARY KEY(handover_id, order_id));
        INSERT INTO schema_migrations(version) VALUES(18);`)
    })
  }

  record(actor: StaffIdentity, raw: unknown): DeliveryCashHandover {
    if (!staffHasPermission(actor.role, 'payments:record') || !staffHasPermission(actor.role, 'delivery:view')) {
      throw new Error('Your staff role cannot record rider cash handovers.')
    }
    const input: DeliveryCashHandoverInput = inputSchema.parse(raw)
    const fingerprint = JSON.stringify({ riderId: input.riderId, notes: input.notes,
      lines: [...input.lines].sort((a, b) => a.orderId.localeCompare(b.orderId)) })
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT fingerprint FROM delivery_cash_handovers WHERE id=?').get(input.requestId) as { fingerprint: string } | undefined
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('This handover request was already used for different details. Refresh the settlement.')
        return this.load(input.requestId)
      }
      const rider = this.db.prepare('SELECT name FROM delivery_riders WHERE id=?').get(input.riderId) as { name: string } | undefined
      if (!rider) throw new Error('Delivery staff was not found. Refresh the rider list.')
      const validated = input.lines.map(line => {
        const order = this.db.prepare(`SELECT type, delivery_status AS deliveryStatus,
          delivery_rider_id AS riderId, delivery_number AS deliveryNumber,
          display_number AS orderNumber, voided_at AS voidedAt FROM orders WHERE id=?`).get(line.orderId) as {
            type: string; deliveryStatus: string; riderId: string | null; deliveryNumber: number | null
            orderNumber: number; voidedAt: string | null
          } | undefined
        if (!order || order.type !== 'delivery' || order.riderId !== input.riderId) throw new Error('A selected bill is no longer assigned to this rider. Refresh the settlement.')
        if (order.deliveryStatus !== 'delivered' || order.voidedAt) throw new Error('Only delivered, active bills can be included in a cash handover.')
        const ledger = this.financial.ledger(line.orderId)
        if (ledger.settled || line.amountPaise > ledger.balancePaise) throw new Error('Cash received exceeds a bill’s remaining balance. Refresh the settlement.')
        return { ...line, reference: order.deliveryNumber === null ? `#${order.orderNumber}` : `HD-${order.deliveryNumber}` }
      })
      const amountPaise = validated.reduce((sum, line) => sum + line.amountPaise, 0)
      this.db.prepare(`INSERT INTO delivery_cash_handovers
        (id, rider_id, rider_name, cashier_id, cashier, notes, fingerprint, amount_paise)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.requestId, input.riderId, rider.name,
          actor.id, actor.username, input.notes, fingerprint, amountPaise)
      for (const line of validated) {
        const tenderRequestId = randomUUID()
        this.financial.collectInExistingTransaction(actor, {
          requestId: tenderRequestId, orderId: line.orderId, method: 'cash', amountPaise: line.amountPaise,
        })
        const tender = this.db.prepare('SELECT id FROM payment_tenders WHERE request_id=?').get(tenderRequestId) as { id: string }
        this.db.prepare(`INSERT INTO delivery_cash_handover_items
          (handover_id, order_id, tender_id, reference, amount_paise) VALUES (?, ?, ?, ?, ?)`).run(
          input.requestId, line.orderId, tender.id, line.reference, line.amountPaise)
      }
      this.db.prepare(`INSERT INTO audit_log(id,action,entity_type,entity_id,actor,reason,details_json)
        VALUES(?,'delivery.cash_handover','delivery_cash_handover',?,?,'rider_cash_received',?)`).run(
          randomUUID(), input.requestId, actor.username,
          JSON.stringify({ riderId: input.riderId, amountPaise, orderIds: validated.map(line => line.orderId) }))
      return this.load(input.requestId)
    })
  }

  list(actor: StaffIdentity, rawRiderId: unknown): DeliveryCashHandover[] {
    if (!staffHasPermission(actor.role, 'delivery:view')) throw new Error('Your staff role cannot view rider cash handovers.')
    const riderId = z.string().uuid().parse(rawRiderId)
    return (this.db.prepare(`SELECT id, rider_id AS riderId, rider_name AS riderName,
      cashier, notes, amount_paise AS amountPaise, created_at AS createdAt, fingerprint
      FROM delivery_cash_handovers WHERE rider_id=? ORDER BY rowid DESC LIMIT 200`).all(riderId) as HandoverRow[])
      .map(row => this.fromRow(row))
  }

  private load(id: string): DeliveryCashHandover {
    const row = this.db.prepare(`SELECT id, rider_id AS riderId, rider_name AS riderName,
      cashier, notes, amount_paise AS amountPaise, created_at AS createdAt, fingerprint
      FROM delivery_cash_handovers WHERE id=?`).get(id) as HandoverRow | undefined
    if (!row) throw new Error('Cash handover could not be loaded.')
    return this.fromRow(row)
  }

  private fromRow({ fingerprint: _fingerprint, ...row }: HandoverRow): DeliveryCashHandover {
    const lines = this.db.prepare(`SELECT i.order_id AS orderId, i.reference,
      i.amount_paise AS amountPaise,
      COALESCE((SELECT SUM(r.amount_paise) FROM payment_refunds r WHERE r.tender_id=i.tender_id),0) AS refundedPaise
      FROM delivery_cash_handover_items i WHERE i.handover_id=? ORDER BY i.rowid`).all(row.id) as DeliveryCashHandover['lines']
    return { ...row, lines }
  }
}
