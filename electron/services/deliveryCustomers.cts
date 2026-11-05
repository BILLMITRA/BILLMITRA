import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DeliveryCustomerRecord, SavedDeliveryCustomerDetails, SaveDeliveryCustomerInput } from '../../shared/domain.js'

const contactNumberSchema = z.string().trim().min(1).max(30)
const customerInputSchema = z.object({
  id: z.string().uuid().optional(),
  customerName: z.string().trim().max(120),
  contactNumber: contactNumberSchema,
  deliveryAddress: z.string().trim().max(1000),
  deliveryArea: z.string().trim().max(120),
  deliveryLandmark: z.string().trim().max(160),
  deliveryInstructions: z.string().trim().max(300),
})

const customerSelect = `
  SELECT p.id, p.display_name AS customerName, p.normalized_phone AS contactNumber,
    COALESCE(a.address, '') AS deliveryAddress, COALESCE(a.area, '') AS deliveryArea,
    COALESCE(a.landmark, '') AS deliveryLandmark,
    COALESCE(a.instructions, '') AS deliveryInstructions,
    p.last_order_at AS lastOrderAt,
    (SELECT o.display_number FROM customer_order_links l JOIN orders o ON o.id = l.order_id
      WHERE l.customer_id = p.id ORDER BY o.created_at DESC, o.display_number DESC LIMIT 1) AS lastOrderNumber
  FROM customer_profiles p
  LEFT JOIN customer_addresses a ON a.id = (
    SELECT id FROM customer_addresses WHERE customer_id = p.id
    ORDER BY is_default DESC, updated_at DESC, created_at DESC LIMIT 1
  )
`

export function listSavedDeliveryCustomers(database: DatabaseSync, rawQuery: unknown): DeliveryCustomerRecord[] {
  const query = z.string().trim().max(120).parse(rawQuery)
  const digits = query.replace(/\D/g, '')
  return database.prepare(`${customerSelect}
    WHERE ? = '' OR (? <> '' AND instr(p.normalized_phone, ?) > 0)
      OR instr(lower(p.display_name), lower(?)) > 0
      OR instr(lower(COALESCE(a.area, '') || ' ' || COALESCE(a.address, '')), lower(?)) > 0
    ORDER BY CASE WHEN p.normalized_phone = ? THEN 0 ELSE 1 END,
      p.last_order_at DESC, p.updated_at DESC, p.display_name COLLATE NOCASE
    LIMIT 50
  `).all(query, digits, digits, query, query, digits) as unknown as DeliveryCustomerRecord[]
}

export function saveSavedDeliveryCustomer(database: DatabaseSync, rawInput: unknown): DeliveryCustomerRecord {
  const input = customerInputSchema.parse(rawInput) as SaveDeliveryCustomerInput
  const phone = input.contactNumber.replace(/\D/g, '')
  if (phone.length < 1 || phone.length > 30) throw new Error('Enter a contact number or customer code with up to 30 digits.')
  const existing = input.id
    ? database.prepare('SELECT id FROM customer_profiles WHERE id = ?').get(input.id) as { id: string } | undefined
    : undefined
  if (input.id && !existing) throw new Error('This saved customer no longer exists. Search again.')
  const other = database.prepare('SELECT id FROM customer_profiles WHERE normalized_phone = ?').get(phone) as { id: string } | undefined
  if (other && other.id !== input.id) throw new Error('This contact number belongs to another saved customer. Select that customer instead.')
  const id = input.id ?? randomUUID()
  if (existing) {
    database.prepare(`UPDATE customer_profiles SET normalized_phone = ?, display_name = ?,
      updated_at = datetime('now') WHERE id = ?`).run(phone, input.customerName, id)
  } else {
    database.prepare(`INSERT INTO customer_profiles(id, normalized_phone, display_name)
      VALUES(?, ?, ?)`).run(id, phone, input.customerName)
  }
  if (!input.deliveryAddress) return database.prepare(`${customerSelect} WHERE p.id = ?`).get(id) as unknown as DeliveryCustomerRecord
  database.prepare('UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?').run(id)
  const address = database.prepare(`SELECT id FROM customer_addresses
    WHERE customer_id = ? AND address = ? AND area = ? AND landmark = ? LIMIT 1`)
    .get(id, input.deliveryAddress, input.deliveryArea, input.deliveryLandmark) as { id: string } | undefined
  if (address) {
    database.prepare(`UPDATE customer_addresses SET instructions = ?, is_default = 1,
      updated_at = datetime('now') WHERE id = ?`).run(input.deliveryInstructions, address.id)
  } else {
    database.prepare(`INSERT INTO customer_addresses
      (id, customer_id, address, area, landmark, instructions, is_default)
      VALUES(?, ?, ?, ?, ?, ?, 1)`)
      .run(randomUUID(), id, input.deliveryAddress, input.deliveryArea, input.deliveryLandmark,
        input.deliveryInstructions)
  }
  return database.prepare(`${customerSelect} WHERE p.id = ?`).get(id) as unknown as DeliveryCustomerRecord
}

export function findSavedDeliveryCustomer(
  database: DatabaseSync,
  rawContactNumber: unknown,
): SavedDeliveryCustomerDetails | null {
  const normalizedNumber = contactNumberSchema.parse(rawContactNumber).replace(/\D/g, '')
  if (!normalizedNumber) throw new Error('Enter a valid customer contact number.')
  const saved = database.prepare(`
    SELECT customer_name AS customerName, contact_number AS contactNumber,
      delivery_address AS deliveryAddress, delivery_area AS deliveryArea,
      delivery_landmark AS deliveryLandmark, delivery_instructions AS deliveryInstructions
    FROM orders
    WHERE type = 'delivery'
      AND replace(replace(replace(replace(replace(replace(replace(replace(
        contact_number, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), '/', ''), char(9), '') = ?
      AND (delivery_address != '' OR customer_name != '' OR delivery_area != ''
        OR delivery_landmark != '' OR delivery_instructions != '')
    ORDER BY created_at DESC, display_number DESC
    LIMIT 1
  `).get(normalizedNumber) as SavedDeliveryCustomerDetails | undefined
  return saved ?? null
}
