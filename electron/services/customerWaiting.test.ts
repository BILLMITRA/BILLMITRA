import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { CustomerWaitingService, WAITING_MS } from './customerWaiting.cjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE restaurant_tables(id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO restaurant_tables VALUES('t1','Table 1');
    CREATE TABLE orders(id TEXT PRIMARY KEY, table_id TEXT, type TEXT, status TEXT,
      voided_at TEXT, paid_at TEXT, created_at TEXT);`)
  let now = 1_000_000
  const transaction = <T>(action: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try { const value = action(); db.exec('COMMIT'); return value }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const service = new CustomerWaitingService(db, transaction, () => now)
  service.migrate()
  return { db, service, advance: (ms: number) => { now += ms }, restart: () => new CustomerWaitingService(db, transaction, () => now) }
}

it('never alerts before five full minutes and alerts once after the threshold, including after a restart', () => {
  const f = fixture()
  f.service.confirm('t1', true)
  f.advance(WAITING_MS - 1)
  expect(f.service.list().alerts).toHaveLength(0)
  f.advance(1)
  const first = f.service.list().alerts
  expect(first).toHaveLength(1)
  expect(f.restart().list().alerts).toEqual(first)
  f.db.close()
})

it('ends a seating session when the customer leaves and starts a new timer on return', () => {
  const f = fixture()
  f.service.confirm('t1', true)
  f.advance(WAITING_MS - 1)
  f.service.confirm('t1', false)
  f.service.confirm('t1', true)
  f.advance(1)
  expect(f.service.list().alerts).toHaveLength(0)
  f.advance(WAITING_MS - 1)
  expect(f.service.list().alerts).toHaveLength(1)
  f.db.close()
})

it('resolves the alert when an order is accepted and does not alert an already occupied table', () => {
  const f = fixture()
  f.service.confirm('t1', true)
  f.advance(WAITING_MS)
  expect(f.service.list().alerts).toHaveLength(1)
  f.db.prepare("INSERT INTO orders VALUES('o1','t1','dine_in','ordering',NULL,NULL,datetime('now'))").run()
  f.service.orderPlaced('t1')
  expect(f.service.list().alerts).toHaveLength(0)
  f.service.confirm('t1', true)
  f.advance(WAITING_MS)
  expect(f.service.list().alerts).toHaveLength(0)
  f.db.close()
})

it('acknowledges the same alert for all waiter phones', () => {
  const f = fixture()
  f.service.confirm('t1', true)
  f.advance(WAITING_MS)
  const id = f.service.list().alerts[0].id
  f.service.acknowledge(id)
  expect(f.restart().list().alerts[0].acknowledgedAt).not.toBeNull()
  f.db.close()
})

it('notifies listeners once after the five-minute alert is saved', () => {
  const f = fixture()
  const received: string[] = []
  const stop = f.service.onAlertCreated(alert => received.push(`${alert.tableName}:${alert.id}`))
  f.service.confirm('t1', true)
  f.advance(WAITING_MS)
  const alert = f.service.list().alerts[0]
  expect(received).toEqual([`Table 1:${alert.id}`])
  f.service.list()
  expect(received).toHaveLength(1)
  stop()
  f.db.close()
})
