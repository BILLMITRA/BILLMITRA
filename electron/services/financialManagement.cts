import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { StaffIdentity } from '../../shared/domain.js'
import type { PaymentLedger, Tender, Refund } from '../../shared/restaurant.js'

const tenderSchema = z.object({ requestId: z.string().uuid(), orderId: z.string().uuid(),
  method: z.enum(['cash', 'card', 'upi']), amountPaise: z.number().int().positive().max(1_000_000_000_000).optional() })
const refundSchema = z.object({ requestId: z.string().uuid(), tenderId: z.string().uuid(),
  amountPaise: z.number().int().positive().max(1_000_000_000_000), reason: z.string().trim().min(3).max(250) })

export class FinancialManagementService {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(action: () => T) => T) {}
  migrate() {
    this.transaction(() => {
      if (this.db.prepare('SELECT version FROM schema_migrations WHERE version = 13').get()) return
      this.db.exec(`
        CREATE TABLE payments_v13 (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
          request_id TEXT NOT NULL UNIQUE, method TEXT NOT NULL CHECK(method IN ('cash','upi','card','split')),
          amount_paise INTEGER NOT NULL CHECK(amount_paise > 0), paid_at TEXT NOT NULL DEFAULT(datetime('now')));
        INSERT INTO payments_v13(rowid,id,order_id,request_id,method,amount_paise,paid_at)
          SELECT rowid,id,order_id,request_id,method,amount_paise,paid_at FROM payments;
        DROP TABLE payments;
        ALTER TABLE payments_v13 RENAME TO payments;
        CREATE INDEX payments_paid_at ON payments(paid_at DESC);
        CREATE TABLE payment_tenders (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
          order_id TEXT NOT NULL REFERENCES orders(id), method TEXT NOT NULL CHECK(method IN ('cash','card','upi')),
          amount_paise INTEGER NOT NULL CHECK(amount_paise > 0), created_at TEXT NOT NULL DEFAULT(datetime('now')));
        INSERT INTO payment_tenders(rowid,id,request_id,order_id,method,amount_paise,created_at)
          SELECT rowid,id,request_id,order_id,method,amount_paise,paid_at FROM payments;
        CREATE INDEX tenders_order ON payment_tenders(order_id);
        CREATE TABLE payment_refunds (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
          tender_id TEXT NOT NULL REFERENCES payment_tenders(id), amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
          reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now')));
        CREATE INDEX refunds_tender ON payment_refunds(tender_id);
        ALTER TABLE cash_closes ADD COLUMN refund_cutoff INTEGER NOT NULL DEFAULT 0;
        INSERT INTO schema_migrations(version) VALUES(13);
      `)
    })
  }

  ledger(rawId: unknown): PaymentLedger {
    const orderId = z.string().uuid().parse(rawId)
    const order = this.db.prepare('SELECT total_paise AS totalPaise, paid_at AS paidAt FROM orders WHERE id = ?').get(orderId) as { totalPaise: number; paidAt: string | null } | undefined
    if (!order) throw new Error('Bill not found.')
    const tenders = this.db.prepare(`SELECT id, order_id AS orderId, method, amount_paise AS amountPaise,
      created_at AS createdAt FROM payment_tenders WHERE order_id = ? ORDER BY rowid`).all(orderId) as unknown as Tender[]
    const refunds = this.db.prepare(`SELECT r.id, r.tender_id AS tenderId, r.amount_paise AS amountPaise,
      r.reason, r.actor, r.created_at AS createdAt FROM payment_refunds r JOIN payment_tenders t ON t.id = r.tender_id
      WHERE t.order_id = ? ORDER BY r.rowid`).all(orderId) as unknown as Refund[]
    const collectedPaise = tenders.reduce((sum, row) => sum + row.amountPaise, 0)
    const refundedPaise = refunds.reduce((sum, row) => sum + row.amountPaise, 0)
    return { orderId, totalPaise: order.totalPaise, collectedPaise, refundedPaise,
      balancePaise: order.paidAt ? 0 : Math.max(0, order.totalPaise - collectedPaise + refundedPaise), settled: Boolean(order.paidAt), tenders, refunds }
  }

  hasUnrefundedPayments(orderId: string): boolean {
    const ledger = this.ledger(orderId)
    return ledger.collectedPaise > ledger.refundedPaise
  }

  collect(actor: StaffIdentity, raw: unknown): PaymentLedger {
    const input = tenderSchema.parse(raw)
    return this.transaction(() => this.collectInExistingTransaction(actor, input))
  }

  // Used by a larger payment transaction, such as a rider cash handover.
  collectInExistingTransaction(actor: StaffIdentity, raw: unknown): PaymentLedger {
    const input = tenderSchema.parse(raw)
      const prior = this.db.prepare('SELECT order_id, method, amount_paise FROM payment_tenders WHERE request_id = ?').get(input.requestId) as { order_id: string; method: string; amount_paise: number } | undefined
      if (prior) {
        if (prior.order_id !== input.orderId || prior.method !== input.method || (input.amountPaise !== undefined && prior.amount_paise !== input.amountPaise)) throw new Error('This payment request was already used with different details.')
        return this.ledger(input.orderId)
      }
      const ledger = this.ledger(input.orderId)
      const order = this.db.prepare('SELECT voided_at, joined_at FROM orders WHERE id = ?').get(input.orderId) as { voided_at: string | null; joined_at: string | null }
      if (order.voided_at) throw new Error('A voided bill cannot be paid.')
      if (order.joined_at) throw new Error('This bill was joined into another bill and cannot be paid separately.')
      if (ledger.settled) throw new Error('This bill has already been paid.')
      const amount = input.amountPaise ?? ledger.balancePaise
      if (amount <= 0 || amount > ledger.balancePaise) throw new Error('Payment must be positive and cannot exceed the remaining balance.')
      const tenderId = randomUUID()
      this.db.prepare('INSERT INTO payment_tenders(id,request_id,order_id,method,amount_paise) VALUES(?,?,?,?,?)').run(tenderId, input.requestId, input.orderId, input.method, amount)
      const updated = this.ledger(input.orderId)
      if (updated.balancePaise === 0) {
        const methods = new Set(updated.tenders.filter(tender => tender.amountPaise > updated.refunds.filter(refund => refund.tenderId === tender.id).reduce((sum, refund) => sum + refund.amountPaise, 0)).map(tender => tender.method))
        this.db.prepare('INSERT INTO payments(id,order_id,request_id,method,amount_paise) VALUES(?,?,?,?,?)').run(randomUUID(), input.orderId, input.requestId, methods.size > 1 ? 'split' : [...methods][0], updated.totalPaise)
        this.db.prepare("UPDATE orders SET paid_at = datetime('now') WHERE id = ?").run(input.orderId)
      }
      this.audit(actor, 'payment.collected', tenderId, { ...input, amountPaise: amount })
      return this.ledger(input.orderId)
  }

  refund(actor: StaffIdentity, raw: unknown): PaymentLedger {
    const input = refundSchema.parse(raw)
    return this.transaction(() => {
      const tender = this.db.prepare('SELECT order_id, amount_paise FROM payment_tenders WHERE id = ?').get(input.tenderId) as { order_id: string; amount_paise: number } | undefined
      if (!tender) throw new Error('Original payment not found.')
      const prior = this.db.prepare('SELECT tender_id, amount_paise, reason FROM payment_refunds WHERE request_id = ?').get(input.requestId) as { tender_id: string; amount_paise: number; reason: string } | undefined
      if (prior) {
        if (prior.tender_id !== input.tenderId || prior.amount_paise !== input.amountPaise || prior.reason !== input.reason) throw new Error('This refund request was already used with different details.')
        return this.ledger(tender.order_id)
      }
      const refunded = (this.db.prepare('SELECT COALESCE(SUM(amount_paise),0) AS amount FROM payment_refunds WHERE tender_id = ?').get(input.tenderId) as { amount: number }).amount
      if (input.amountPaise > tender.amount_paise - refunded) throw new Error('Refund exceeds the unrefunded amount of this payment.')
      const refundId = randomUUID()
      this.db.prepare('INSERT INTO payment_refunds(id,request_id,tender_id,amount_paise,reason,actor) VALUES(?,?,?,?,?,?)').run(refundId, input.requestId, input.tenderId, input.amountPaise, input.reason, actor.username)
      this.audit(actor, 'payment.refunded', refundId, input)
      return this.ledger(tender.order_id)
    })
  }

  private audit(actor: StaffIdentity, action: string, entityId: string, input: unknown) {
    this.db.prepare(`INSERT INTO audit_log(id,action,entity_type,entity_id,actor,reason,details_json)
      VALUES(?,?,'payment',?,?,'payment_ledger',?)`).run(randomUUID(), action, entityId, actor.username, JSON.stringify(input))
  }
}
