import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DeliveryFloatIssue, DeliveryRunSettlement, RiderRunState, StaffIdentity } from '../../shared/domain.js'
import { staffHasPermission } from '../../shared/staffPermissions.js'
import type { FinancialManagementService } from './financialManagement.cjs'

const money = z.number().int().min(0).max(1_000_000_000_000)
const riderId = z.string().uuid()
const issueInput = z.object({ requestId: z.string().uuid(), riderId, amountPaise: money.positive(), notes: z.string().trim().max(250) }).strict()
const closeInput = z.object({ requestId: z.string().uuid(), riderId, receivedPaise: money, notes: z.string().trim().max(250) }).strict()

type OrderRow = { id: string; deliveryNumber: number | null; orderNumber: number; deliveryStatus: string; totalPaise: number }
type FloatRow = { id: string; riderId: string; riderName: string; amountPaise: number; cashier: string; notes: string; createdAt: string; settlementId: string | null }

export class DeliveryRunSettlements {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(action: () => T) => T,
    private readonly financial: FinancialManagementService) {}

  migrate(): void {
    this.transaction(() => {
      if (this.db.prepare('SELECT version FROM schema_migrations WHERE version=19').get()) return
      this.db.exec(`
        ALTER TABLE orders ADD COLUMN delivery_settled_at TEXT;
        UPDATE orders SET delivery_settled_at=COALESCE(paid_at,delivered_at,created_at)
          WHERE type='delivery' AND paid_at IS NOT NULL;
        DROP INDEX one_active_delivery_slot;
        CREATE UNIQUE INDEX one_active_delivery_slot ON orders(delivery_number)
          WHERE type='delivery' AND delivery_number IS NOT NULL AND delivery_settled_at IS NULL AND voided_at IS NULL;
        CREATE TABLE delivery_float_issues(id TEXT PRIMARY KEY, rider_id TEXT NOT NULL REFERENCES delivery_riders(id),
          rider_name TEXT NOT NULL, amount_paise INTEGER NOT NULL CHECK(amount_paise>0), cashier TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '', settlement_id TEXT, created_at TEXT NOT NULL DEFAULT(datetime('now')));
        CREATE INDEX delivery_float_rider_open ON delivery_float_issues(rider_id,settlement_id);
        CREATE TABLE delivery_run_settlements(id TEXT PRIMARY KEY, rider_id TEXT NOT NULL REFERENCES delivery_riders(id),
          rider_name TEXT NOT NULL, cashier TEXT NOT NULL, float_paise INTEGER NOT NULL, bills_paise INTEGER NOT NULL,
          received_paise INTEGER NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT(datetime('now')));
        CREATE TABLE delivery_run_settlement_items(settlement_id TEXT NOT NULL REFERENCES delivery_run_settlements(id),
          order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), reference TEXT NOT NULL, total_paise INTEGER NOT NULL,
          cash_paise INTEGER NOT NULL, PRIMARY KEY(settlement_id,order_id));
        CREATE TABLE delivery_cash_movements(id TEXT PRIMARY KEY, amount_paise INTEGER NOT NULL,
          reason TEXT NOT NULL CHECK(reason IN ('float_issued','float_returned')),
          created_at TEXT NOT NULL DEFAULT(datetime('now')));
        ALTER TABLE cash_closes ADD COLUMN movement_cutoff INTEGER NOT NULL DEFAULT 0;
        INSERT INTO schema_migrations(version) VALUES(19);
      `)
    })
  }

  private requireCashier(actor: StaffIdentity): void {
    if (!staffHasPermission(actor.role, 'payments:record') || !staffHasPermission(actor.role, 'delivery:view'))
      throw new Error('Your staff role cannot settle delivery cash.')
  }

  private rider(rawId: string): { name: string } {
    const rider = this.db.prepare('SELECT name FROM delivery_riders WHERE id=?').get(rawId) as { name: string } | undefined
    if (!rider) throw new Error('Delivery staff was not found. Refresh the rider list.')
    return rider
  }

  state(actor: StaffIdentity, rawRiderId: unknown): RiderRunState {
    if (!staffHasPermission(actor.role, 'delivery:view')) throw new Error('Your staff role cannot view rider settlement.')
    const id = riderId.parse(rawRiderId)
    this.rider(id)
    const floats = this.db.prepare(`SELECT id, rider_id AS riderId, rider_name AS riderName,
      amount_paise AS amountPaise, cashier, notes, created_at AS createdAt, settlement_id AS settlementId
      FROM delivery_float_issues WHERE rider_id=? ORDER BY rowid DESC LIMIT 200`).all(id) as FloatRow[]
    const openOrders = this.db.prepare(`SELECT id, delivery_number AS deliveryNumber, display_number AS orderNumber,
      delivery_status AS deliveryStatus, total_paise AS totalPaise FROM orders
      WHERE type='delivery' AND delivery_rider_id=? AND delivery_settled_at IS NULL AND voided_at IS NULL
        AND delivery_status NOT IN ('cancelled','failed')
      ORDER BY created_at`).all(id) as OrderRow[]
    const bills = openOrders.map(order => ({ orderId: order.id,
      reference: order.deliveryNumber === null ? `#${order.orderNumber}` : `HD-${order.deliveryNumber}`,
      deliveryStatus: order.deliveryStatus, totalPaise: order.totalPaise,
      balancePaise: this.financial.ledger(order.id).balancePaise }))
    const settlements = this.db.prepare(`SELECT id, rider_id AS riderId, rider_name AS riderName, cashier,
      float_paise AS floatPaise, bills_paise AS billsPaise, received_paise AS receivedPaise,
      notes, created_at AS createdAt FROM delivery_run_settlements WHERE rider_id=? ORDER BY rowid DESC LIMIT 100`).all(id)
      .map(row => this.withItems(row as Omit<DeliveryRunSettlement, 'items'>))
    const outstandingFloatPaise = (this.db.prepare(`SELECT COALESCE(SUM(amount_paise),0) AS amount
      FROM delivery_float_issues WHERE rider_id=? AND settlement_id IS NULL`).get(id) as { amount: number }).amount
    return { floats, bills, settlements, outstandingFloatPaise }
  }

  issue(actor: StaffIdentity, raw: unknown): DeliveryFloatIssue {
    this.requireCashier(actor)
    const input = issueInput.parse(raw)
    return this.transaction(() => {
      const prior = this.db.prepare(`SELECT id, rider_id AS riderId, rider_name AS riderName,
        amount_paise AS amountPaise, cashier, notes, created_at AS createdAt, settlement_id AS settlementId
        FROM delivery_float_issues WHERE id=?`).get(input.requestId) as FloatRow | undefined
      if (prior) {
        if (prior.riderId !== input.riderId || prior.amountPaise !== input.amountPaise || prior.notes !== input.notes)
          throw new Error('This float request was already used with different details.')
        return prior
      }
      const rider = this.rider(input.riderId)
      this.db.prepare(`INSERT INTO delivery_float_issues(id,rider_id,rider_name,amount_paise,cashier,notes)
        VALUES(?,?,?,?,?,?)`).run(input.requestId, input.riderId, rider.name, input.amountPaise, actor.username, input.notes)
      this.db.prepare(`INSERT INTO delivery_cash_movements(id,amount_paise,reason) VALUES(?,?,'float_issued')`)
        .run(input.requestId, -input.amountPaise)
      this.audit(actor, 'delivery.float_issued', input.requestId, { riderId: input.riderId, amountPaise: input.amountPaise })
      return this.db.prepare(`SELECT id, rider_id AS riderId, rider_name AS riderName,
        amount_paise AS amountPaise, cashier, notes, created_at AS createdAt, settlement_id AS settlementId
        FROM delivery_float_issues WHERE id=?`).get(input.requestId) as FloatRow
    })
  }

  close(actor: StaffIdentity, raw: unknown): DeliveryRunSettlement {
    this.requireCashier(actor)
    const input = closeInput.parse(raw)
    return this.transaction(() => {
      const prior = this.db.prepare(`SELECT id, rider_id AS riderId, rider_name AS riderName, cashier,
        float_paise AS floatPaise, bills_paise AS billsPaise, received_paise AS receivedPaise,
        notes, created_at AS createdAt FROM delivery_run_settlements WHERE id=?`).get(input.requestId) as Omit<DeliveryRunSettlement, 'items'> | undefined
      if (prior) {
        if (prior.riderId !== input.riderId || prior.receivedPaise !== input.receivedPaise || prior.notes !== input.notes)
          throw new Error('This settlement request was already used with different details.')
        return this.withItems(prior)
      }
      const rider = this.rider(input.riderId)
      const state = this.state(actor, input.riderId)
      if (!state.bills.length && state.outstandingFloatPaise === 0) throw new Error('No open delivery bills or change money are assigned to this rider.')
      const billsPaise = state.bills.reduce((sum, bill) => sum + bill.balancePaise, 0)
      const expected = state.outstandingFloatPaise + billsPaise
      if (input.receivedPaise !== expected)
        throw new Error(`Cash count differs from expected return by ₹${(Math.abs(input.receivedPaise - expected) / 100).toFixed(2)}. Recount or record other payments before closing.`)
      this.db.prepare(`INSERT INTO delivery_run_settlements(id,rider_id,rider_name,cashier,float_paise,bills_paise,received_paise,notes)
        VALUES(?,?,?,?,?,?,?,?)`).run(input.requestId, input.riderId, rider.name, actor.username,
          state.outstandingFloatPaise, billsPaise, input.receivedPaise, input.notes)
      for (const bill of state.bills) {
        if (bill.balancePaise > 0) this.financial.collectInExistingTransaction(actor, {
          requestId: randomUUID(), orderId: bill.orderId, method: 'cash', amountPaise: bill.balancePaise,
        })
        this.db.prepare(`INSERT INTO delivery_run_settlement_items(settlement_id,order_id,reference,total_paise,cash_paise)
          VALUES(?,?,?,?,?)`).run(input.requestId, bill.orderId, bill.reference, bill.totalPaise, bill.balancePaise)
        this.db.prepare(`UPDATE orders SET delivery_settled_at=datetime('now'),
          delivery_status='delivered', delivered_at=COALESCE(delivered_at,datetime('now'))
          WHERE id=? AND delivery_settled_at IS NULL`).run(bill.orderId)
        if (bill.deliveryStatus !== 'delivered') this.db.prepare(`INSERT INTO delivery_events
          (id,order_id,event_type,previous_status,new_status,previous_rider_id,new_rider_id,
            actor_id,actor,reason,details_json) VALUES(?,?,'delivered',?,'delivered',?,?,?,?,'run_settlement',?)`)
          .run(randomUUID(), bill.orderId, bill.deliveryStatus, input.riderId, input.riderId,
            actor.id, actor.username, JSON.stringify({ settlementId: input.requestId }))
      }
      this.db.prepare(`UPDATE delivery_float_issues SET settlement_id=? WHERE rider_id=? AND settlement_id IS NULL`)
        .run(input.requestId, input.riderId)
      if (state.outstandingFloatPaise > 0)
        this.db.prepare(`INSERT INTO delivery_cash_movements(id,amount_paise,reason) VALUES(?,?,'float_returned')`)
          .run(input.requestId, state.outstandingFloatPaise)
      this.audit(actor, 'delivery.run_settled', input.requestId, {
        riderId: input.riderId, floatPaise: state.outstandingFloatPaise, billsPaise,
        receivedPaise: input.receivedPaise, orderIds: state.bills.map(bill => bill.orderId),
      })
      return this.withItems({ id: input.requestId, riderId: input.riderId, riderName: rider.name,
        cashier: actor.username, floatPaise: state.outstandingFloatPaise, billsPaise,
        receivedPaise: input.receivedPaise, notes: input.notes,
        createdAt: (this.db.prepare('SELECT created_at AS createdAt FROM delivery_run_settlements WHERE id=?')
          .get(input.requestId) as { createdAt: string }).createdAt })
    })
  }

  private withItems(row: Omit<DeliveryRunSettlement, 'items'>): DeliveryRunSettlement {
    const items = this.db.prepare(`SELECT order_id AS orderId,reference,total_paise AS totalPaise,
      cash_paise AS cashPaise FROM delivery_run_settlement_items WHERE settlement_id=? ORDER BY rowid`)
      .all(row.id) as DeliveryRunSettlement['items']
    return { ...row, items }
  }

  private audit(actor: StaffIdentity, action: string, id: string, details: unknown): void {
    this.db.prepare(`INSERT INTO audit_log(id,action,entity_type,entity_id,actor,reason,details_json)
      VALUES(?,?,'delivery_run',?,?,'cash_reconciliation',?)`)
      .run(randomUUID(), action, id, actor.username, JSON.stringify(details))
  }
}
