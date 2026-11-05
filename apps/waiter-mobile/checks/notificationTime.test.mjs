import assert from 'node:assert/strict'
import test from 'node:test'
import { isFreshNotification, notificationTime } from '../src/notificationTime.ts'

test('SQLite UTC timestamps trigger only new staff notifications regardless of phone timezone', () => {
  const now = Date.parse('2026-11-01T07:00:30Z')
  assert.equal(notificationTime('2026-11-01 07:00:00'), Date.parse('2026-11-01T07:00:00Z'))
  assert.equal(isFreshNotification('2026-11-01 07:00:00', now), true)
  assert.equal(isFreshNotification('2026-11-01 06:59:29', now), false)
  assert.equal(isFreshNotification('2026-11-01T07:00:00Z', now), true)
})
