import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { Category, Product, StaffIdentity } from '../../shared/domain.js'
import type { MenuCatalog, SalesReport, InventoryItem, StockMovement, CashSummary, CashClose } from '../../shared/restaurant.js'

const id = z.string().trim().min(1).max(80)
const categorySchema = z.object({ id: id.optional(), name: z.string().trim().min(1).max(80), sortOrder: z.number().int().min(0).max(9999) })
const productSchema = z.object({
  id: id.optional(), categoryId: id, name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500), pricePaise: z.number().int().min(0).max(100_000_000),
  taxRateBps: z.number().int().min(0).max(10000), available: z.boolean(),
})
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}, 'Enter a valid calendar date.')
const reportSchema = z.object({ from: date, to: date }).refine(value => value.from <= value.to, 'The end date must follow the start date.')

export class RestaurantManagementService {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(action: () => T) => T) {}

  migrate() {
    this.transaction(() => {
      if (this.db.prepare('SELECT version FROM schema_migrations WHERE version = 12').get()) return
      this.db.exec(`
        CREATE TABLE inventory_items (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          unit TEXT NOT NULL, quantity_milli INTEGER NOT NULL DEFAULT 0 CHECK(quantity_milli >= 0),
          reorder_milli INTEGER NOT NULL DEFAULT 0 CHECK(reorder_milli >= 0));
        CREATE TABLE stock_movements (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
          item_id TEXT NOT NULL REFERENCES inventory_items(id), delta_milli INTEGER NOT NULL,
          reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now')));
        CREATE TABLE cash_closes (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
          payment_cutoff INTEGER NOT NULL, opening_paise INTEGER NOT NULL, receipts_paise INTEGER NOT NULL,
          expected_paise INTEGER NOT NULL, counted_paise INTEGER NOT NULL, variance_paise INTEGER NOT NULL,
          notes TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now')));
        INSERT INTO schema_migrations(version) VALUES(12);
      `)
    })
  }

  inventory(): InventoryItem[] {
    return this.db.prepare(`SELECT id, name, unit, quantity_milli AS quantityMilli, reorder_milli AS reorderMilli
      FROM inventory_items ORDER BY name`).all() as unknown as InventoryItem[]
  }

  saveInventoryItem(actor: StaffIdentity, raw: unknown): InventoryItem {
    const input = z.object({ id: id.optional(), name: z.string().trim().min(1).max(120),
      unit: z.string().trim().min(1).max(20), reorderMilli: z.number().int().min(0).max(1_000_000_000) }).parse(raw)
    return this.transaction(() => {
      const itemId = input.id ?? randomUUID()
      const previous = this.db.prepare('SELECT unit FROM inventory_items WHERE id = ?').get(itemId) as { unit: string } | undefined
      if (input.id && !previous) throw new Error('Inventory item no longer exists.')
      if (previous && previous.unit !== input.unit) throw new Error('Units cannot change after an inventory item is created.')
      if (this.db.prepare('SELECT id FROM inventory_items WHERE name = ? COLLATE NOCASE AND id <> ?').get(input.name, itemId)) throw new Error('Inventory item name is already in use.')
      this.db.prepare(`INSERT INTO inventory_items(id, name, unit, reorder_milli) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, reorder_milli=excluded.reorder_milli`).run(itemId, input.name, input.unit, input.reorderMilli)
      this.audit(actor, 'inventory.item_saved', itemId, input)
      return this.inventory().find(item => item.id === itemId)!
    })
  }

  moveStock(actor: StaffIdentity, raw: unknown): InventoryItem {
    const input = z.object({ requestId: z.string().uuid(), itemId: id,
      deltaMilli: z.number().int().min(-1_000_000_000).max(1_000_000_000).refine(value => value !== 0),
      reason: z.string().trim().min(3).max(250) }).parse(raw)
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT item_id, delta_milli, reason FROM stock_movements WHERE request_id = ?').get(input.requestId) as { item_id: string; delta_milli: number; reason: string } | undefined
      if (prior) {
        if (prior.item_id !== input.itemId || prior.delta_milli !== input.deltaMilli || prior.reason !== input.reason) throw new Error('This stock request was already used for a different adjustment.')
        return this.inventory().find(item => item.id === input.itemId)!
      }
      const updated = this.db.prepare(`UPDATE inventory_items SET quantity_milli = quantity_milli + ?
        WHERE id = ? AND quantity_milli + ? BETWEEN 0 AND 1000000000`).run(input.deltaMilli, input.itemId, input.deltaMilli)
      if (updated.changes !== 1) throw new Error('Item not found, insufficient stock, or stock limit exceeded.')
      const movementId = randomUUID()
      this.db.prepare('INSERT INTO stock_movements(id, request_id, item_id, delta_milli, reason, actor) VALUES(?,?,?,?,?,?)').run(movementId, input.requestId, input.itemId, input.deltaMilli, input.reason, actor.username)
      this.audit(actor, 'inventory.stock_moved', input.itemId, input)
      return this.inventory().find(item => item.id === input.itemId)!
    })
  }

  stockHistory(rawId: unknown): StockMovement[] {
    return this.db.prepare(`SELECT id, item_id AS itemId, delta_milli AS deltaMilli, reason, actor, created_at AS createdAt
      FROM stock_movements WHERE item_id = ? ORDER BY rowid DESC LIMIT 200`).all(id.parse(rawId)) as unknown as StockMovement[]
  }

  cashSummary(): CashSummary {
    const last = this.db.prepare('SELECT payment_cutoff, refund_cutoff FROM cash_closes ORDER BY rowid DESC LIMIT 1').get() as { payment_cutoff: number; refund_cutoff: number } | undefined
    const receipts = this.db.prepare("SELECT COALESCE(SUM(amount_paise),0) AS amount FROM payment_tenders WHERE rowid > ? AND method = 'cash'").get(last?.payment_cutoff ?? 0) as { amount: number }
    const refunds = this.db.prepare(`SELECT COALESCE(SUM(r.amount_paise),0) AS amount FROM payment_refunds r
      JOIN payment_tenders t ON t.id = r.tender_id WHERE r.rowid > ? AND t.method = 'cash'`).get(last?.refund_cutoff ?? 0) as { amount: number }
    return { receiptsPaise: receipts.amount - refunds.amount, lastClose: this.db.prepare(`SELECT id, opening_paise AS openingPaise,
      receipts_paise AS receiptsPaise, expected_paise AS expectedPaise, counted_paise AS countedPaise,
      variance_paise AS variancePaise, notes, actor, created_at AS createdAt FROM cash_closes ORDER BY rowid DESC LIMIT 1`).get() as unknown as CashClose | undefined ?? null }
  }

  closeCash(actor: StaffIdentity, raw: unknown): CashClose {
    const input = z.object({ requestId: z.string().uuid(), openingPaise: z.number().int().min(0).max(1_000_000_000),
      countedPaise: z.number().int().min(0).max(1_000_000_000), notes: z.string().trim().max(250) }).parse(raw)
    return this.transaction(() => {
      const prior = this.db.prepare(`SELECT id, opening_paise AS openingPaise, receipts_paise AS receiptsPaise,
        expected_paise AS expectedPaise, counted_paise AS countedPaise, variance_paise AS variancePaise, notes, actor, created_at AS createdAt
        FROM cash_closes WHERE request_id = ?`).get(input.requestId) as unknown as CashClose | undefined
      if (prior) {
        if (prior.openingPaise !== input.openingPaise || prior.countedPaise !== input.countedPaise || prior.notes !== input.notes) throw new Error('This closing request was already used with different amounts.')
        return prior
      }
      const receipts = this.cashSummary().receiptsPaise
      const cutoff = (this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM payment_tenders').get() as { value: number }).value
      const refundCutoff = (this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM payment_refunds').get() as { value: number }).value
      const expected = input.openingPaise + receipts
      if (input.countedPaise !== expected && input.notes.length < 3) throw new Error('Explain the cash variance before closing.')
      const closeId = randomUUID()
      this.db.prepare(`INSERT INTO cash_closes(id, request_id, payment_cutoff, opening_paise, receipts_paise,
        expected_paise, counted_paise, variance_paise, notes, actor, refund_cutoff) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(closeId,
        input.requestId, cutoff, input.openingPaise, receipts, expected, input.countedPaise, input.countedPaise - expected, input.notes, actor.username, refundCutoff)
      this.audit(actor, 'cash.closed', closeId, { ...input, receiptsPaise: receipts, expectedPaise: expected })
      return this.cashSummary().lastClose!
    })
  }

  catalog(): MenuCatalog {
    const categories = this.db.prepare('SELECT id, name, sort_order AS sortOrder FROM categories ORDER BY sort_order, name').all() as unknown as Category[]
    const products = this.db.prepare(`SELECT id, category_id AS categoryId, name, description,
      price_paise AS pricePaise, tax_rate_bps AS taxRateBps, available FROM products ORDER BY name`).all() as unknown as Array<Omit<Product, 'available'> & { available: number }>
    return { categories, products: products.map(product => ({ ...product, available: product.available === 1 })) }
  }

  saveCategory(actor: StaffIdentity, raw: unknown): Category {
    const input = categorySchema.parse(raw)
    return this.transaction(() => {
      const categoryId = input.id ?? randomUUID()
      if (input.id && !this.db.prepare('SELECT id FROM categories WHERE id = ?').get(input.id)) throw new Error('Category no longer exists.')
      if (this.db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id <> ?').get(input.name, categoryId)) throw new Error('A category with this name already exists.')
      this.db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order`).run(categoryId, input.name, input.sortOrder)
      this.audit(actor, 'menu.category_saved', categoryId, input)
      return { id: categoryId, name: input.name, sortOrder: input.sortOrder }
    })
  }

  saveProduct(actor: StaffIdentity, raw: unknown): Product {
    const input = productSchema.parse(raw)
    return this.transaction(() => {
      const productId = input.id ?? randomUUID()
      if (!this.db.prepare('SELECT id FROM categories WHERE id = ?').get(input.categoryId)) throw new Error('Select an existing category.')
      const previous = this.db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
      if (input.id && !previous) throw new Error('Product no longer exists.')
      if (this.db.prepare('SELECT id FROM products WHERE category_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(input.categoryId, input.name, productId)) throw new Error('A product with this name already exists in the category.')
      this.db.prepare(`INSERT INTO products (id, category_id, name, description, price_paise, tax_rate_bps, available)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET category_id = excluded.category_id,
        name = excluded.name, description = excluded.description, price_paise = excluded.price_paise,
        tax_rate_bps = excluded.tax_rate_bps, available = excluded.available`).run(productId, input.categoryId,
        input.name, input.description, input.pricePaise, input.taxRateBps, input.available ? 1 : 0)
      this.audit(actor, 'menu.product_saved', productId, { previous, current: input })
      return { ...input, id: productId }
    })
  }

  salesReport(raw: unknown): SalesReport {
    const input = reportSchema.parse(raw)
    const from = `${input.from} 00:00:00`
    const to = new Date(new Date(`${input.to}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10) + ' 00:00:00'
    const paid = this.db.prepare(`SELECT COUNT(*) AS paidBills, COALESCE(SUM(subtotal_paise),0) AS subtotalPaise,
      COALESCE(SUM(discount_paise),0) AS discountPaise, COALESCE(SUM(tax_paise),0) AS taxPaise,
      COALESCE(SUM(total_paise),0) AS totalPaise FROM orders WHERE paid_at >= ? AND paid_at < ?`).get(from, to) as unknown as Pick<SalesReport, 'paidBills' | 'subtotalPaise' | 'discountPaise' | 'taxPaise' | 'totalPaise'>
    const voided = this.db.prepare(`SELECT COUNT(*) AS voidedBills, COALESCE(SUM(total_paise),0) AS voidedPaise
      FROM orders WHERE voided_at >= ? AND voided_at < ?`).get(from, to) as unknown as Pick<SalesReport, 'voidedBills' | 'voidedPaise'>
    const unpaid = this.db.prepare(`SELECT COUNT(*) AS unpaidBills, COALESCE(SUM(total_paise
      - (SELECT COALESCE(SUM(amount_paise),0) FROM payment_tenders WHERE order_id = orders.id)
      + (SELECT COALESCE(SUM(r.amount_paise),0) FROM payment_refunds r JOIN payment_tenders t ON t.id = r.tender_id WHERE t.order_id = orders.id)),0) AS unpaidPaise FROM orders
      WHERE created_at >= ? AND created_at < ? AND paid_at IS NULL AND voided_at IS NULL`).get(from, to) as unknown as Pick<SalesReport, 'unpaidBills' | 'unpaidPaise'>
    const payments = this.db.prepare(`SELECT method, COUNT(*) AS count, SUM(amount_paise) AS amountPaise
      FROM payment_tenders WHERE created_at >= ? AND created_at < ? GROUP BY method ORDER BY method`).all(from, to) as unknown as SalesReport['payments']
    const refundedPaise = (this.db.prepare(`SELECT COALESCE(SUM(amount_paise),0) AS amount FROM payment_refunds
      WHERE created_at >= ? AND created_at < ?`).get(from, to) as { amount: number }).amount
    const collectedPaise = payments.reduce((sum, payment) => sum + payment.amountPaise, 0)
    const items = this.db.prepare(`SELECT i.product_name AS name, SUM(i.quantity) AS quantity,
      SUM(i.unit_price_paise * i.quantity) AS subtotalPaise FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.paid_at >= ? AND o.paid_at < ? GROUP BY i.product_name ORDER BY quantity DESC, name`).all(from, to) as unknown as SalesReport['items']
    return { ...input, timezone: 'UTC', ...paid, ...voided, ...unpaid, payments, items, refundedPaise, collectedPaise, netCollectionsPaise: collectedPaise - refundedPaise }
  }

  private audit(actor: StaffIdentity, action: string, entityId: string, details: unknown) {
    const entityType = action.startsWith('inventory.') ? 'inventory' : action.startsWith('cash.') ? 'cash' : 'menu'
    this.db.prepare(`INSERT INTO audit_log (id, action, entity_type, entity_id, actor, reason, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), action, entityType, entityId, actor.username, entityType + '_administration', JSON.stringify(details))
  }
}
