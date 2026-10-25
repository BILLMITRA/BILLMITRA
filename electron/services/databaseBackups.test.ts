import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPosBackend } from '../backend.cjs'
import { restoreDatabase } from './databaseBackups.cjs'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { BackupInfo, MenuCatalog } from '../../shared/restaurant'
let directory: string
let backend: ReturnType<typeof createPosBackend> | undefined
let path: string
const owner = { username: 'owner', displayName: 'Owner', password: 'backup-owner-password-123' }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'billmitra-backup-test-')); path = join(directory, 'test.sqlite'); backend = createPosBackend(path); backend.invoke('staff:setup-owner', 1, owner) })
afterEach(() => { backend?.close(); rmSync(directory, { recursive: true, force: true }) })
it('backs up committed WAL data and restores it while retaining the previous database', () => {
  const original = backend!.invoke('menu:catalog', 1) as MenuCatalog
  const backup = backend!.invoke('backups:create', 1) as BackupInfo
  expect(backup.sizeBytes).toBeGreaterThan(0)
  backend!.invoke('menu:save-category', 1, { name: 'After backup', sortOrder: 20 })
  expect(() => restoreDatabase(path, join(directory, 'backups', backup.name))).toThrow('already open')
  backend!.close(); backend = undefined
  const restored = restoreDatabase(path, join(directory, 'backups', backup.name))
  expect(restored.previousDatabase && existsSync(restored.previousDatabase)).toBe(true)
  backend = createPosBackend(path)
  backend.invoke('staff:login', 1, owner)
  expect((backend.invoke('menu:catalog', 1) as MenuCatalog).categories).toEqual(original.categories)
  expect((backend.invoke('backups:list', 1) as BackupInfo[]).length).toBeGreaterThanOrEqual(2)
})
it('rejects invalid backups without changing the current database', () => {
  const invalid = join(directory, 'invalid.sqlite'); writeFileSync(invalid, 'not a database')
  expect(() => restoreDatabase(path, invalid)).toThrow()
  expect((backend!.invoke('menu:catalog', 1) as MenuCatalog).categories.length).toBeGreaterThan(0)
})
it('prevents simultaneous access to the same database by another backend', () => {
  expect(() => createPosBackend(path)).toThrow('already open')
})
it('does not resend historical paid orders to the kitchen when upgrading an older database', () => {
  const catalog = backend!.invoke('menu:catalog', 1) as MenuCatalog
  const makeOrder = (slot: number) => backend!.invoke('pos:create-order', 1, {
    requestId: randomUUID(), type: 'parcel', tableId: null, parcelNumber: slot,
    customerName: 'Guest', deliveryAddress: '', discount: null,
    items: [{ productId: catalog.products.find(product => product.available)!.id, quantity: 1, note: '' }],
  }) as { id: string }
  const paid = makeOrder(1); const unpaid = makeOrder(2)
  backend!.invoke('pos:record-payment', 1, { requestId: randomUUID(), orderId: paid.id, method: 'cash' })
  backend!.close(); backend = undefined
  const db = new DatabaseSync(path)
  db.exec(`DROP TABLE order_item_voids;
    DROP TABLE delivery_run_settlement_items; DROP TABLE delivery_run_settlements;
    DROP TABLE delivery_float_issues; DROP TABLE delivery_cash_movements;
    ALTER TABLE cash_closes DROP COLUMN movement_cutoff;
    DROP INDEX one_active_delivery_slot;
    ALTER TABLE orders DROP COLUMN delivery_settled_at;
    CREATE UNIQUE INDEX one_active_delivery_slot ON orders(delivery_number)
      WHERE type='delivery' AND delivery_number IS NOT NULL AND paid_at IS NULL AND voided_at IS NULL;
    DROP TABLE delivery_cash_handover_items; DROP TABLE delivery_cash_handovers;
    DROP TABLE print_jobs; DROP TABLE kitchen_tickets;
    DROP INDEX IF EXISTS open_orders_by_table;
    DROP INDEX IF EXISTS one_open_order_per_table;
    ALTER TABLE orders DROP COLUMN saved_at; ALTER TABLE orders DROP COLUMN saved_by;
    ALTER TABLE orders DROP COLUMN saved_table_name; ALTER TABLE orders DROP COLUMN saved_table_floor;
    CREATE UNIQUE INDEX one_open_order_per_table ON orders(table_id) WHERE table_id IS NOT NULL AND paid_at IS NULL AND voided_at IS NULL;
    DELETE FROM schema_migrations WHERE version >= 15;`); db.close()
  backend = createPosBackend(path); backend.invoke('staff:login', 1, owner)
  const queue = backend.invoke('kitchen:queue', 1) as { orders: { id: string }[] }
  expect(queue.orders.map(order => order.id)).toEqual([unpaid.id])
})
