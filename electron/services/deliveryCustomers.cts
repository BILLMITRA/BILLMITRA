import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { SavedDeliveryCustomerDetails } from '../../shared/domain.js'

const contactNumberSchema = z.string().trim().min(1).max(30)

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
