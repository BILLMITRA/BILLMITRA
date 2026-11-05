import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPosBackend } from '../backend.cjs'
import { FinancialManagementService } from './financialManagement.cjs'
import type { Category, Product, SavedOrder, PaymentRecord, MenuData } from '../../shared/domain'
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
  it('adds dining tables for managers, prevents duplicates and rejects unauthorized staff', () => {
    invoke('staff:create', { username: 'manager', displayName: 'Manager', role: 'manager', password })
    invoke('staff:create', { username: 'cashier', displayName: 'Cashier', role: 'cashier', password })
    invoke('staff:login', { username: 'manager', password }, 2)
    invoke('staff:login', { username: 'cashier', password }, 3)
    const added = invoke<{ id: string }>('tables:add', { name: '21', floor: 'ground floor', capacity: 4 }, 2)
    expect(invoke<MenuData>('pos:load-menu').tables.find(table => table.id === added.id)).toMatchObject({ name: '21', floor: 'Ground Floor', capacity: 4, status: 'available' })
    expect(() => invoke('tables:add', { name: '21', floor: 'GROUND FLOOR', capacity: 4 }, 2)).toThrow('already exists')
    expect(() => invoke('tables:add', { name: '22', floor: 'Floor 2', capacity: 0 }, 2)).toThrow()
    expect(() => invoke('tables:add', { name: '22', floor: 'Floor 2', capacity: 4 }, 3)).toThrow('permission')
  })
  it('saves card counts and refuses to hide an active order', () => {
    createBill(7)
    expect(() => invoke('cards:save-settings', { parcelCount: 6, deliveryCount: 10 })).toThrow('P-7')
    invoke('cards:save-settings', { parcelCount: 7, deliveryCount: 10 })
    expect(invoke<MenuData>('pos:load-menu').cardSettings).toEqual({ parcelCount: 7, deliveryCount: 10 })
    expect(() => invoke('cards:save-settings', { parcelCount: 101, deliveryCount: 10 })).toThrow()
  })
  it('keeps one opening amount across app restarts and requires a new opening after closing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'billmitra-cash-opening-'))
    const path = join(directory, 'pos.sqlite')
    let persistent = createPosBackend(path)
    try {
      persistent.invoke('staff:setup-owner', 9, owner)
      persistent.invoke('cash:open', 9, { requestId: randomUUID(), openingPaise: 25000 })
      persistent.close()
      persistent = createPosBackend(path)
      persistent.invoke('staff:login', 9, owner)
      expect((persistent.invoke('cash:summary', 9) as CashSummary).currentOpening?.openingPaise).toBe(25000)
      expect(() => persistent.invoke('cash:open', 9, { requestId: randomUUID(), openingPaise: 0 })).toThrow('already open')
      persistent.invoke('cash:close', 9, { requestId: randomUUID(), countedPaise: 25000, notes: '' })
      expect((persistent.invoke('cash:summary', 9) as CashSummary).currentOpening).toBeNull()
      persistent.invoke('cash:open', 9, { requestId: randomUUID(), openingPaise: 18000 })
      expect((persistent.invoke('cash:summary', 9) as CashSummary).currentOpening?.openingPaise).toBe(18000)
    } finally { persistent.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it('waits for customer selection before preparing a delivery KOT', () => {
    const catalog = invoke<MenuCatalog>('menu:catalog')
    const product = catalog.products.find(item => item.available)!
    const order = invoke<SavedOrder>('pos:create-order', {
      requestId: randomUUID(), type: 'delivery', deliveryNumber: 1, tableId: null,
      customerName: '', contactNumber: '', deliveryAddress: '', discount: null,
      deferKitchenTicket: true, items: [{ productId: product.id, quantity: 1, note: '' }],
    })
    expect(invoke<KitchenQueue>('kitchen:queue').orders).toHaveLength(0)
    const customer = invoke<{ id: string }>('delivery:save-customer', { customerName: 'Shan',
      contactNumber: '9656684727', deliveryAddress: 'Vengara market', deliveryArea: 'Vengara',
      deliveryLandmark: '', deliveryInstructions: 'Call on arrival' })
    expect(invoke<Array<{ id: string }>>('delivery:list-customers', '727')[0].id).toBe(customer.id)
    const finish = { requestId: randomUUID(), type: 'delivery', deliveryNumber: 1, tableId: null,
      orderId: order.id, customerName: 'Shan', contactNumber: '9656684727',
      deliveryAddress: 'Vengara market', deliveryArea: 'Vengara', deliveryLandmark: '',
      deliveryInstructions: 'Call on arrival', discount: null, prepareKitchenTicket: true, items: [] }
    invoke<SavedOrder>('pos:create-order', finish)
    expect(invoke<KitchenQueue>('kitchen:queue').orders).toHaveLength(1)
    invoke<SavedOrder>('pos:create-order', { ...finish, requestId: randomUUID() })
    expect(invoke<KitchenQueue>('kitchen:queue').orders).toHaveLength(1)
  })

  it('allows a takeaway order without a pickup name', () => {
    const catalog = invoke<MenuCatalog>('menu:catalog')
    const product = catalog.products.find(item => item.available)!
    const saved = invoke<SavedOrder>('pos:create-order', {
      requestId: randomUUID(), type: 'parcel', parcelNumber: 1, tableId: null,
      customerName: '', deliveryAddress: '', discount: null,
      items: [{ productId: product.id, quantity: 1, note: '' }],
    })
    expect(saved).toMatchObject({ type: 'parcel', parcelNumber: 1, customerName: '' })
    const linked = invoke<SavedOrder>('pos:create-order', {
      requestId: randomUUID(), type: 'parcel', parcelNumber: 1, tableId: null, orderId: saved.id,
      customerName: 'Guest', contactNumber: '928', deliveryAddress: '', deliveryArea: 'Vengara',
      discount: null, items: [],
    })
    expect(linked).toMatchObject({ customerName: 'Guest', contactNumber: '928', deliveryArea: 'Vengara' })
    expect(invoke<Array<{ contactNumber: string }>>('delivery:list-customers', '928')[0].contactNumber).toBe('928')
  })

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
    for (const channel of ['menu:catalog', 'reports:sales', 'inventory:list', 'kitchen:queue', 'payments:refund']) {
      expect(() => invoke(channel, {}, 2)).toThrow('permission')
    }
    expect(invoke<CashSummary>('cash:summary', undefined, 2).currentOpening).toBeNull()
    expect(invoke('cash:open', { requestId: randomUUID(), openingPaise: 0 }, 2)).toMatchObject({ openingPaise: 0 })
    expect(() => invoke('cash:close', { requestId: randomUUID(), countedPaise: 0, notes: '' }, 2)).toThrow('permission')
    invoke('staff:create', { username: 'accountant', displayName: 'Accountant', role: 'accountant', password })
    invoke('staff:login', { username: 'accountant', password }, 3)
    expect(invoke<SalesReport>('reports:sales', period(), 3).paidBills).toBe(0)
    expect(() => invoke('menu:catalog', undefined, 3)).toThrow('permission')
  })

  it('requires the numeric manager PIN and a permitted role to open Management', () => {
    invoke('staff:create', { username: 'manager', displayName: 'Manager', role: 'manager', password })
    invoke('staff:create', { username: 'cashier', displayName: 'Cashier', role: 'cashier', password })
    invoke('staff:login', { username: 'manager', password }, 2)
    invoke('staff:login', { username: 'cashier', password }, 3)
    expect(() => invoke('pos:authorize-management', '1234', 2)).toThrow('Ask the owner to set a manager PIN')
    invoke('pos:set-manager-pin', '1234')
    expect(() => invoke('pos:authorize-management', '1234', 3)).toThrow('permission')
    expect(() => invoke('pos:authorize-management', '0000', 2)).toThrow('Incorrect manager PIN')
    expect(invoke('pos:authorize-management', '1234', 2)).toBeUndefined()
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(() => invoke('pos:authorize-management', '0000', 2)).toThrow(attempt === 4 ? 'Too many incorrect PIN attempts' : 'Incorrect manager PIN')
    }
    expect(() => invoke('pos:authorize-management', '1234', 2)).toThrow('temporarily locked')
  })

  it('lets only the owner replace a forgotten PIN after confirming the owner password', () => {
    const manager = invoke<{ id: string }>('staff:create', { username: 'manager', displayName: 'Manager', role: 'manager', password })
    invoke('staff:login', { username: 'manager', password }, 2)
    invoke('pos:set-manager-pin', '1234')
    expect(() => invoke('pos:reset-manager-pin', { ownerPassword: password, pin: '5678' }, 2)).toThrow('permission')
    expect(manager.id).toBeTruthy()
    expect(() => invoke('pos:reset-manager-pin', { ownerPassword: 'wrong-password', pin: '5678' })).toThrow('Invalid username or password')
    expect(invoke('pos:authorize-management', '1234')).toBeUndefined()
    expect(invoke('pos:reset-manager-pin', { ownerPassword: password, pin: '5678' })).toBeUndefined()
    expect(() => invoke('pos:authorize-management', '1234')).toThrow('Incorrect manager PIN')
    expect(invoke('pos:authorize-management', '5678')).toBeUndefined()
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

  it('joins bills from different tables and releases the second table', () => {
    const menu = invoke<MenuData>('pos:load-menu')
    const product = menu.products.find(item => item.available)!
    const create = (tableId: string) => invoke<SavedOrder>('pos:create-order', {
      requestId: randomUUID(), type: 'dine_in', tableId, customerName: '', deliveryAddress: '', discount: null,
      items: [{ productId: product.id, quantity: 1, note: '' }],
    })
    const first = create(menu.tables[0].id); const second = create(menu.tables[1].id)
    const combined = invoke<SavedOrder>('pos:join-orders', { requestId: randomUUID(), orderIds: [first.id, second.id] })
    expect(combined.tableId).toBe(first.tableId)
    expect(combined.totalPaise).toBe(first.totalPaise + second.totalPaise)
    const updated = invoke<MenuData>('pos:load-menu')
    expect(updated.tables.find(table => table.id === first.tableId)?.orderId).toBe(combined.id)
    expect(updated.tables.find(table => table.id === second.tableId)?.status).toBe('available')
    expect(invoke<SavedOrder>('pos:get-order', first.id).status).toBe('joined')
    expect(invoke<SavedOrder>('pos:get-order', second.id).status).toBe('joined')
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
    const opening = { requestId: randomUUID(), openingPaise: 50000 }
    expect(invoke('cash:open', opening)).toMatchObject({ openingPaise: 50000 })
    expect(invoke('cash:open', opening)).toMatchObject({ openingPaise: 50000 })
    expect(() => invoke('cash:open', { requestId: randomUUID(), openingPaise: 1 })).toThrow('already open')
    const input = { requestId: randomUUID(), openingPaise: 50000, countedPaise: 50000 + saved.totalPaise, notes: '' }
    const close = invoke<CashClose>('cash:close', input)
    expect(invoke<CashClose>('cash:close', input).id).toBe(close.id)
    expect(invoke<CashSummary>('cash:summary').receiptsPaise).toBe(0)
    expect(invoke<CashSummary>('cash:summary').currentOpening).toBeNull()
    invoke('payments:refund', { requestId: randomUUID(), tenderId: ledger.tenders[0].id, amountPaise: 100, reason: 'Customer return' })
    expect(invoke<CashSummary>('cash:summary').receiptsPaise).toBe(-100)
    expect(() => invoke('cash:close', { ...input, requestId: randomUUID(), countedPaise: 0, openingPaise: 0 })).toThrow('opening cash amount')
    invoke('cash:open', { requestId: randomUUID(), openingPaise: 100 })
    expect(() => invoke('cash:close', { ...input, requestId: randomUUID(), countedPaise: 0, openingPaise: 0 })).toThrow('differs')
    expect(() => invoke('cash:close', { requestId: randomUUID(), countedPaise: 1, notes: '' })).toThrow('variance')
    invoke('cash:close', { requestId: randomUUID(), openingPaise: 100, countedPaise: 0, notes: 'Cash refund' })
    expect(invoke<CashSummary>('cash:summary').receiptsPaise).toBe(0)
  })

  it('keeps an unpaid table open after drawer closing and clears it after cash payment', () => {
    const menu = invoke<MenuData>('pos:load-menu')
    const table = menu.tables[0]
    const product = invoke<MenuCatalog>('menu:catalog').products.find(item => item.available)!
    const bill = invoke<SavedOrder>('pos:create-order', { requestId: randomUUID(), type: 'dine_in', tableId: table.id,
      customerName: '', deliveryAddress: '', discount: null, items: [{ productId: product.id, quantity: 1, note: '' }] })
    invoke('cash:open', { requestId: randomUUID(), openingPaise: 0 })
    invoke('cash:close', { requestId: randomUUID(), countedPaise: 0, notes: '' })
    expect(invoke<MenuData>('pos:load-menu').activeOrders.some(order => order.id === bill.id)).toBe(true)
    invoke('pos:record-payment', { requestId: randomUUID(), orderId: bill.id, method: 'cash' })
    const refreshed = invoke<MenuData>('pos:load-menu')
    expect(refreshed.activeOrders.some(order => order.id === bill.id)).toBe(false)
    expect(refreshed.tables.find(item => item.id === table.id)?.status).toBe('available')
    expect(invoke<CashSummary>('cash:summary').receiptsPaise).toBe(bill.totalPaise)
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
