import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createPosBackend } from '../backend.cjs'
import { FinancialManagementService } from './financialManagement.cjs'
import type { Category, Product, SavedOrder, PaymentRecord } from '../../shared/domain'
import type { CashClose, CashSummary, InventoryItem, MenuCatalog, PaymentLedger, SalesReport, StockMovement, KitchenQueue } from '../../shared/restaurant'

let backend: ReturnType<typeof createPosBackend>
const password = 'restaurant-test-password-123'
const owner = { username: 'owner', displayName: 'Owner', password }
const period = () => ({ from: new Date().toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) })
const invoke = <T>(channel: string, input?: unknown, session = 1): T => backend.invoke(channel, session, input) as T
function createBill(slot = 1) {
  const catalog = invoke<MenuCatalog>('menu:catalog')
  const product = catalog.products.find(item => item.available)!
  const input = { requestId: randomUUID(), type: 'parcel', parcelNumber: slot, tableId: null,
    customerName: 'Guest', deliveryAddress: '', discount: null, items: [{ productId: product.id, quantity: 1, note: 'No onion' }] }
  return { input, saved: invoke<SavedOrder>('pos:create-order', input), product }
}
beforeEach(() => { backend = createPosBackend(':memory:'); invoke('staff:setup-owner', owner) })
afterEach(() => backend.close())

describe('restaurant operations', () => {
  it('saves categories and products while preserving historical invoice snapshots', () => {
    const { saved, product } = createBill()
    const category = invoke<Category>('menu:save-category', { name: 'Chef specials', sortOrder: 10 })
    const updated = invoke<Product>('menu:save-product', { ...product, categoryId: category.id, name: 'Updated dish', pricePaise: product.pricePaise + 1000, available: false })
    expect(updated.available).toBe(false)
    const original = invoke<SavedOrder>('pos:get-order', saved.id)
    expect(original.items[0]).toMatchObject({ productName: product.name, unitPricePaise: product.pricePaise })
    expect(() => invoke('menu:save-product', { ...updated, pricePaise: -1 })).toThrow()
    expect(() => invoke('menu:save-product', { ...updated, categoryId: 'unknown' })).toThrow('existing category')
    expect(() => invoke('menu:save-category', { name: 'chef SPECIALS', sortOrder: 1 })).toThrow('already exists')
  })

  it('enforces backend roles for menu, reports, stock, kitchen, refunds, and cash closing', () => {
    invoke('staff:create', { username: 'cashier', displayName: 'Cashier', role: 'cashier', password })
    invoke('staff:login', { username: 'cashier', password }, 2)
    for (const channel of ['menu:catalog', 'reports:sales', 'inventory:list', 'kitchen:queue', 'cash:summary', 'payments:refund']) {
      expect(() => invoke(channel, {}, 2)).toThrow('permission')
    }
    invoke('staff:create', { username: 'accountant', displayName: 'Accountant', role: 'accountant', password })
    invoke('staff:login', { username: 'accountant', password }, 3)
    expect(invoke<SalesReport>('reports:sales', period(), 3).paidBills).toBe(0)
    expect(() => invoke('menu:catalog', undefined, 3)).toThrow('permission')
  })

  it('records stock adjustments once and rolls back negative stock', () => {
    const item = invoke<InventoryItem>('inventory:save-item', { name: 'Rice', unit: 'kg', reorderMilli: 2000 })
    const move = { requestId: randomUUID(), itemId: item.id, deltaMilli: 10500, reason: 'Supplier delivery' }
    expect(invoke<InventoryItem>('inventory:move-stock', move).quantityMilli).toBe(10500)
    expect(invoke<InventoryItem>('inventory:move-stock', move).quantityMilli).toBe(10500)
    expect(() => invoke('inventory:move-stock', { ...move, deltaMilli: 100 })).toThrow('different adjustment')
    expect(() => invoke('inventory:move-stock', { ...move, requestId: randomUUID(), deltaMilli: -11000 })).toThrow('insufficient stock')
    expect(invoke<InventoryItem[]>('inventory:list')[0].quantityMilli).toBe(10500)
    expect(invoke<StockMovement[]>('inventory:history', item.id)).toHaveLength(1)
    expect(() => invoke('inventory:save-item', { ...item, unit: 'pieces' })).toThrow('Units cannot change')
  })

  it('keeps paid orders in the kitchen until handed over and enforces preparation sequence', () => {
    const { saved } = createBill()
    invoke('pos:record-payment', { requestId: randomUUID(), orderId: saved.id, method: 'cash' })
    expect(invoke<KitchenQueue>('kitchen:queue').orders).toHaveLength(1)
    expect(() => invoke('kitchen:update', { orderId: saved.id, status: 'ready' })).toThrow('sequence')
    invoke('kitchen:update', { orderId: saved.id, status: 'preparing' })
    invoke('kitchen:update', { orderId: saved.id, status: 'ready' })
    invoke('kitchen:update', { orderId: saved.id, status: 'payment_pending' })
    expect(invoke<KitchenQueue>('kitchen:queue').orders).toHaveLength(0)
    expect(invoke<SavedOrder>('pos:get-order', saved.id).status).toBe('paid')
  })

  it('splits payments, rejects overpayment, prevents edits and preserves retry identity', () => {
    const { saved, input } = createBill()
    const first = { requestId: randomUUID(), orderId: saved.id, method: 'cash', amountPaise: 100 }
    expect(invoke<PaymentLedger>('payments:collect', first).balancePaise).toBe(saved.totalPaise - 100)
    expect(invoke<PaymentLedger>('payments:collect', first).tenders).toHaveLength(1)
    expect(() => invoke('payments:collect', { ...first, amountPaise: 200 })).toThrow('different details')
    expect(() => invoke('payments:collect', { ...first, requestId: randomUUID(), amountPaise: saved.totalPaise })).toThrow('exceed')
    expect(() => invoke('pos:create-order', { ...input, orderId: saved.id, requestId: randomUUID() })).toThrow('cannot be edited')
    const final = { ...first, requestId: randomUUID(), method: 'upi', amountPaise: saved.totalPaise - 100 }
    expect(invoke<PaymentLedger>('payments:collect', final).settled).toBe(true)
    expect(invoke<PaymentLedger>('payments:collect', final).tenders).toHaveLength(2)
    expect(invoke<SavedOrder>('pos:get-order', saved.id).status).toBe('paid')
    const history = invoke<{ payment: PaymentRecord }[]>('pos:list-bill-history')
    expect(history[0].payment.method).toBe('split')
  })

  it('allows the existing full-payment action to pay the remaining balance', () => {
    const { saved } = createBill()
    invoke('payments:collect', { requestId: randomUUID(), orderId: saved.id, method: 'cash', amountPaise: 100 })
    const input = { requestId: randomUUID(), orderId: saved.id, method: 'card' }
    const payment = invoke<PaymentRecord>('pos:record-payment', input)
    expect(payment.method).toBe('split')
    expect(invoke<PaymentRecord>('pos:record-payment', input).id).toBe(payment.id)
    expect(invoke<PaymentLedger>('payments:ledger', saved.id).collectedPaise).toBe(saved.totalPaise)
  })

  it('voids one saved item quantity with manager confirmation and recalculates the unpaid bill', () => {
    const catalog = invoke<MenuCatalog>('menu:catalog')
    const [first, second] = catalog.products.filter(product => product.available)
    const saved = invoke<SavedOrder>('pos:create-order', {
      requestId: randomUUID(), type: 'parcel', parcelNumber: 1, tableId: null, customerName: 'Guest', deliveryAddress: '', discount: null,
      items: [{ productId: first.id, quantity: 3, note: '' }, { productId: second.id, quantity: 1, note: '' }],
    })
    invoke('pos:set-manager-pin', '123456')
    const firstLine = saved.items.find(item => item.productId === first.id)!
    expect(() => invoke('pos:void-order-item', { orderId: saved.id, itemId: firstLine.id, quantity: 4, pin: '123456', reason: 'Customer changed order' })).toThrow('Cannot void more')
    expect(() => invoke('pos:void-order-item', { orderId: saved.id, itemId: firstLine.id, quantity: 1, pin: '000000', reason: 'Customer changed order' })).toThrow('Incorrect manager PIN')
    const updated = invoke<SavedOrder>('pos:void-order-item', { orderId: saved.id, itemId: firstLine.id, quantity: 2, pin: '123456', reason: 'Customer changed order' })
    expect(updated.items.find(item => item.id === firstLine.id)?.quantity).toBe(1)
    expect(updated.totalPaise).toBeLessThan(saved.totalPaise)
    const remaining = updated.items.find(item => item.id === firstLine.id)!
    const removed = invoke<SavedOrder>('pos:void-order-item', { orderId: saved.id, itemId: remaining.id, quantity: 1, pin: '123456', reason: 'Customer cancelled dish' })
    expect(removed.items.some(item => item.id === firstLine.id)).toBe(false)
    expect(() => invoke('pos:void-order-item', { orderId: saved.id, itemId: removed.items[0].id, quantity: 1, pin: '123456', reason: 'Remove final item' })).toThrow('Use Void bill')
  })

  it('keeps independent active bills under the same dine-in table', () => {
    const menu = invoke<import('../../shared/domain').MenuData>('pos:load-menu')
    const table = menu.tables[0]
    const product = menu.products.find(item => item.available)!
    const first = invoke<SavedOrder>('pos:create-order', {
      requestId: randomUUID(), type: 'dine_in', tableId: table.id, customerName: '', deliveryAddress: '', discount: null,
      items: [{ productId: product.id, quantity: 1, note: 'First bill' }],
    })
    const second = invoke<SavedOrder>('pos:create-order', {
      requestId: randomUUID(), type: 'dine_in', tableId: table.id, customerName: '', deliveryAddress: '', discount: null,
      items: [{ productId: product.id, quantity: 2, note: 'Second bill' }],
    })
    expect(second.id).not.toBe(first.id)
    const refreshed = invoke<import('../../shared/domain').MenuData>('pos:load-menu')
    expect(refreshed.activeOrders.filter(order => order.tableId === table.id).map(order => order.id)).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(refreshed.tables.find(item => item.id === table.id)).toMatchObject({ activeOrderCount: 2 })
  })

  it('splits selected dine-in quantities into an independently payable bill', () => {
    const menu = invoke<import('../../shared/domain').MenuData>('pos:load-menu')
    const [first, second] = menu.products.filter(item => item.available)
    const source = invoke<SavedOrder>('pos:create-order', {
      requestId: randomUUID(), type: 'dine_in', tableId: menu.tables[0].id, customerName: '', deliveryAddress: '',
      discount: { kind: 'fixed', valuePaise: 300 },
      items: [{ productId: first.id, quantity: 3, note: '' }, { productId: second.id, quantity: 1, note: '' }],
    })
    const firstLine = source.items.find(item => item.productId === first.id)!
    const requestId = randomUUID()
    const result = invoke<import('../../shared/domain').SplitOrderResult>('pos:split-order', { requestId, orderId: source.id, items: [{ itemId: firstLine.id, quantity: 2 }] })
    expect(result.source.id).toBe(source.id)
    expect(result.source.items.find(item => item.id === firstLine.id)?.quantity).toBe(1)
    expect(result.split.tableId).toBe(source.tableId)
    expect(result.split.items).toMatchObject([{ productId: first.id, quantity: 2 }])
    expect(result.source.discountPaise + result.split.discountPaise).toBe(source.discountPaise)
    expect(invoke<import('../../shared/domain').SplitOrderResult>('pos:split-order', { requestId, orderId: source.id, items: [{ itemId: firstLine.id, quantity: 2 }] })).toEqual(result)
    expect(() => invoke('pos:split-order', { requestId: randomUUID(), orderId: result.source.id, items: result.source.items.map(item => ({ itemId: item.id, quantity: item.quantity })) })).toThrow('Leave at least one item')
  })

  it('joins active table bills into one independently payable bill and preserves source history', () => {
    const menu = invoke<import('../../shared/domain').MenuData>('pos:load-menu')
    const [first, second] = menu.products.filter(item => item.available)
    const create = (productId: string, quantity: number) => invoke<SavedOrder>('pos:create-order', {
      requestId: randomUUID(), type: 'dine_in', tableId: menu.tables[0].id, customerName: '', deliveryAddress: '', discount: null,
      items: [{ productId, quantity, note: '' }],
    })
    const one = create(first.id, 1); const two = create(second.id, 2)
    const requestId = randomUUID()
    const joined = invoke<SavedOrder>('pos:join-orders', { requestId, orderIds: [one.id, two.id] })
    expect(joined.items).toHaveLength(2)
    expect(joined.totalPaise).toBe(one.totalPaise + two.totalPaise)
    expect(invoke<SavedOrder>('pos:join-orders', { requestId, orderIds: [one.id, two.id] })).toEqual(joined)
    const refreshed = invoke<import('../../shared/domain').MenuData>('pos:load-menu')
    expect(refreshed.activeOrders.filter(order => order.tableId === menu.tables[0].id).map(order => order.id)).toEqual([joined.id])
    expect(invoke<SavedOrder>('pos:get-order', one.id).status).toBe('joined')
    expect(() => invoke('payments:collect', { requestId: randomUUID(), orderId: one.id, method: 'cash', amountPaise: 100 })).toThrow('joined')
  })

  it('caps refunds at the original tender, keeps the invoice paid, and reconciles cash/report totals', () => {
    const { saved } = createBill()
    const ledger = invoke<PaymentLedger>('payments:collect', { requestId: randomUUID(), orderId: saved.id, method: 'cash', amountPaise: saved.totalPaise })
    const refund = { requestId: randomUUID(), tenderId: ledger.tenders[0].id, amountPaise: 100, reason: 'Returned item' }
    expect(invoke<PaymentLedger>('payments:refund', refund).refundedPaise).toBe(100)
    expect(invoke<PaymentLedger>('payments:refund', refund).refunds).toHaveLength(1)
    expect(() => invoke('payments:refund', { ...refund, requestId: randomUUID(), amountPaise: saved.totalPaise })).toThrow('exceeds')
    expect(invoke<SavedOrder>('pos:get-order', saved.id).status).toBe('paid')
    const report = invoke<SalesReport>('reports:sales', period())
    expect(report).toMatchObject({ paidBills: 1, totalPaise: saved.totalPaise, refundedPaise: 100, netCollectionsPaise: saved.totalPaise - 100 })
    expect(invoke<CashSummary>('cash:summary').receiptsPaise).toBe(saved.totalPaise - 100)
  })

  it('uses cash ledger cutoffs to avoid counting receipts and refunds twice', () => {
    const { saved } = createBill()
    const ledger = invoke<PaymentLedger>('payments:collect', { requestId: randomUUID(), orderId: saved.id, method: 'cash', amountPaise: saved.totalPaise })
    const input = { requestId: randomUUID(), openingPaise: 50000, countedPaise: 50000 + saved.totalPaise, notes: '' }
    const close = invoke<CashClose>('cash:close', input)
    expect(invoke<CashClose>('cash:close', input).id).toBe(close.id)
    expect(invoke<CashSummary>('cash:summary').receiptsPaise).toBe(0)
    invoke('payments:refund', { requestId: randomUUID(), tenderId: ledger.tenders[0].id, amountPaise: 100, reason: 'Customer return' })
    expect(invoke<CashSummary>('cash:summary').receiptsPaise).toBe(-100)
    expect(() => invoke('cash:close', { ...input, requestId: randomUUID(), countedPaise: 0, openingPaise: 0 })).toThrow('variance')
    invoke('cash:close', { requestId: randomUUID(), openingPaise: 100, countedPaise: 0, notes: 'Cash refund' })
    expect(invoke<CashSummary>('cash:summary').receiptsPaise).toBe(0)
  })

  it('validates report dates and reports the remaining amount on a partially paid bill', () => {
    const { saved } = createBill()
    invoke('payments:collect', { requestId: randomUUID(), orderId: saved.id, method: 'upi', amountPaise: 100 })
    expect(invoke<SalesReport>('reports:sales', period())).toMatchObject({ unpaidBills: 1, unpaidPaise: saved.totalPaise - 100, collectedPaise: 100, paidBills: 0 })
    expect(() => invoke('reports:sales', { from: '2026-02-30', to: '2026-03-01' })).toThrow()
    expect(() => invoke('reports:sales', { from: '2026-10-22', to: '2026-10-01' })).toThrow()
  })

  it('gives waiters a table-ordering workspace without billing privileges and creates separate kitchen batches', () => {
    invoke('staff:create', { username: 'waiter', displayName: 'Waiter', role: 'waiter', password })
    invoke('staff:login', { username: 'waiter', password }, 2)
    const menu = invoke<import('../../shared/domain').MenuData>('waiter:menu', undefined, 2)
    const input = { requestId: randomUUID(), type: 'dine_in', tableId: menu.tables[0].id,
      customerName: '', deliveryAddress: '', discount: null,
      items: [{ productId: menu.products.find(product => product.available)!.id, quantity: 1, note: 'First course' }] }
    const saved = invoke<SavedOrder>('pos:create-order', input, 2)
    invoke('pos:create-order', input, 2)
    expect(invoke<KitchenQueue>('kitchen:queue').orders).toHaveLength(1)
    const firstTicket = invoke<KitchenQueue>('kitchen:queue').orders[0]
    invoke('kitchen:update', { orderId: saved.id, ticketId: firstTicket.ticketId, status: 'preparing' })
    invoke('kitchen:update', { orderId: saved.id, ticketId: firstTicket.ticketId, status: 'ready' })
    invoke('kitchen:update', { orderId: saved.id, ticketId: firstTicket.ticketId, status: 'payment_pending' })
    invoke('pos:create-order', { ...input, requestId: randomUUID(), orderId: saved.id, items: [{ ...input.items[0], quantity: 2, note: 'Second course' }] }, 2)
    const queue = invoke<KitchenQueue>('kitchen:queue')
    expect(queue.orders).toHaveLength(1)
    expect(queue.orders[0].items).toHaveLength(1)
    expect(queue.orders[0].items[0]).toMatchObject({ quantity: 2, note: 'Second course' })
    expect(() => invoke('pos:record-payment', { requestId: randomUUID(), orderId: saved.id, method: 'cash' }, 2)).toThrow('permission')
    expect(() => invoke('pos:create-order', { ...input, requestId: randomUUID(), discount: { kind: 'fixed', valuePaise: 100 } }, 2)).toThrow('permission')
    expect(() => invoke('pos:create-order', { ...input, type: 'parcel', tableId: null, parcelNumber: 1 }, 2)).toThrow('table orders only')
  })
})

it('migrates legacy full payments into the tender ledger without losing row identities', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE orders(id TEXT PRIMARY KEY,total_paise INTEGER,paid_at TEXT);
    CREATE TABLE payments(id TEXT PRIMARY KEY,order_id TEXT REFERENCES orders(id),request_id TEXT,method TEXT,amount_paise INTEGER,paid_at TEXT);
    CREATE TABLE cash_closes(payment_cutoff INTEGER);
    INSERT INTO orders VALUES('00000000-0000-4000-8000-000000000001',10000,'2026-10-22 10:00:00');
    INSERT INTO payments(rowid,id,order_id,request_id,method,amount_paise,paid_at) VALUES(42,'legacy','00000000-0000-4000-8000-000000000001','old-request','cash',10000,'2026-10-22 10:00:00');`)
  const service = new FinancialManagementService(db, action => { db.exec('BEGIN'); try { const result = action(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error } })
  try {
    service.migrate(); service.migrate()
    expect(db.prepare('SELECT rowid FROM payment_tenders').get()?.rowid).toBe(42)
    expect(service.ledger('00000000-0000-4000-8000-000000000001')).toMatchObject({ settled: true, collectedPaise: 10000, balancePaise: 0 })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
  } finally { db.close() }
})
