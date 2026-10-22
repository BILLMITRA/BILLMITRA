import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { findSavedDeliveryCustomer } from './deliveryCustomers.cjs'

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
  `)
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
