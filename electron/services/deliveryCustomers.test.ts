import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { findSavedDeliveryCustomer, listSavedDeliveryCustomers, saveSavedDeliveryCustomer } from './deliveryCustomers.cjs'

let database: DatabaseSync

beforeEach(() => {
  database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      display_number INTEGER NOT NULL,
      customer_name TEXT NOT NULL DEFAULT '',
      contact_number TEXT NOT NULL DEFAULT '',
      delivery_address TEXT NOT NULL DEFAULT '',
      delivery_area TEXT NOT NULL DEFAULT '',
      delivery_landmark TEXT NOT NULL DEFAULT '',
      delivery_instructions TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE customer_profiles (
      id TEXT PRIMARY KEY, normalized_phone TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_order_at TEXT
    );
    CREATE TABLE customer_addresses (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, address TEXT NOT NULL, area TEXT NOT NULL DEFAULT '',
      landmark TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '', is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE customer_order_links (order_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL);
  `)
})

describe('delivery customer directory', () => {
  const shan = { customerName: 'Shan', contactNumber: '9656684727', deliveryAddress: 'Vengara market',
    deliveryArea: 'Vengara', deliveryLandmark: 'Near bus stand', deliveryInstructions: 'Call on arrival' }

  it('saves a new customer and finds it by name, full phone, and last three digits', () => {
    const saved = saveSavedDeliveryCustomer(database, shan)
    expect(saved).toMatchObject({ customerName: 'Shan', contactNumber: '9656684727', deliveryAddress: 'Vengara market' })
    expect(listSavedDeliveryCustomers(database, 'shan')[0].id).toBe(saved.id)
    expect(listSavedDeliveryCustomers(database, '9656684727')[0].id).toBe(saved.id)
    expect(listSavedDeliveryCustomers(database, '727')[0].id).toBe(saved.id)
    expect(listSavedDeliveryCustomers(database, 'Vengara')[0].id).toBe(saved.id)
  })

  it('edits a customer and keeps the previous address in history', () => {
    const first = saveSavedDeliveryCustomer(database, shan)
    const updated = saveSavedDeliveryCustomer(database, { ...shan, id: first.id, customerName: 'Shan V',
      contactNumber: '96566 84728', deliveryAddress: 'Vengara road', deliveryInstructions: 'After 6 PM' })
    expect(updated).toMatchObject({ id: first.id, customerName: 'Shan V', contactNumber: '9656684728',
      deliveryAddress: 'Vengara road', deliveryInstructions: 'After 6 PM' })
    expect(listSavedDeliveryCustomers(database, '727')).toEqual([])
    expect(database.prepare('SELECT count(*) AS count FROM customer_addresses WHERE customer_id = ?')
      .get(first.id)).toMatchObject({ count: 2 })
  })

  it('does not create a second customer with an existing phone', () => {
    saveSavedDeliveryCustomer(database, shan)
    expect(() => saveSavedDeliveryCustomer(database, { ...shan, customerName: 'Other' })).toThrow('belongs to another saved customer')
    expect(listSavedDeliveryCustomers(database, '')).toHaveLength(1)
  })

  it('saves a parcel customer with a three-digit code and no address', () => {
    const saved = saveSavedDeliveryCustomer(database, { customerName: '', contactNumber: '928',
      deliveryAddress: '', deliveryArea: '', deliveryLandmark: '', deliveryInstructions: '' })
    expect(saved).toMatchObject({ contactNumber: '928', deliveryAddress: '' })
    expect(listSavedDeliveryCustomers(database, '928')[0].id).toBe(saved.id)
    expect(database.prepare('SELECT count(*) AS count FROM customer_addresses').get()).toMatchObject({ count: 0 })
  })
})

afterEach(() => database.close())

describe('saved delivery customer lookup', () => {
  it('restores details by phone number independent of common formatting', () => {
    database.prepare(`
      INSERT INTO orders (
        id, type, created_at, display_number, customer_name, contact_number,
        delivery_address, delivery_area, delivery_landmark, delivery_instructions
      ) VALUES (?, 'delivery', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('order-1', '2026-10-14 10:00:00', 1, 'Maya Rao', '+91 98765-43210',
      '18 Market Road', 'Central', 'Clock Tower', 'Call on arrival')

    expect(findSavedDeliveryCustomer(database, '+91-9876543210')).toEqual({
      customerName: 'Maya Rao',
      contactNumber: '+91 98765-43210',
      deliveryAddress: '18 Market Road',
      deliveryArea: 'Central',
      deliveryLandmark: 'Clock Tower',
      deliveryInstructions: 'Call on arrival',
    })
  })

  it('returns the latest saved delivery details and ignores non-delivery orders', () => {
    const insert = database.prepare(`
      INSERT INTO orders (id, type, created_at, display_number, customer_name, contact_number, delivery_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run('old', 'delivery', '2026-10-13 10:00:00', 1, 'Old Name', '5551234567', 'Old address')
    insert.run('parcel', 'parcel', '2026-10-15 10:00:00', 2, 'Parcel Name', '5551234567', 'Parcel address')
    insert.run('latest', 'delivery', '2026-10-14 10:00:00', 3, 'Latest Name', '555-123-4567', 'Latest address')

    expect(findSavedDeliveryCustomer(database, '(555) 123-4567')).toMatchObject({
      customerName: 'Latest Name',
      deliveryAddress: 'Latest address',
    })
  })

  it('returns null when the number has no saved delivery details and rejects invalid input', () => {
    expect(findSavedDeliveryCustomer(database, '9999999999')).toBeNull()
    expect(() => findSavedDeliveryCustomer(database, '---')).toThrow('Enter a valid customer contact number.')
    expect(() => findSavedDeliveryCustomer(database, null)).toThrow()
  })
})
