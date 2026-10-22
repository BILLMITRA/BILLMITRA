import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { deliverySchemaMigration } from './deliverySchema.cjs'

let database: DatabaseSync | null = null

afterEach(() => {
  database?.close()
  database = null
})

describe('delivery schema migration', () => {
  it('adds delivery tracking without discarding existing orders, schedules, or legacy assignments', () => {
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    database.exec(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_number INTEGER,
        created_at TEXT NOT NULL,
        scheduled_delivery_at TEXT,
        assigned_delivery_to TEXT NOT NULL DEFAULT '',
        customer_name TEXT NOT NULL DEFAULT '',
        contact_number TEXT NOT NULL DEFAULT '',
        delivery_address TEXT NOT NULL DEFAULT '',
        total_paise INTEGER NOT NULL DEFAULT 0,
        paid_at TEXT,
        voided_at TEXT
      );
      INSERT INTO orders (id, type, status, delivery_number, created_at,
        scheduled_delivery_at, assigned_delivery_to, customer_name, total_paise)
      VALUES ('legacy-order', 'delivery', 'ready', 8, '2026-10-14 10:00:00',
        '2026-10-14T12:00:00.000Z', 'Legacy courier name', 'Existing customer', 23500);
      CREATE TABLE order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id)
      );
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        details_json TEXT NOT NULL
      );
    `)

    database.exec(deliverySchemaMigration)

    expect(database.prepare(`
      SELECT id, scheduled_delivery_at AS promisedAt, assigned_delivery_to AS legacyAssignee,
        delivery_status AS deliveryStatus, delivery_rider_id AS riderId, total_paise AS totalPaise
      FROM orders WHERE id = 'legacy-order'
    `).get()).toEqual({
      id: 'legacy-order',
      promisedAt: '2026-10-14T12:00:00.000Z',
      legacyAssignee: 'Legacy courier name',
      deliveryStatus: 'pending',
      riderId: null,
      totalPaise: 23500,
    })
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delivery_events'").get())
      .toEqual({ name: 'delivery_events' })
  })
})
