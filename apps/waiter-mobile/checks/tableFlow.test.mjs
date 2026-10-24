import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TABLE_HOLD_MS, tableChanged, tableOrder } from '../src/tableFlow.ts'

test('two-second hold is used for table actions', () => assert.equal(TABLE_HOLD_MS, 2000))
test('current order follows the live table order ID and excludes saved bills from earlier guests', () => {
  const saved = { id: 'previous', tableId: 't1', savedAt: '2026-10-24 10:00:00' }
  const current = { id: 'current', tableId: 't1', savedAt: null }
  const menu = { tables: [{ id: 't1', orderId: 'current' }], activeOrders: [saved, current] }
  assert.equal(tableOrder(menu, 't1'), current)
  assert.equal(tableChanged(menu, 't1', 'previous'), true)
  assert.equal(tableChanged(menu, 't1', 'current'), false)
})
test('closed and reused tables cannot silently receive the previous order draft', () => {
  const menu = { tables: [{ id: 't1', orderId: null }], activeOrders: [] }
  assert.equal(tableChanged(menu, 't1', 'previous'), true)
  assert.equal(tableChanged(menu, 't1', null), false)
  menu.tables[0].orderId = 'next-guests'
  assert.equal(tableChanged(menu, 't1', null), true)
  assert.equal(tableChanged(null, 't1', null), true)
})
