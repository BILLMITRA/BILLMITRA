import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { SavedOrder, StaffIdentity } from '../../shared/domain.js'

// Saving moves an unpaid bill off the floor; money and kitchen tickets stay unchanged.
export class SavedTableBills {
  constructor(private db: DatabaseSync, private transaction: <T>(fn: () => T) => T, private order: (id: string) => SavedOrder | null) {}
  migrate() {
    this.transaction(() => {
      if (this.db.prepare('SELECT version FROM schema_migrations WHERE version=17').get()) return
      this.db.exec(`ALTER TABLE orders ADD COLUMN saved_at TEXT;
        ALTER TABLE orders ADD COLUMN saved_by TEXT;
        ALTER TABLE orders ADD COLUMN saved_table_name TEXT;
        ALTER TABLE orders ADD COLUMN saved_table_floor TEXT;
        DROP INDEX one_open_order_per_table;
        CREATE UNIQUE INDEX one_open_order_per_table ON orders(table_id)
          WHERE table_id IS NOT NULL AND paid_at IS NULL AND voided_at IS NULL AND saved_at IS NULL;
        INSERT INTO schema_migrations(version) VALUES(17);`)
    })
  }
  save(actor: StaffIdentity, raw: unknown): SavedOrder {
    const { orderId } = z.object({ orderId: z.string().uuid() }).strict().parse(raw)
    return this.transaction(() => {
      const order = this.order(orderId)
      if (!order) throw new Error('Order not found. Refresh tables.')
      // Retrying a lost response must never affect the next guests at this table.
      if (order.savedAt) return order
      if (order.type !== 'dine_in' || !order.tableId || ['paid', 'voided'].includes(order.status)) throw new Error('Only an unpaid table bill can be saved for the cashier.')
      const table = this.db.prepare('SELECT name,floor FROM restaurant_tables WHERE id=?').get(order.tableId) as { name: string; floor: string }
      this.db.prepare(`UPDATE orders SET saved_at=datetime('now'), saved_by=?, saved_table_name=?, saved_table_floor=? WHERE id=?`).run(actor.displayName, table.name, table.floor, order.id)
      this.db.prepare(`INSERT INTO audit_log(id,action,entity_type,entity_id,actor,reason,details_json)
        VALUES(?,'order.saved_for_cashier','order',?,?,'table_released',?)`).run(randomUUID(), order.id, actor.username, JSON.stringify({ tableId: order.tableId, tableName: table.name, floor: table.floor }))
      return this.order(order.id)!
    })
  }
}
