import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrateProfessionalBillingSchema, upsertCustomerProfile } from './professionalBillingSchema.cjs'

describe('professional billing database upgrade', () => {
  it('preserves old orders, links customers by phone, and can safely resume an interrupted migration', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE orders(
        id TEXT PRIMARY KEY, display_number INTEGER, customer_name TEXT, contact_number TEXT,
        delivery_address TEXT, delivery_area TEXT, delivery_landmark TEXT, delivery_instructions TEXT,
        created_at TEXT, paid_at TEXT, voided_at TEXT
      );
      INSERT INTO orders VALUES
        ('order-1',1,'Shan','9656684727','Vengara','Vengara','','','2026-10-25 09:00:00',NULL,NULL),
        ('order-2',2,'Shan','9656684727','Vengara','Vengara','','','2026-10-25 10:00:00',NULL,NULL);`)
    const transaction = <T>(action: () => T): T => {
      db.exec('BEGIN IMMEDIATE')
      try { const result = action(); db.exec('COMMIT'); return result }
      catch (error) { db.exec('ROLLBACK'); throw error }
    }
    try {
      migrateProfessionalBillingSchema(db, transaction)
      expect(db.prepare('SELECT COUNT(*) AS count FROM customer_profiles').get()).toMatchObject({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM customer_order_links').get()).toMatchObject({ count: 2 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM customer_addresses').get()).toMatchObject({ count: 1 })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)

      db.prepare('DELETE FROM schema_migrations WHERE version = 24').run()
      migrateProfessionalBillingSchema(db, transaction)
      expect(db.prepare('SELECT COUNT(*) AS count FROM customer_profiles').get()).toMatchObject({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM customer_order_links').get()).toMatchObject({ count: 2 })

      db.prepare(`INSERT INTO orders VALUES
        ('order-3',3,'Updated Shan','96566 84727','','','','','2026-10-25 11:00:00',NULL,NULL)`).run()
      upsertCustomerProfile(db, { orderId: 'order-3', customerName: 'Updated Shan', contactNumber: '96566 84727' })
      expect(db.prepare('SELECT display_name AS name FROM customer_profiles').get()).toMatchObject({ name: 'Updated Shan' })
      expect(db.prepare('SELECT COUNT(*) AS count FROM customer_order_links').get()).toMatchObject({ count: 3 })
    } finally { db.close() }
  })
})
