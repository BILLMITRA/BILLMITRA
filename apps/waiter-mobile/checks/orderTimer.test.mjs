import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderTimer } from '../src/orderTimer.ts'
const start = Date.parse('2026-10-23T12:00:00Z')
test('SQLite timestamps use UTC and cross to overdue at exactly one hour', () => {
  assert.deepEqual(orderTimer('2026-10-23 12:00:00', start), { label: '00:00:00', overdue: false })
  assert.deepEqual(orderTimer('2026-10-23 12:00:00', start + 3599999), { label: '00:59:59', overdue: false })
  assert.deepEqual(orderTimer('2026-10-23 12:00:00', start + 3600000), { label: '01:00:00', overdue: true })
})
test('reopening a screen retains elapsed time and handles timezone offsets', () => {
  assert.deepEqual(orderTimer('2026-10-23T17:30:00+05:30', start + 7322000), { label: '02:02:02', overdue: true })
})
test('missing timestamps and clock skew do not show NaN or negative times', () => {
  assert.equal(orderTimer(undefined, start).label, 'Time unavailable')
  assert.equal(orderTimer('bad-date', start).label, 'Time unavailable')
  assert.deepEqual(orderTimer('2026-10-23 12:00:00', start - 10000), { label: '00:00:00', overdue: false })
})
