import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/**
 * Version 24 adds customer, invoice-snapshot and lifecycle tables to the
 * existing offline database. Issuing invoice documents is a separate workflow.
 */
export function migrateProfessionalBillingSchema(
  database: DatabaseSync,
  transaction: <T>(action: () => T) => T,
): void {
  transaction(() => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version = 24').get()) return

    database.exec(`
      CREATE TABLE IF NOT EXISTS business_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        legal_name TEXT NOT NULL DEFAULT 'BillMitra Restaurant',
        trading_name TEXT NOT NULL DEFAULT 'BillMitra Restaurant',
        gstin TEXT NOT NULL DEFAULT '',
        fssai_number TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        invoice_prefix TEXT NOT NULL DEFAULT 'INV',
        currency_code TEXT NOT NULL DEFAULT 'INR',
        timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO business_profile(id) VALUES(1);

      CREATE TABLE IF NOT EXISTS customer_profiles (
        id TEXT PRIMARY KEY,
        normalized_phone TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_order_at TEXT
      );
      CREATE INDEX IF NOT EXISTS customer_profiles_name ON customer_profiles(display_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS customer_profiles_recent ON customer_profiles(last_order_at DESC);

      CREATE TABLE IF NOT EXISTS customer_addresses (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customer_profiles(id) ON DELETE CASCADE,
        label TEXT NOT NULL DEFAULT 'Saved address',
        address TEXT NOT NULL,
        area TEXT NOT NULL DEFAULT '',
        landmark TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS customer_addresses_customer ON customer_addresses(customer_id, is_default DESC, updated_at DESC);

      CREATE TABLE IF NOT EXISTS customer_order_links (
        order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
        customer_id TEXT NOT NULL REFERENCES customer_profiles(id) ON DELETE RESTRICT,
        linked_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS customer_order_links_customer ON customer_order_links(customer_id, linked_at DESC);

      CREATE TABLE IF NOT EXISTS document_sequences (
        document_kind TEXT PRIMARY KEY CHECK(document_kind IN ('tax_invoice', 'credit_note')),
        financial_year TEXT NOT NULL,
        next_number INTEGER NOT NULL CHECK(next_number > 0),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO document_sequences(document_kind, financial_year, next_number)
        VALUES ('tax_invoice', '1970-71', 1), ('credit_note', '1970-71', 1);

      CREATE TABLE IF NOT EXISTS sales_documents (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
        document_type TEXT NOT NULL CHECK(document_type IN ('tax_invoice', 'credit_note')),
        document_number TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL DEFAULT (datetime('now')),
        issued_by TEXT NOT NULL,
        business_snapshot_json TEXT NOT NULL,
        customer_snapshot_json TEXT NOT NULL,
        totals_snapshot_json TEXT NOT NULL,
        items_snapshot_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sales_documents_issued ON sales_documents(issued_at DESC);
      CREATE INDEX IF NOT EXISTS sales_documents_order ON sales_documents(order_id);

      CREATE TABLE IF NOT EXISTS order_lifecycle_events (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        source TEXT NOT NULL,
        details_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS order_lifecycle_events_order ON order_lifecycle_events(order_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS order_lifecycle_events_type ON order_lifecycle_events(event_type, occurred_at DESC);

      CREATE INDEX IF NOT EXISTS orders_customer_phone_open ON orders(contact_number, created_at DESC)
        WHERE contact_number <> '' AND paid_at IS NULL AND voided_at IS NULL;
      CREATE INDEX IF NOT EXISTS orders_customer_name_open ON orders(customer_name COLLATE NOCASE, created_at DESC)
        WHERE customer_name <> '' AND paid_at IS NULL AND voided_at IS NULL;
    `)

    const normalizePhone = (value: string) => value.replace(/\D/g, '')
    const rows = database.prepare(`
      SELECT id, customer_name AS customerName, contact_number AS contactNumber,
        delivery_address AS deliveryAddress, delivery_area AS deliveryArea,
        delivery_landmark AS deliveryLandmark, delivery_instructions AS deliveryInstructions,
        created_at AS createdAt
      FROM orders
      WHERE contact_number <> ''
      ORDER BY created_at ASC, display_number ASC
    `).all() as Array<{
      id: string; customerName: string; contactNumber: string; deliveryAddress: string
      deliveryArea: string; deliveryLandmark: string; deliveryInstructions: string; createdAt: string
    }>
    const findCustomer = database.prepare('SELECT id FROM customer_profiles WHERE normalized_phone = ?')
    const insertCustomer = database.prepare(`
      INSERT INTO customer_profiles(id, normalized_phone, display_name, last_order_at)
      VALUES(?, ?, ?, ?)
    `)
    const updateCustomer = database.prepare(`
      UPDATE customer_profiles SET display_name = CASE WHEN ? <> '' THEN ? ELSE display_name END,
        last_order_at = CASE WHEN last_order_at IS NULL OR last_order_at < ? THEN ? ELSE last_order_at END,
        updated_at = datetime('now') WHERE id = ?
    `)
    const linkCustomer = database.prepare(`
      INSERT OR IGNORE INTO customer_order_links(order_id, customer_id) VALUES(?, ?)
    `)
    const findAddress = database.prepare(`
      SELECT id FROM customer_addresses
      WHERE customer_id = ? AND address = ? AND area = ? AND landmark = ? LIMIT 1
    `)
    const insertAddress = database.prepare(`
      INSERT INTO customer_addresses(id, customer_id, address, area, landmark, instructions, is_default)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `)
    for (const row of rows) {
      const phone = normalizePhone(row.contactNumber)
      if (!phone) continue
      let customer = findCustomer.get(phone) as { id: string } | undefined
      if (!customer) {
        const id = randomUUID()
        insertCustomer.run(id, phone, row.customerName.trim(), row.createdAt)
        customer = { id }
      } else {
        updateCustomer.run(row.customerName.trim(), row.customerName.trim(), row.createdAt, row.createdAt, customer.id)
      }
      linkCustomer.run(row.id, customer.id)
      if (row.deliveryAddress.trim() && !findAddress.get(customer.id, row.deliveryAddress, row.deliveryArea, row.deliveryLandmark)) {
        insertAddress.run(randomUUID(), customer.id, row.deliveryAddress, row.deliveryArea, row.deliveryLandmark,
          row.deliveryInstructions, 0)
      }
    }
    database.prepare('INSERT INTO schema_migrations(version) VALUES(24)').run()
  })
}

export type CustomerProfileInput = {
  orderId: string
  customerName: string
  contactNumber: string
  deliveryAddress?: string
  deliveryArea?: string
  deliveryLandmark?: string
  deliveryInstructions?: string
}

/** Keeps a directory record without changing the original customer details on an order. */
export function upsertCustomerProfile(database: DatabaseSync, input: CustomerProfileInput): void {
  const normalizedPhone = input.contactNumber.replace(/\D/g, '')
  if (!normalizedPhone) return
  const current = database.prepare('SELECT id FROM customer_profiles WHERE normalized_phone = ?').get(normalizedPhone) as { id: string } | undefined
  const customerId = current?.id ?? randomUUID()
  if (!current) {
    database.prepare(`INSERT INTO customer_profiles(id, normalized_phone, display_name, last_order_at)
      VALUES(?, ?, ?, datetime('now'))`).run(customerId, normalizedPhone, input.customerName.trim())
  } else {
    database.prepare(`UPDATE customer_profiles
      SET display_name = CASE WHEN ? <> '' THEN ? ELSE display_name END,
        last_order_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(input.customerName.trim(), input.customerName.trim(), customerId)
  }
  database.prepare(`INSERT INTO customer_order_links(order_id, customer_id) VALUES(?, ?)
    ON CONFLICT(order_id) DO UPDATE SET customer_id = excluded.customer_id, linked_at = datetime('now')`)
    .run(input.orderId, customerId)

  const address = input.deliveryAddress?.trim() ?? ''
  if (!address) return
  const area = input.deliveryArea?.trim() ?? ''
  const landmark = input.deliveryLandmark?.trim() ?? ''
  const instructions = input.deliveryInstructions?.trim() ?? ''
  const existingAddress = database.prepare(`SELECT id FROM customer_addresses
    WHERE customer_id = ? AND address = ? AND area = ? AND landmark = ? LIMIT 1`)
    .get(customerId, address, area, landmark)
  if (!existingAddress) {
    database.prepare(`INSERT INTO customer_addresses(id, customer_id, address, area, landmark, instructions, is_default)
      VALUES(?, ?, ?, ?, ?, ?, 0)`).run(randomUUID(), customerId, address, area, landmark, instructions)
  }
}

export function recordOrderLifecycleEvent(
  database: DatabaseSync,
  orderId: string,
  eventType: string,
  actor: string,
  source: string,
  details: unknown,
): void {
  database.prepare(`INSERT INTO order_lifecycle_events(id, order_id, event_type, actor, source, details_json)
    VALUES(?, ?, ?, ?, ?, ?)`).run(randomUUID(), orderId, eventType, actor, source, JSON.stringify(details))
}


