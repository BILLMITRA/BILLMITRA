import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kitchenCounts, visibleKitchenOrders, visibleKitchenProducts } from '../src/kitchenView.ts'

const ticket = (orderNumber, status, createdAt, tableName, productName) => ({
  id: String(orderNumber), ticketId: `ticket-${orderNumber}`, orderNumber, status, createdAt,
  tableName, type: 'dine_in', items: [{ id: `item-${orderNumber}`, productName, note: '', quantity: 1 }],
})
const orders = [
  ticket(42, 'preparing', '2026-10-30T08:10:00Z', 'Table 12', 'Mango Lassi'),
  ticket(41, 'ordering', '2026-10-30T08:00:00Z', 'Table 11', 'Chicken Tikka'),
  ticket(43, 'ready', '2026-10-30T08:20:00Z', 'Table 13', 'Cold Coffee'),
]

test('kitchen counts and filters keep oldest matching KOT first', () => {
  assert.deepEqual(kitchenCounts(orders), { all: 3, ordering: 1, preparing: 1, ready: 1 })
  assert.deepEqual(visibleKitchenOrders(orders, 'all', '').map(order => order.orderNumber), [41, 42, 43])
  assert.deepEqual(visibleKitchenOrders(orders, 'preparing', 'lassi').map(order => order.orderNumber), [42])
  assert.deepEqual(visibleKitchenOrders(orders, 'all', 'table 13').map(order => order.orderNumber), [43])
  assert.deepEqual(visibleKitchenOrders(orders, 'all', '41').map(order => order.orderNumber), [41])
})

test('stock search can show only unavailable products', () => {
  const products = [{ id: 'b', name: 'Mango Lassi', available: true }, { id: 'a', name: 'Cold Coffee', available: false }]
  assert.deepEqual(visibleKitchenProducts(products, '', true).map(item => item.id), ['a'])
  assert.deepEqual(visibleKitchenProducts(products, 'mango', false).map(item => item.id), ['b'])
})
