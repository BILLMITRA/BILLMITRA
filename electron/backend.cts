import { randomUUID } from 'node:crypto'
import { RestaurantManagementService } from './services/restaurantManagement.cjs'
import { PrintManagementService } from './services/printManagement.cjs'
import { SavedTableBills } from './services/savedTableBills.cjs'
import { DeliveryCashHandovers } from './services/deliveryCashHandovers.cjs'
import { DeliveryRunSettlements } from './services/deliveryRunSettlements.cjs'
import { DeliveryWhatsAppService } from './services/deliveryWhatsApp.cjs'
import { CustomerWaitingService } from './services/customerWaiting.cjs'
import { FinancialManagementService } from './services/financialManagement.cjs'
import { acquireDatabaseLease, DatabaseBackupService } from './services/databaseBackups.cjs'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { calculateTotals } from '../shared/billing.js'
import type { BillDiscount } from '../shared/billing.js'
import { DELIVERY_SLOT_COUNT, PARCEL_SLOT_COUNT, isValidDeliveryNumber, isValidParcelNumber } from '../shared/domain.js'
import { createManagerPinHash, managerPinPattern, verifyManagerPin } from '../shared/managerSecurity.js'
import { staffSchemaMigration } from './database/staffSchema.cjs'
import { StaffAuthService } from './security/staffAuth.cjs'
import { deliverySchemaMigration } from './database/deliverySchema.cjs'
import { migrateProfessionalBillingSchema, recordOrderLifecycleEvent, upsertCustomerProfile } from './database/professionalBillingSchema.cjs'
import { DeliveryManagementService } from './services/deliveryManagement.cjs'
import { findSavedDeliveryCustomer as lookupSavedDeliveryCustomer, listSavedDeliveryCustomers as lookupDeliveryCustomers, saveSavedDeliveryCustomer as persistDeliveryCustomer } from './services/deliveryCustomers.cjs'
import type {
  BillHistoryEntry,
  CreateOrderInput,
  OrderType,
  OrderStatus,
  PaymentRecord,
  RecordPaymentInput,
  SavedOrder,
  StaffAccessState,
  StaffIdentity,
  StaffPermission,
  SplitOrderInput,
  SplitOrderResult,
  JoinOrdersInput,
} from '../shared/domain.js'

type RequestContext = { sender: { id: number } }
type Operation = (event: RequestContext, input?: unknown) => unknown

// One instance owns a database and independent staff sessions.
export function createPosBackend(databasePath: string) {
  const lease = acquireDatabaseLease(databasePath)
  let cleanup = () => {}
  let closeOnFailure = () => {}
  try {
  const orderInputSchema = z.object({
    requestId: z.string().uuid(),
    type: z.enum(['dine_in', 'parcel', 'delivery']),
    tableId: z.string().nullable(),
    customerName: z.string().trim().max(120),
    contactNumber: z.string().trim().max(30).optional().default(''),
    deliveryAddress: z.string().trim(),
    items: z.array(z.object({
      productId: z.string().min(1).max(80),
      quantity: z.number().int().min(1).max(99),
      note: z.string().trim().max(200),
    })).max(100),
    discount: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('percentage'), valueBps: z.number().int().min(0).max(10_000) }),
      z.object({ kind: z.literal('fixed'), valuePaise: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
    ]).nullable().default(null),
    deliveryNumber: z.number().int().min(1).max(DELIVERY_SLOT_COUNT).nullable().optional(),
    parcelNumber: z.number().int().min(1).max(PARCEL_SLOT_COUNT).nullable().optional(),
    scheduledDeliveryAt: z.string().datetime({ offset: true }).nullable().optional(),
    scheduledPickupAt: z.string().datetime({ offset: true }).nullable().optional(),
    assignedDeliveryTo: z.string().trim().max(120).optional(),
    deliveryArea: z.string().trim().max(120).optional().default(''),
    deliveryLandmark: z.string().trim().max(160).optional().default(''),
    deliveryInstructions: z.string().trim().max(300).optional().default(''),
    kitchenMessage: z.string().trim().max(300).optional(),
    deferKitchenTicket: z.boolean().optional().default(false),
    prepareKitchenTicket: z.boolean().optional().default(false),
    whatsappBillOptIn: z.boolean().optional().default(false),
    orderId: z.string().uuid().optional(),
  })

  const savedOrderItemSchema = z.object({
    id: z.string(),
    productId: z.string(),
    productName: z.string(),
    unitPricePaise: z.number(),
    taxRateBps: z.number(),
    quantity: z.number(),
    note: z.string(),
  })

  const orderStatusValues: readonly OrderStatus[] = ['ordering', 'preparing', 'ready', 'payment_pending']
  const paymentInputSchema = z.object({
    requestId: z.string().uuid(),
    orderId: z.string().uuid(),
    method: z.enum(['cash', 'card', 'upi']),
  })
  const paymentRecordSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    method: z.enum(['cash', 'card', 'upi', 'split']),
    amountPaise: z.number().int().nonnegative(),
    paidAt: z.string(),
  })
  const managerPinSchema = z.string().regex(managerPinPattern, 'Manager PIN must be 4 to 12 digits.')
  const deliveryCashOutSchema = z.object({
    requestId: z.string().uuid(), orderId: z.string().uuid(), pin: managerPinSchema,
    expectedBalancePaise: z.number().int().nonnegative(),
  }).strict()
  const voidOrderSchema = z.object({
    orderId: z.string().uuid(),
    pin: managerPinSchema,
    reason: z.string().trim().min(3).max(250),
  })
  const voidOrderItemSchema = z.object({
    orderId: z.string().uuid(),
    itemId: z.string().uuid(),
    quantity: z.number().int().min(1).max(99),
    pin: managerPinSchema,
    reason: z.string().trim().min(3).max(250),
  })
  const splitOrderSchema = z.object({
    requestId: z.string().uuid(),
    orderId: z.string().uuid(),
    items: z.array(z.object({ itemId: z.string().uuid(), quantity: z.number().int().min(1).max(99) })).min(1).max(100),
  })
  const joinOrdersSchema = z.object({
    requestId: z.string().uuid(),
    orderIds: z.array(z.string().uuid()).min(2).max(10),
  })
  const database = new DatabaseSync(databasePath)
  closeOnFailure = () => database.close()
  const deliveryWhatsApp = new DeliveryWhatsAppService(database)
  const backups = new DatabaseBackupService(database, databasePath)
  cleanup = () => backups.stop()
  backups.start()
  let staffAuth: StaffAuthService
  let deliveryManagement: DeliveryManagementService
  let customerWaiting: CustomerWaitingService

  function withTransaction<T>(db: DatabaseSync, action: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function migrateAndSeed(db: DatabaseSync): void {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS card_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        parcel_count INTEGER NOT NULL CHECK (parcel_count BETWEEN 1 AND 100),
        delivery_count INTEGER NOT NULL CHECK (delivery_count BETWEEN 1 AND 100)
      );
    `)

    withTransaction(db, () => {
      const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(1)
      if (applied) return
        db.exec(`
          CREATE TABLE categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL
          );
          CREATE TABLE products (
            id TEXT PRIMARY KEY,
            category_id TEXT NOT NULL REFERENCES categories(id),
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
            tax_rate_bps INTEGER NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
            available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1))
          );
          CREATE TABLE restaurant_tables (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            floor TEXT NOT NULL,
            capacity INTEGER NOT NULL CHECK (capacity > 0)
          );
          CREATE TABLE orders (
            id TEXT PRIMARY KEY,
            display_number INTEGER NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('dine_in', 'parcel', 'delivery')),
            status TEXT NOT NULL CHECK (status IN ('ordering', 'preparing', 'ready', 'payment_pending')),
            table_id TEXT REFERENCES restaurant_tables(id),
            customer_name TEXT NOT NULL DEFAULT '',
            delivery_address TEXT NOT NULL DEFAULT '',
            request_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            subtotal_paise INTEGER NOT NULL,
            tax_paise INTEGER NOT NULL,
            total_paise INTEGER NOT NULL
          );
          CREATE UNIQUE INDEX one_open_order_per_table ON orders(table_id)
            WHERE table_id IS NOT NULL AND status IN ('ordering', 'preparing', 'ready', 'payment_pending');
          CREATE TABLE order_items (
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            product_id TEXT NOT NULL REFERENCES products(id),
            product_name TEXT NOT NULL,
            unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
            tax_rate_bps INTEGER NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            note TEXT NOT NULL DEFAULT ''
          );
          CREATE TABLE order_requests (
            request_id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE
          );
          CREATE INDEX orders_created_at ON orders(created_at DESC);
        `)

        const addCategory = db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)')
        ;[
          ['starters', 'Starters', 0],
          ['mains', 'Mains', 1],
          ['breads', 'Breads', 2],
          ['drinks', 'Drinks', 3],
          ['desserts', 'Desserts', 4],
        ].forEach((row) => addCategory.run(...row))

        const addProduct = db.prepare(`
          INSERT INTO products (id, category_id, name, description, price_paise, tax_rate_bps)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        const products = [
          ['p-paneer-tikka', 'starters', 'Paneer Tikka', 'Char-grilled cottage cheese, mint chutney', 28900, 500],
          ['p-samosa', 'starters', 'Punjabi Samosa', 'Crisp pastry, spiced potato & peas', 14900, 500],
          ['p-chicken-tikka', 'starters', 'Chicken Tikka', 'Clay-oven chicken, house marinade', 32900, 500],
          ['p-dal-makhani', 'mains', 'Dal Makhani', 'Slow-cooked black lentils, cream', 27900, 500],
          ['p-butter-chicken', 'mains', 'Butter Chicken', 'Tandoori chicken, tomato makhani', 38900, 500],
          ['p-paneer-butter', 'mains', 'Paneer Butter Masala', 'Cottage cheese in rich tomato gravy', 31900, 500],
          ['p-biryani', 'mains', 'Veg Dum Biryani', 'Saffron basmati, raita on the side', 29900, 500],
          ['p-garlic-naan', 'breads', 'Garlic Naan', 'Tandoor baked, garlic & coriander', 6900, 500],
          ['p-butter-naan', 'breads', 'Butter Naan', 'Soft leavened bread, brushed with butter', 5900, 500],
          ['p-jeera-rice', 'breads', 'Jeera Rice', 'Steamed basmati, toasted cumin', 16900, 500],
          ['p-lassi', 'drinks', 'Mango Lassi', 'Yoghurt, Alphonso mango', 12900, 500],
          ['p-lime-soda', 'drinks', 'Fresh Lime Soda', 'Fresh lime, sweet or salted', 8900, 500],
          ['p-gulab-jamun', 'desserts', 'Gulab Jamun', 'Two warm khoya dumplings', 9900, 500],
        ] as const
        products.forEach((product) => addProduct.run(...product))

        const addTable = db.prepare('INSERT INTO restaurant_tables (id, name, floor, capacity) VALUES (?, ?, ?, ?)')
        const tables = [
          ['g-01', '01', 'Ground Floor', 2], ['g-02', '02', 'Ground Floor', 2],
          ['g-03', '03', 'Ground Floor', 4], ['g-04', '04', 'Ground Floor', 4],
          ['g-05', '05', 'Ground Floor', 4], ['g-06', '06', 'Ground Floor', 6],
          ['f-01', '11', 'Floor 1', 2], ['f-02', '12', 'Floor 1', 2],
          ['f-03', '13', 'Floor 1', 4], ['f-04', '14', 'Floor 1', 4],
          ['f-05', '15', 'Floor 1', 6], ['f-06', '16', 'Floor 1', 6],
        ] as const
        tables.forEach((table) => addTable.run(...table))
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(1)
    })

    withTransaction(db, () => {
      const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(2)
      if (applied) return
      db.exec(`
        ALTER TABLE orders ADD COLUMN discount_kind TEXT NOT NULL DEFAULT 'none'
          CHECK (discount_kind IN ('none', 'percentage', 'fixed'));
        ALTER TABLE orders ADD COLUMN discount_value INTEGER NOT NULL DEFAULT 0 CHECK (discount_value >= 0);
        ALTER TABLE orders ADD COLUMN discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0);
        CREATE TABLE invoice_discount_history (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL UNIQUE,
          discount_kind TEXT NOT NULL CHECK (discount_kind IN ('none', 'percentage', 'fixed')),
          discount_value INTEGER NOT NULL CHECK (discount_value >= 0),
          discount_paise INTEGER NOT NULL CHECK (discount_paise >= 0),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(2)
    })

    withTransaction(db, () => {
      const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(3)
      if (applied) return
      db.exec(`
        ALTER TABLE orders ADD COLUMN paid_at TEXT;
        DROP INDEX one_open_order_per_table;
        CREATE UNIQUE INDEX one_open_order_per_table ON orders(table_id)
          WHERE table_id IS NOT NULL AND paid_at IS NULL
            AND status IN ('ordering', 'preparing', 'ready', 'payment_pending');
        CREATE TABLE payments (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
          request_id TEXT NOT NULL UNIQUE,
          method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'upi')),
          amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
          paid_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX payments_paid_at ON payments(paid_at DESC);
      `)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(3)
    })

    withTransaction(db, () => {
      const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(4)
      if (applied) return
      db.exec(`
        ALTER TABLE orders ADD COLUMN voided_at TEXT;
        ALTER TABLE orders ADD COLUMN voided_reason TEXT;
        DROP INDEX one_open_order_per_table;
        CREATE UNIQUE INDEX one_open_order_per_table ON orders(table_id)
          WHERE table_id IS NOT NULL AND paid_at IS NULL AND voided_at IS NULL
            AND status IN ('ordering', 'preparing', 'ready', 'payment_pending');
        CREATE TABLE manager_credentials (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          pin_salt TEXT NOT NULL,
          pin_hash TEXT NOT NULL,
          failed_attempts INTEGER NOT NULL DEFAULT 0,
          locked_until TEXT
        );
        CREATE TABLE audit_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          actor TEXT NOT NULL,
          reason TEXT NOT NULL,
          details_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX audit_log_created_at ON audit_log(created_at DESC);
      `)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(4)
    })

    withTransaction(db, () => {
      const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(5)
      if (applied) return
      db.exec(`
        ALTER TABLE orders ADD COLUMN delivery_number INTEGER;
        WITH numbered_deliveries AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, display_number) AS delivery_number
          FROM orders WHERE type = 'delivery'
        )
        UPDATE orders
        SET delivery_number = (
          SELECT delivery_number FROM numbered_deliveries WHERE numbered_deliveries.id = orders.id
        )
        WHERE type = 'delivery';
        CREATE UNIQUE INDEX one_delivery_number ON orders(delivery_number)
          WHERE delivery_number IS NOT NULL;
      `)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(5)
    })

    withTransaction(db, () => {
      const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(6)
      if (applied) return
      const activeDeliveries = (db.prepare(`
        SELECT COUNT(*) AS count FROM orders
        WHERE type = 'delivery' AND paid_at IS NULL AND voided_at IS NULL
      `).get() as { count: number }).count
      if (activeDeliveries > DELIVERY_SLOT_COUNT) {
        throw new Error(`Cannot migrate delivery slots: ${activeDeliveries} active delivery orders exceed the ${DELIVERY_SLOT_COUNT}-slot limit. Back up the database, use the previous BillMitra version to pay or void enough open delivery bills, then restart this version.`)
      }
      db.exec(`
        DROP INDEX one_delivery_number;
        UPDATE orders SET delivery_number = NULL
          WHERE type = 'delivery' AND paid_at IS NULL AND voided_at IS NULL;
        WITH numbered_active_deliveries AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, display_number) AS delivery_number
          FROM orders
          WHERE type = 'delivery' AND paid_at IS NULL AND voided_at IS NULL
        )
        UPDATE orders
        SET delivery_number = (
          SELECT delivery_number FROM numbered_active_deliveries WHERE numbered_active_deliveries.id = orders.id
        )
        WHERE id IN (SELECT id FROM numbered_active_deliveries WHERE delivery_number <= 100);
        CREATE UNIQUE INDEX one_active_delivery_slot ON orders(delivery_number)
          WHERE type = 'delivery' AND delivery_number IS NOT NULL
            AND paid_at IS NULL AND voided_at IS NULL;
      `)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(6)
    })

    withTransaction(db, () => {
      const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(7)
      if (applied) return
      const activeParcels = (db.prepare(`
        SELECT COUNT(*) AS count FROM orders
        WHERE type = 'parcel' AND paid_at IS NULL AND voided_at IS NULL
      `).get() as { count: number }).count
      if (activeParcels > PARCEL_SLOT_COUNT) {
        throw new Error(`Cannot migrate takeaway slots: ${activeParcels} active takeaway orders exceed the ${PARCEL_SLOT_COUNT}-slot limit. Back up the database, use the previous BillMitra version to pay or void enough open takeaway bills, then restart this version.`)
      }
      db.exec(`
        ALTER TABLE orders ADD COLUMN parcel_number INTEGER;
        WITH numbered_active_parcels AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, display_number) AS parcel_number
          FROM orders
          WHERE type = 'parcel' AND paid_at IS NULL AND voided_at IS NULL
        )
        UPDATE orders
        SET parcel_number = (
          SELECT parcel_number FROM numbered_active_parcels WHERE numbered_active_parcels.id = orders.id
        )
        WHERE id IN (SELECT id FROM numbered_active_parcels);
        CREATE UNIQUE INDEX one_active_parcel_slot ON orders(parcel_number)
          WHERE type = 'parcel' AND parcel_number IS NOT NULL
            AND paid_at IS NULL AND voided_at IS NULL;
      `)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(7)
    })

    withTransaction(db, () => {
      const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(8)
      if (applied) return
      db.exec(`
        ALTER TABLE orders ADD COLUMN scheduled_delivery_at TEXT;
        ALTER TABLE orders ADD COLUMN assigned_delivery_to TEXT NOT NULL DEFAULT '';
      `)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(8)
    })

    withTransaction(db, () => {
      const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(9)
      if (applied) return
      db.exec("ALTER TABLE orders ADD COLUMN contact_number TEXT NOT NULL DEFAULT '';")
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(9)
    })

    withTransaction(db, () => {
      const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(10)
      if (applied) return
      db.exec(staffSchemaMigration)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(10)
    })

    withTransaction(db, () => {
      const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(11)
      if (applied) return
      db.exec(deliverySchemaMigration)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(11)
    })
  }

  function getStaffAccessState(event: RequestContext): StaffAccessState {
    return staffAuth.getAccessState(event.sender.id)
  }

  function setupOwner(event: RequestContext, rawInput: unknown): StaffIdentity {
    return staffAuth.setupOwner(event.sender.id, rawInput)
  }

  function loginStaff(event: RequestContext, rawInput: unknown): StaffIdentity {
    return staffAuth.login(event.sender.id, rawInput)
  }

  function logoutStaff(event: RequestContext): void {
    staffAuth.logout(event.sender.id)
  }

  function requireStaffPermission(event: RequestContext, permission: StaffPermission): StaffIdentity {
    return staffAuth.requirePermission(event.sender.id, permission)
  }

  function listStaff(event: RequestContext): StaffIdentity[] {
    return staffAuth.listStaff(event.sender.id)
  }

  function createStaffUser(event: RequestContext, rawInput: unknown): StaffIdentity {
    return staffAuth.createStaff(event.sender.id, rawInput)
  }

  function listDeliverySchedule(event: RequestContext) {
    requireStaffPermission(event, 'delivery:view')
    return deliveryManagement.listSchedule()
  }

  function findSavedDeliveryCustomer(event: RequestContext, rawContactNumber: unknown) {
    requireStaffPermission(event, 'pos:access')
    return lookupSavedDeliveryCustomer(database, rawContactNumber)
  }

  function listDeliveryCustomers(event: RequestContext, rawQuery: unknown) {
    requireStaffPermission(event, 'pos:access')
    return lookupDeliveryCustomers(database, rawQuery)
  }

  function saveDeliveryCustomer(event: RequestContext, rawInput: unknown) {
    requireStaffPermission(event, 'pos:access')
    return withTransaction(database, () => persistDeliveryCustomer(database, rawInput))
  }

  function listDeliveryRiders(event: RequestContext) {
    requireStaffPermission(event, 'delivery:view')
    return deliveryManagement.listRiders()
  }

  function saveDeliveryRider(event: RequestContext, rawInput: unknown) {
    const actor = requireStaffPermission(event, 'delivery:riders')
    return deliveryManagement.saveRider(actor, rawInput)
  }

  function updateDeliverySchedule(event: RequestContext, rawInput: unknown): void {
    const actor = requireStaffPermission(event, 'delivery:operate')
    deliveryManagement.updateSchedule(actor, rawInput)
  }

  function assignDeliveryRider(event: RequestContext, rawInput: unknown): void {
    const actor = requireStaffPermission(event, 'delivery:assign')
    deliveryManagement.assignRider(actor, rawInput)
  }

  function assignDeliveryRiderBatch(event: RequestContext, rawInput: unknown): void {
    const actor = requireStaffPermission(event, 'delivery:assign')
    deliveryManagement.assignRiderBatch(actor, rawInput)
  }

  function operateDelivery(event: RequestContext, rawInput: unknown): void {
    const isCancellation = typeof rawInput === 'object' && rawInput !== null
      && 'kind' in rawInput && rawInput.kind === 'cancelled'
    const actor = requireStaffPermission(event, isCancellation ? 'delivery:cancel' : 'delivery:operate')
    deliveryManagement.operate(actor, rawInput)
  }

  function listDeliveryEvents(event: RequestContext, orderId: unknown) {
    requireStaffPermission(event, 'delivery:view')
    return deliveryManagement.listEvents(z.string().uuid().parse(orderId))
  }

  function createOrderForStaff(event: RequestContext, rawInput: unknown): SavedOrder {
    const actor = requireStaffPermission(event, 'orders:write')
    const input: CreateOrderInput = orderInputSchema.parse(rawInput)
    if (actor.role === 'waiter' && input.type !== 'dine_in') throw new Error('Waiter accounts can create table orders only.')
    const existingDiscount = input.orderId
      ? database.prepare(`
        SELECT discount_kind AS kind, discount_value AS value
        FROM orders WHERE id = ?
      `).get(input.orderId) as { kind: string; value: number } | undefined
      : undefined
    const requestedKind = input.discount?.kind ?? 'none'
    const requestedValue = input.discount?.kind === 'percentage'
      ? input.discount.valueBps
      : input.discount?.kind === 'fixed'
        ? input.discount.valuePaise
        : 0
    const discountChanged = !existingDiscount
      ? requestedKind !== 'none' && requestedValue > 0
      : existingDiscount.kind !== requestedKind || existingDiscount.value !== requestedValue
    if (discountChanged) requireStaffPermission(event, 'discount:apply')
    return createOrder(input, actor)
  }

  function voidOrderForStaff(event: RequestContext, rawInput: unknown): SavedOrder {
    const actor = requireStaffPermission(event, 'bill:void')
    return voidOrder(rawInput, actor)
  }

  function listCategories(): unknown[] {
    return database.prepare('SELECT id, name, sort_order AS sortOrder FROM categories ORDER BY sort_order').all()
  }

  function listProducts(): unknown[] {
    const products = database.prepare(`
      SELECT id, category_id AS categoryId, name, description, price_paise AS pricePaise,
        tax_rate_bps AS taxRateBps, available
      FROM products ORDER BY category_id, name
    `).all() as Array<{ available: number; [key: string]: unknown }>
    return products.map((product) => ({ ...product, available: product.available === 1 }))
  }

  function orderFromRow(orderId: string): SavedOrder | null {
    type OrderRow = Omit<SavedOrder, 'items' | 'discount' | 'status'> & {
      discountKind: 'none' | 'percentage' | 'fixed'
      discountValue: number
      status: OrderStatus
      paidAt: string | null
      voidedAt: string | null
    }
    const order = database.prepare(`
      SELECT id, display_number AS orderNumber, delivery_number AS deliveryNumber,
        parcel_number AS parcelNumber, scheduled_delivery_at AS scheduledDeliveryAt,
        scheduled_pickup_at AS scheduledPickupAt, actual_pickup_at AS actualPickupAt,
        ready_for_pickup_at AS readyForPickupAt,
        dispatched_at AS dispatchedAt, delivered_at AS deliveredAt,
        delivery_status AS deliveryStatus, delivery_rider_id AS deliveryRiderId,
        delivery_area AS deliveryArea, delivery_landmark AS deliveryLandmark,
        delivery_instructions AS deliveryInstructions,
        kitchen_message AS kitchenMessage,
        COALESCE(NULLIF(assigned_delivery_to, ''), (
          SELECT name FROM delivery_riders WHERE id = orders.delivery_rider_id
        ), '') AS assignedDeliveryTo, contact_number AS contactNumber, type,
        CASE WHEN joined_at IS NOT NULL THEN 'joined'
          WHEN voided_at IS NOT NULL THEN 'voided'
          WHEN paid_at IS NULL THEN status ELSE 'paid' END AS status,
        paid_at AS paidAt, table_id AS tableId,
        saved_at AS savedAt, saved_by AS savedBy, saved_table_name AS savedTableName, saved_table_floor AS savedTableFloor,
        voided_reason AS voidReason, voided_at AS voidedAt,
        customer_name AS customerName, delivery_address AS deliveryAddress,
        created_at AS createdAt, subtotal_paise AS subtotalPaise, tax_paise AS taxPaise,
        total_paise AS totalPaise, discount_kind AS discountKind,
        discount_value AS discountValue, discount_paise AS discountPaise
      FROM orders WHERE id = ?
    `).get(orderId) as OrderRow | undefined
    if (!order) return null

    const items = database.prepare(`
      SELECT id, product_id AS productId, product_name AS productName,
        unit_price_paise AS unitPricePaise, tax_rate_bps AS taxRateBps, quantity, note
      FROM order_items WHERE order_id = ? ORDER BY rowid
    `).all(orderId).map((item) => savedOrderItemSchema.parse(item))
    const discount: BillDiscount | null = order.discountKind === 'percentage'
      ? { kind: 'percentage', valueBps: order.discountValue }
      : order.discountKind === 'fixed'
        ? { kind: 'fixed', valuePaise: order.discountValue }
        : null
    return { ...order, discount, items }
  }

  function loadMenu() {
    const tables = database.prepare(`
      SELECT t.id, t.name, t.floor, t.capacity,
        o.id AS orderId, o.display_number AS orderNumber, o.total_paise AS amountPaise,
        o.created_at AS startedAt, o.status,
        (SELECT COUNT(*) FROM orders active
          WHERE active.table_id = t.id AND active.saved_at IS NULL
            AND active.status IN ('ordering', 'preparing', 'ready', 'payment_pending')
            AND active.paid_at IS NULL AND active.voided_at IS NULL AND active.joined_at IS NULL) AS activeOrderCount
      FROM restaurant_tables t
      LEFT JOIN orders o ON o.id = (
        SELECT latest.id FROM orders latest
        WHERE latest.table_id = t.id AND latest.saved_at IS NULL
          AND latest.status IN ('ordering', 'preparing', 'ready', 'payment_pending')
          AND latest.paid_at IS NULL AND latest.voided_at IS NULL AND latest.joined_at IS NULL
        ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
      )
      ORDER BY t.floor, t.name
    `).all() as Array<{
      id: string; name: string; floor: string; capacity: number; orderId: string | null
      orderNumber: number | null; amountPaise: number | null; startedAt: string | null; status: OrderStatus | null
      activeOrderCount: number
    }>
    const activeOrders = database.prepare(`
      SELECT id FROM orders WHERE (paid_at IS NULL OR (type='delivery' AND delivery_settled_at IS NULL)) AND voided_at IS NULL AND joined_at IS NULL
        AND status IN ('ordering', 'preparing', 'ready', 'payment_pending')
        AND (type <> 'delivery' OR delivery_status <> 'cancelled')
      ORDER BY created_at DESC
    `).all() as Array<{ id: string }>

    return {
      cardSettings: database.prepare('SELECT parcel_count AS parcelCount, delivery_count AS deliveryCount FROM card_settings WHERE id = 1').get() ?? { parcelCount: PARCEL_SLOT_COUNT, deliveryCount: DELIVERY_SLOT_COUNT },
      categories: listCategories(),
      products: listProducts(),
      tables: tables.map((table) => ({
        ...table,
        status: table.status ?? 'available',
      })),
      activeOrders: activeOrders.flatMap(({ id }) => {
        const order = orderFromRow(id)
        return order ? [order] : []
      }),
    }
  }

  function paymentFromRow(orderId: string): PaymentRecord | null {
    const row = database.prepare(`
      SELECT id, order_id AS orderId, method, amount_paise AS amountPaise, paid_at AS paidAt
      FROM payments WHERE order_id = ?
    `).get(orderId)
    return row ? paymentRecordSchema.parse(row) : null
  }

  function listBillHistory(): BillHistoryEntry[] {
    const orders = database.prepare(`
      SELECT id FROM orders ORDER BY COALESCE(paid_at, created_at) DESC, display_number DESC
    `).all() as Array<{ id: string }>
    return orders.flatMap(({ id }) => {
      const order = orderFromRow(id)
      return order ? [{ order, payment: paymentFromRow(id) }] : []
    })
  }

  function managerPinConfigured(): boolean {
    return Boolean(database.prepare('SELECT id FROM manager_credentials WHERE id = 1').get())
  }

  function setManagerPin(rawPin: unknown, actor: StaffIdentity): void {
    const pin = managerPinSchema.parse(rawPin)
    const { salt, hash } = createManagerPinHash(pin)
    withTransaction(database, () => {
      if (managerPinConfigured()) throw new Error('A manager PIN is already set on this device.')
      database.prepare('INSERT INTO manager_credentials (id, pin_salt, pin_hash) VALUES (1, ?, ?)').run(salt, hash)
      database.prepare(`
        INSERT INTO audit_log (id, action, entity_type, entity_id, actor, reason, details_json)
        VALUES (?, 'manager.pin_set', 'manager_credentials', ?, ?, 'initial_setup', '{}')
      `).run(randomUUID(), actor.id, actor.username)
    })
  }

  function authorizeManagement(rawPin: unknown, actor: StaffIdentity, action = 'management.opened'): void {
    const pin = managerPinSchema.parse(rawPin)
    const outcome = withTransaction(database, () => {
      const credential = database.prepare(`
        SELECT pin_salt AS salt, pin_hash AS hash, failed_attempts AS failedAttempts, locked_until AS lockedUntil
        FROM manager_credentials WHERE id = 1
      `).get() as { salt: string; hash: string; failedAttempts: number; lockedUntil: string | null } | undefined
      if (!credential) throw new Error('Ask the owner to set a manager PIN first.')
      if (credential.lockedUntil && new Date(`${credential.lockedUntil.replace(' ', 'T')}Z`).getTime() > Date.now()) {
        throw new Error('Manager PIN is temporarily locked after too many incorrect attempts. Try again later.')
      }
      if (!verifyManagerPin(pin, credential.salt, credential.hash)) {
        const attempts = (credential.lockedUntil ? 0 : credential.failedAttempts) + 1
        const lockedUntil = attempts >= 5 ? new Date(Date.now() + 5 * 60_000).toISOString().replace('T', ' ').slice(0, 19) : null
        database.prepare('UPDATE manager_credentials SET failed_attempts = ?, locked_until = ? WHERE id = 1')
          .run(lockedUntil ? 0 : attempts, lockedUntil)
        return { error: lockedUntil ? 'Too many incorrect PIN attempts. Try again in five minutes.' : 'Incorrect manager PIN.' } as const
      }
      database.prepare('UPDATE manager_credentials SET failed_attempts = 0, locked_until = NULL WHERE id = 1').run()
      database.prepare(`
        INSERT INTO audit_log (id, action, entity_type, entity_id, actor, reason, details_json)
        VALUES (?, ?, 'manager_credentials', ?, ?, 'manager_pin', '{}')
      `).run(randomUUID(), action, actor.id, actor.username)
      return { error: null } as const
    })
    if (outcome.error) throw new Error(outcome.error)
  }

  function cashOutDelivery(rawInput: unknown, actor: StaffIdentity): { order: SavedOrder; collectedPaise: number } {
    const input = deliveryCashOutSchema.parse(rawInput)
    authorizeManagement(input.pin, actor, 'delivery.cash_out_authorized')
    return withTransaction(database, () => {
      const prior = database.prepare('SELECT order_id AS orderId, collected_paise AS collectedPaise FROM delivery_bill_cashouts WHERE id=?')
        .get(input.requestId) as { orderId: string; collectedPaise: number } | undefined
      if (prior) {
        if (prior.orderId !== input.orderId || prior.collectedPaise !== input.expectedBalancePaise)
          throw new Error('This cash-out request was already used for another bill or amount.')
        const order = orderFromRow(input.orderId)
        if (!order) throw new Error('Bill not found.')
        return { order, collectedPaise: prior.collectedPaise }
      }
      const row = database.prepare(`SELECT type, delivery_number AS deliveryNumber, display_number AS orderNumber,
        delivery_status AS deliveryStatus, delivery_rider_id AS riderId, delivery_settled_at AS settledAt,
        voided_at AS voidedAt, joined_at AS joinedAt FROM orders WHERE id=?`).get(input.orderId) as {
          type: string; deliveryNumber: number | null; orderNumber: number; deliveryStatus: string;
          riderId: string | null; settledAt: string | null; voidedAt: string | null; joinedAt: string | null
        } | undefined
      if (!row || row.type !== 'delivery') throw new Error('Delivery bill not found.')
      if (row.voidedAt || row.joinedAt || row.settledAt) throw new Error('This HD card is already closed. Refresh the delivery board.')
      if (row.deliveryStatus === 'cancelled' || row.deliveryStatus === 'failed') throw new Error('A cancelled or failed delivery cannot be cashed out.')
      const ledger = financial.ledger(input.orderId)
      if (ledger.balancePaise !== input.expectedBalancePaise)
        throw new Error('The amount due changed. Close this dialog, refresh the bill, and check payment again.')
      if (ledger.balancePaise === 0 && !ledger.settled)
        throw new Error('This bill has no recorded payment. Check the bill total before closing its HD card.')
      if (ledger.balancePaise > 0) financial.collectInExistingTransaction(actor, {
        requestId: input.requestId, orderId: input.orderId, method: 'cash', amountPaise: ledger.balancePaise,
      })
      database.prepare(`INSERT INTO delivery_bill_cashouts(id,order_id,collected_paise,actor)
        VALUES(?,?,?,?)`).run(input.requestId, input.orderId, ledger.balancePaise, actor.username)
      const updated = database.prepare(`UPDATE orders SET delivery_settled_at=datetime('now'),
        delivery_status='delivered', delivered_at=COALESCE(delivered_at,datetime('now'))
        WHERE id=? AND delivery_settled_at IS NULL`).run(input.orderId)
      if (updated.changes !== 1) throw new Error('The HD card could not be closed. Refresh and try again.')
      if (row.deliveryStatus !== 'delivered') database.prepare(`INSERT INTO delivery_events
        (id,order_id,event_type,previous_status,new_status,previous_rider_id,new_rider_id,
          actor_id,actor,reason,details_json) VALUES(?,?,'delivered',?,'delivered',?,?,?,?,'manager_cash_out',?)`)
        .run(randomUUID(), input.orderId, row.deliveryStatus, row.riderId, row.riderId,
          actor.id, actor.username, JSON.stringify({ requestId: input.requestId }))
      database.prepare(`INSERT INTO audit_log(id,action,entity_type,entity_id,actor,reason,details_json)
        VALUES(?,'delivery.bill_cashed_out','order',?,?,'manager_pin',?)`)
        .run(randomUUID(), input.orderId, actor.username, JSON.stringify({
          requestId: input.requestId, orderNumber: row.orderNumber, deliveryNumber: row.deliveryNumber,
          riderId: row.riderId, collectedPaise: ledger.balancePaise, alreadyPaid: ledger.settled,
        }))
      const order = orderFromRow(input.orderId)
      if (!order) throw new Error('Cash-out completed but the bill could not be loaded.')
      return { order, collectedPaise: ledger.balancePaise }
    })
  }

  function resetManagerPin(rawInput: unknown, actor: StaffIdentity, senderId: number): void {
    if (actor.role !== 'owner') throw new Error('Only the owner can set a new manager PIN.')
    const input = z.object({ ownerPassword: z.string().min(1).max(128), pin: managerPinSchema }).strict().parse(rawInput)
    staffAuth.login(senderId, { username: actor.username, password: input.ownerPassword })
    const { salt, hash } = createManagerPinHash(input.pin)
    withTransaction(database, () => {
      database.prepare(`
        INSERT INTO manager_credentials (id, pin_salt, pin_hash, failed_attempts, locked_until)
        VALUES (1, ?, ?, 0, NULL)
        ON CONFLICT(id) DO UPDATE SET pin_salt=excluded.pin_salt, pin_hash=excluded.pin_hash,
          failed_attempts=0, locked_until=NULL
      `).run(salt, hash)
      database.prepare(`
        INSERT INTO audit_log (id, action, entity_type, entity_id, actor, reason, details_json)
        VALUES (?, 'manager.pin_reset', 'manager_credentials', ?, ?, 'owner_password_confirmed', '{}')
      `).run(randomUUID(), actor.id, actor.username)
    })
  }

  function voidOrder(rawInput: unknown, actor: StaffIdentity): SavedOrder {
    const input = voidOrderSchema.parse(rawInput)
    const outcome = withTransaction(database, () => {
      const credential = database.prepare(`
        SELECT pin_salt AS salt, pin_hash AS hash, failed_attempts AS failedAttempts, locked_until AS lockedUntil
        FROM manager_credentials WHERE id = 1
      `).get() as { salt: string; hash: string; failedAttempts: number; lockedUntil: string | null } | undefined
      if (!credential) throw new Error('Set a manager PIN on this device before voiding bills.')
      if (credential.lockedUntil && new Date(`${credential.lockedUntil.replace(' ', 'T')}Z`).getTime() > Date.now()) {
        throw new Error('Manager PIN is temporarily locked after too many incorrect attempts. Try again later.')
      }

      if (!verifyManagerPin(input.pin, credential.salt, credential.hash)) {
        const failedAttempts = credential.lockedUntil ? 0 : credential.failedAttempts
        const nextAttempts = failedAttempts + 1
        const lockedUntil = nextAttempts >= 5 ? new Date(Date.now() + 5 * 60_000).toISOString().replace('T', ' ').slice(0, 19) : null
        database.prepare(`
          UPDATE manager_credentials SET failed_attempts = ?, locked_until = ? WHERE id = 1
        `).run(lockedUntil ? 0 : nextAttempts, lockedUntil)
        return { error: lockedUntil ? 'Too many incorrect PIN attempts. Try again in five minutes.' : 'Incorrect manager PIN.' } as const
      }

      database.prepare('UPDATE manager_credentials SET failed_attempts = 0, locked_until = NULL WHERE id = 1').run()
      const order = database.prepare(`
        SELECT display_number AS orderNumber, total_paise AS totalPaise, paid_at AS paidAt,
          voided_at AS voidedAt
        FROM orders WHERE id = ?
      `).get(input.orderId) as { orderNumber: number; totalPaise: number; paidAt: string | null; voidedAt: string | null } | undefined
      if (!order) throw new Error('Bill not found.')
      if (financial.hasUnrefundedPayments(input.orderId)) throw new Error('Refund collected payments before voiding this bill.')
      if (order.paidAt) throw new Error('A paid bill cannot be voided. Use the refund workflow when available.')
      if (order.voidedAt) throw new Error('This bill has already been voided.')

      const updated = database.prepare(`
        UPDATE orders SET voided_at = datetime('now'), voided_reason = ?
        WHERE id = ? AND paid_at IS NULL AND voided_at IS NULL
      `).run(input.reason, input.orderId)
      if (updated.changes !== 1) throw new Error('Bill could not be voided. Refresh bill history and try again.')
      database.prepare(`
        INSERT INTO audit_log (id, action, entity_type, entity_id, actor, reason, details_json)
        VALUES (?, 'bill.voided', 'order', ?, ?, ?, ?)
      `).run(randomUUID(), input.orderId, actor.username, input.reason, JSON.stringify({
        orderNumber: order.orderNumber,
        totalPaise: order.totalPaise,
        staffRole: actor.role,
        managerPinAuthorized: true,
      }))
      return { order: orderFromRow(input.orderId) }
    })
    if ('error' in outcome) throw new Error(outcome.error)
    if (!outcome.order) throw new Error('Bill was voided but could not be loaded.')
    return outcome.order
  }

  function voidOrderItem(rawInput: unknown, actor: StaffIdentity): SavedOrder {
    const input = voidOrderItemSchema.parse(rawInput)
    const outcome = withTransaction(database, () => {
      const credential = database.prepare(`SELECT pin_salt AS salt, pin_hash AS hash,
        failed_attempts AS failedAttempts, locked_until AS lockedUntil FROM manager_credentials WHERE id=1`).get() as
        { salt: string; hash: string; failedAttempts: number; lockedUntil: string | null } | undefined
      if (!credential) throw new Error('Set a manager PIN on this device before voiding items.')
      if (credential.lockedUntil && new Date(`${credential.lockedUntil.replace(' ', 'T')}Z`).getTime() > Date.now())
        throw new Error('Manager PIN is temporarily locked after too many incorrect attempts. Try again later.')
      if (!verifyManagerPin(input.pin, credential.salt, credential.hash)) {
        const attempts = (credential.lockedUntil ? 0 : credential.failedAttempts) + 1
        const lockedUntil = attempts >= 5 ? new Date(Date.now() + 5 * 60_000).toISOString().replace('T', ' ').slice(0, 19) : null
        database.prepare('UPDATE manager_credentials SET failed_attempts=?, locked_until=? WHERE id=1').run(lockedUntil ? 0 : attempts, lockedUntil)
        return { error: lockedUntil ? 'Too many incorrect PIN attempts. Try again in five minutes.' : 'Incorrect manager PIN.' } as const
      }
      database.prepare('UPDATE manager_credentials SET failed_attempts=0, locked_until=NULL WHERE id=1').run()
      const order = database.prepare(`SELECT display_number AS orderNumber, paid_at AS paidAt, voided_at AS voidedAt,
        discount_kind AS discountKind, discount_value AS discountValue FROM orders WHERE id=?`).get(input.orderId) as {
          orderNumber: number; paidAt: string | null; voidedAt: string | null; discountKind: 'none' | 'percentage' | 'fixed'; discountValue: number
        } | undefined
      if (!order) throw new Error('Bill not found.')
      if (financial.hasUnrefundedPayments(input.orderId) || order.paidAt) throw new Error('Refund collected payments before voiding bill items.')
      if (order.voidedAt) throw new Error('A voided bill cannot be changed.')
      const item = database.prepare(`SELECT id, product_id AS productId, product_name AS productName,
        unit_price_paise AS unitPricePaise, tax_rate_bps AS taxRateBps, quantity, note
        FROM order_items WHERE id=? AND order_id=?`).get(input.itemId, input.orderId) as {
          id: string; productId: string; productName: string; unitPricePaise: number; taxRateBps: number; quantity: number; note: string
        } | undefined
      if (!item) throw new Error('This item is no longer on the bill. Refresh and try again.')
      if (input.quantity > item.quantity) throw new Error('Cannot void more than the ordered quantity.')
      const totalItems = (database.prepare('SELECT COUNT(*) AS count FROM order_items WHERE order_id=?').get(input.orderId) as { count: number }).count
      if (totalItems === 1 && input.quantity === item.quantity) throw new Error('Use Void bill to remove the final item from this bill.')
      const voidId = randomUUID()
      database.prepare(`INSERT INTO order_item_voids(id,order_id,item_id,product_id,product_name,unit_price_paise,
        tax_rate_bps,quantity,note,reason,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).run(
          voidId, input.orderId, item.id, item.productId, item.productName, item.unitPricePaise,
          item.taxRateBps, input.quantity, item.note, input.reason, actor.username)
      if (input.quantity === item.quantity) database.prepare('DELETE FROM order_items WHERE id=? AND order_id=?').run(item.id, input.orderId)
      else database.prepare('UPDATE order_items SET quantity=quantity-? WHERE id=? AND order_id=?').run(input.quantity, item.id, input.orderId)
      const discount: BillDiscount | null = order.discountKind === 'percentage' ? { kind: 'percentage', valueBps: order.discountValue }
        : order.discountKind === 'fixed' ? { kind: 'fixed', valuePaise: order.discountValue } : null
      const lines = database.prepare('SELECT unit_price_paise AS unitPricePaise, quantity, tax_rate_bps AS taxRateBps FROM order_items WHERE order_id=?').all(input.orderId) as
        Array<{ unitPricePaise: number; quantity: number; taxRateBps: number }>
      const safeDiscount = discount?.kind === 'fixed' && discount.valuePaise > lines.reduce((sum, line) => sum + line.unitPricePaise * line.quantity, 0)
        ? { kind: 'fixed' as const, valuePaise: lines.reduce((sum, line) => sum + line.unitPricePaise * line.quantity, 0) }
        : discount
      const totals = calculateTotals(lines, safeDiscount)
      database.prepare(`UPDATE orders SET subtotal_paise=?,tax_paise=?,total_paise=?,discount_kind=?,discount_value=?,discount_paise=? WHERE id=?`).run(
        totals.subtotalPaise, totals.taxPaise, totals.totalPaise, safeDiscount?.kind ?? 'none',
        safeDiscount?.kind === 'percentage' ? safeDiscount.valueBps : safeDiscount?.kind === 'fixed' ? safeDiscount.valuePaise : 0,
        totals.discountPaise, input.orderId)
      database.prepare(`INSERT INTO audit_log(id,action,entity_type,entity_id,actor,reason,details_json)
        VALUES(?,'bill.item_voided','order_item_void',?,?,?,?)`).run(randomUUID(), voidId, actor.username, input.reason,
          JSON.stringify({ orderNumber: order.orderNumber, itemId: item.id, productName: item.productName, quantity: input.quantity, managerPinAuthorized: true }))
      return { order: orderFromRow(input.orderId) }
    })
    if ('error' in outcome) throw new Error(outcome.error)
    if (!outcome.order) throw new Error('Item was voided but the bill could not be loaded.')
    return outcome.order
  }

  function splitOrder(rawInput: unknown, actor: StaffIdentity): SplitOrderResult {
    const input: SplitOrderInput = splitOrderSchema.parse(rawInput)
    return withTransaction(database, () => {
      const prior = database.prepare('SELECT source_order_id AS sourceOrderId, split_order_id AS splitOrderId FROM order_splits WHERE request_id=?').get(input.requestId) as { sourceOrderId: string; splitOrderId: string } | undefined
      if (prior) {
        const source = orderFromRow(prior.sourceOrderId); const split = orderFromRow(prior.splitOrderId)
        if (!source || !split) throw new Error('The previously split bills could not be loaded.')
        return { source, split }
      }
      const source = orderFromRow(input.orderId)
      if (!source || source.type !== 'dine_in' || !source.tableId || source.savedAt || !orderStatusValues.includes(source.status)) {
        throw new Error('Select an unpaid active dine-in bill to split.')
      }
      if (financial.hasUnrefundedPayments(source.id)) throw new Error('Refund collected payments before splitting this bill.')
      const requested = new Map<string, number>()
      for (const line of input.items) {
        if (requested.has(line.itemId)) throw new Error('Select each bill item only once.')
        requested.set(line.itemId, line.quantity)
      }
      const sourceLines = source.items.map(item => ({ ...item }))
      const splitLines = sourceLines.flatMap(item => {
        const quantity = requested.get(item.id)
        if (!quantity) return []
        if (quantity > item.quantity) throw new Error(`Cannot split more than ${item.quantity} of ${item.productName}.`)
        return [{ ...item, quantity }]
      })
      if (splitLines.length !== requested.size) throw new Error('One or more selected items are no longer on this bill. Refresh and retry.')
      const remainingLines = sourceLines.flatMap(item => {
        const moved = requested.get(item.id) ?? 0
        return item.quantity > moved ? [{ ...item, quantity: item.quantity - moved }] : []
      })
      if (!remainingLines.length) throw new Error('Leave at least one item on the original bill. Use a new bill instead.')
      const sourceSubtotal = sourceLines.reduce((sum, item) => sum + item.unitPricePaise * item.quantity, 0)
      const splitSubtotal = splitLines.reduce((sum, item) => sum + item.unitPricePaise * item.quantity, 0)
      const splitDiscount: BillDiscount | null = source.discount?.kind === 'percentage'
        ? source.discount
        : source.discount?.kind === 'fixed'
          ? { kind: 'fixed', valuePaise: Math.floor(source.discount.valuePaise * splitSubtotal / sourceSubtotal) }
          : null
      const sourceDiscount: BillDiscount | null = source.discount?.kind === 'percentage'
        ? source.discount
        : source.discount?.kind === 'fixed'
          ? { kind: 'fixed', valuePaise: source.discount.valuePaise - (splitDiscount?.kind === 'fixed' ? splitDiscount.valuePaise : 0) }
          : null
      const sourceTotals = calculateTotals(remainingLines, sourceDiscount)
      const splitTotals = calculateTotals(splitLines, splitDiscount)
      const splitId = randomUUID()
      const displayNumber = (database.prepare('SELECT COALESCE(MAX(display_number), 0) + 1 AS next FROM orders').get() as { next: number }).next
      const discountFields = (discount: BillDiscount | null, totals: ReturnType<typeof calculateTotals>) => [
        totals.subtotalPaise, totals.taxPaise, totals.totalPaise,
        discount?.kind ?? 'none', discount?.kind === 'percentage' ? discount.valueBps : discount?.kind === 'fixed' ? discount.valuePaise : 0,
        totals.discountPaise,
      ]
      database.prepare(`INSERT INTO orders (id, display_number, type, status, table_id, customer_name, delivery_address,
        request_id, subtotal_paise, tax_paise, total_paise, discount_kind, discount_value, discount_paise)
        VALUES (?, ?, 'dine_in', ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?)`)
        .run(splitId, displayNumber, source.status, source.tableId, input.requestId, ...discountFields(splitDiscount, splitTotals))
      const insertItem = database.prepare(`INSERT INTO order_items (id, order_id, product_id, product_name, unit_price_paise, tax_rate_bps, quantity, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const item of splitLines) insertItem.run(randomUUID(), splitId, item.productId, item.productName, item.unitPricePaise, item.taxRateBps, item.quantity, item.note)
      const updateQuantity = database.prepare('UPDATE order_items SET quantity=? WHERE id=? AND order_id=?')
      const deleteItem = database.prepare('DELETE FROM order_items WHERE id=? AND order_id=?')
      for (const item of sourceLines) {
        const moved = requested.get(item.id) ?? 0
        if (!moved) continue
        if (moved === item.quantity) deleteItem.run(item.id, source.id)
        else updateQuantity.run(item.quantity - moved, item.id, source.id)
      }
      database.prepare(`UPDATE orders SET subtotal_paise=?, tax_paise=?, total_paise=?, discount_kind=?, discount_value=?, discount_paise=? WHERE id=?`)
        .run(...discountFields(sourceDiscount, sourceTotals), source.id)
      database.prepare(`INSERT INTO order_splits(id, request_id, source_order_id, split_order_id, actor)
        VALUES (?, ?, ?, ?, ?)`)
        .run(randomUUID(), input.requestId, source.id, splitId, actor.username)
      database.prepare(`INSERT INTO audit_log(id, action, entity_type, entity_id, actor, reason, details_json) VALUES
        (?, 'order.split', 'order', ?, ?, 'split_bill', ?), (?, 'order.split_from', 'order', ?, ?, 'split_bill', ?)`)
        .run(randomUUID(), splitId, actor.username, JSON.stringify({ sourceOrderId: source.id, items: splitLines.map(item => ({ itemId: item.id, quantity: item.quantity })) }),
          randomUUID(), source.id, actor.username, JSON.stringify({ splitOrderId: splitId }))
      const updatedSource = orderFromRow(source.id); const split = orderFromRow(splitId)
      if (!updatedSource || !split) throw new Error('Split bills could not be loaded after saving.')
      return { source: updatedSource, split }
    })
  }

  function joinOrders(rawInput: unknown, actor: StaffIdentity): SavedOrder {
    const input: JoinOrdersInput = joinOrdersSchema.parse(rawInput)
    if (new Set(input.orderIds).size !== input.orderIds.length) throw new Error('Choose different bills to join.')
    return withTransaction(database, () => {
      const previous = database.prepare('SELECT joined_order_id AS orderId FROM order_joins WHERE request_id=?').get(input.requestId) as { orderId: string } | undefined
      if (previous) {
        const order = orderFromRow(previous.orderId)
        if (!order) throw new Error('The previously joined bill could not be loaded.')
        return order
      }
      const orders = input.orderIds.map(id => orderFromRow(id))
      if (orders.some(order => !order)) throw new Error('One or more selected bills no longer exist.')
      const source = orders as SavedOrder[]
      if (source.some(order => order.type !== 'dine_in' || !order.tableId || order.savedAt || !orderStatusValues.includes(order.status))) {
        throw new Error('Only unpaid active dine-in bills can be joined.')
      }
      if (source.some(order => financial.hasUnrefundedPayments(order.id))) throw new Error('Refund collected payments before joining bills.')
      const tableId = source[0].tableId!
      const lines = source.flatMap(order => order.items)
      const subtotal = lines.reduce((sum, item) => sum + item.unitPricePaise * item.quantity, 0)
      const samePercentage = source.every(order => order.discount?.kind === 'percentage')
        && source.every(order => (order.discount?.kind === 'percentage' ? order.discount.valueBps : 0) === (source[0].discount?.kind === 'percentage' ? source[0].discount.valueBps : 0))
      const discount: BillDiscount | null = samePercentage && source[0].discount?.kind === 'percentage'
        ? source[0].discount
        : (() => { const amount = source.reduce((sum, order) => sum + order.discountPaise, 0); return amount ? { kind: 'fixed' as const, valuePaise: Math.min(amount, subtotal) } : null })()
      const totals = calculateTotals(lines, discount)
      const joinedId = randomUUID()
      const displayNumber = (database.prepare('SELECT COALESCE(MAX(display_number), 0) + 1 AS next FROM orders').get() as { next: number }).next
      const status: OrderStatus = source.some(order => order.status === 'preparing') ? 'preparing'
        : source.every(order => order.status === 'ready') ? 'ready' : 'ordering'
      database.prepare(`INSERT INTO orders (id, display_number, type, status, table_id, customer_name, delivery_address,
        request_id, subtotal_paise, tax_paise, total_paise, discount_kind, discount_value, discount_paise)
        VALUES (?, ?, 'dine_in', ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?)`)
        .run(joinedId, displayNumber, status, tableId, input.requestId, totals.subtotalPaise, totals.taxPaise, totals.totalPaise,
          discount?.kind ?? 'none', discount?.kind === 'percentage' ? discount.valueBps : discount?.kind === 'fixed' ? discount.valuePaise : 0, totals.discountPaise)
      const addItem = database.prepare(`INSERT INTO order_items(id,order_id,product_id,product_name,unit_price_paise,tax_rate_bps,quantity,note)
        VALUES(?,?,?,?,?,?,?,?)`)
      for (const item of lines) addItem.run(randomUUID(), joinedId, item.productId, item.productName, item.unitPricePaise, item.taxRateBps, item.quantity, item.note)
      const archive = database.prepare("UPDATE orders SET joined_at=datetime('now'), joined_into_order_id=? WHERE id=? AND joined_at IS NULL")
      const moveTickets = database.prepare('UPDATE kitchen_tickets SET order_id=? WHERE order_id=?')
      for (const order of source) { archive.run(joinedId, order.id); moveTickets.run(joinedId, order.id) }
      database.prepare('INSERT INTO order_joins(id,request_id,source_order_ids_json,joined_order_id,actor) VALUES(?,?,?,?,?)')
        .run(randomUUID(), input.requestId, JSON.stringify(source.map(order => order.id)), joinedId, actor.username)
      database.prepare(`INSERT INTO audit_log(id,action,entity_type,entity_id,actor,reason,details_json) VALUES
        (?, 'order.joined', 'order', ?, ?, 'joined_bill', ?)`)
        .run(randomUUID(), joinedId, actor.username, JSON.stringify({ sourceOrderIds: source.map(order => order.id), sourceOrderNumbers: source.map(order => order.orderNumber) }))
      const joined = orderFromRow(joinedId)
      if (!joined) throw new Error('The joined bill could not be loaded.')
      return joined
    })
  }

  function recordDuplicateKotRequest(rawOrderId: unknown, actor: StaffIdentity): void {
    const orderId = z.string().uuid().parse(rawOrderId)
    withTransaction(database, () => {
      const order = database.prepare(`
        SELECT display_number AS orderNumber, paid_at AS paidAt, voided_at AS voidedAt
        FROM orders WHERE id = ?
      `).get(orderId) as { orderNumber: number; paidAt: string | null; voidedAt: string | null } | undefined
      if (!order) throw new Error('Saved order not found.')
      if (order.voidedAt) throw new Error('A voided bill cannot be sent to the kitchen.')
      if (order.paidAt) throw new Error('A paid bill cannot be sent to the kitchen.')
      database.prepare(`
        INSERT INTO audit_log (id, action, entity_type, entity_id, actor, reason, details_json)
        VALUES (?, 'kitchen.kot_duplicate_requested', 'order', ?, ?, 'duplicate_requested', ?)
      `).run(randomUUID(), orderId, actor.username, JSON.stringify({ orderNumber: order.orderNumber, staffRole: actor.role }))
    })
  }

  function recordPayment(rawInput: unknown, actor: StaffIdentity): PaymentRecord {
    const input: RecordPaymentInput = paymentInputSchema.parse(rawInput)
    financial.collect(actor, input)
    const saved = paymentFromRow(input.orderId)
    if (!saved) throw new Error('Payment was recorded but could not be loaded.')
    return saved
  }
  function createOrder(rawInput: unknown, actor: StaffIdentity): SavedOrder {
    const input: CreateOrderInput = orderInputSchema.parse(rawInput)
    if (input.items.length === 0 && !input.orderId) {
      throw new Error('Add at least one item before saving an invoice.')
    }
    if (input.type === 'dine_in' && !input.tableId) {
      throw new Error('Choose a table for dine-in orders.')
    }
    if (input.type !== 'dine_in' && input.tableId) {
      throw new Error('Only dine-in orders can be assigned to a table.')
    }
    if (input.type === 'delivery' && (input.deliveryNumber == null || !isValidDeliveryNumber(input.deliveryNumber))) {
      throw new Error('Select an HD delivery slot from 1 to 100 before saving.')
    }
    if (input.type !== 'delivery' && input.deliveryNumber != null) {
      throw new Error('Only home-delivery orders can use an HD delivery slot.')
    }
    if (input.type === 'parcel' && (input.parcelNumber == null || !isValidParcelNumber(input.parcelNumber))) {
      throw new Error('Select a P takeaway slot from 1 to 100 before saving.')
    }
    if (input.type !== 'parcel' && input.parcelNumber != null) {
      throw new Error('Only takeaway orders can use a P slot.')
    }
    if (input.type !== 'delivery' && (input.scheduledDeliveryAt != null || input.assignedDeliveryTo?.trim())) {
      throw new Error('Only home-delivery orders can have a delivery schedule or courier assignment.')
    }
    if (input.type !== 'delivery' && (input.deferKitchenTicket || input.prepareKitchenTicket)) {
      throw new Error('Only home-delivery orders can defer or prepare a delivery KOT.')
    }
    if (input.type === 'delivery' && input.assignedDeliveryTo?.trim()) {
      throw new Error('Assign delivery riders from the saved delivery schedule.')
    }
    if (input.type !== 'delivery' && (input.scheduledPickupAt != null
      || (input.type !== 'parcel' && input.deliveryArea) || input.deliveryLandmark || input.deliveryInstructions)) {
      throw new Error('Only home-delivery orders can have delivery details.')
    }
    if (input.type === 'delivery' && input.orderId && (!input.contactNumber?.trim() || !input.deliveryAddress.trim())) {
      throw new Error('Enter the customer contact number and delivery address for delivery orders.')
    }
    return withTransaction(database, () => {
      const prior = database.prepare(`
        SELECT id FROM orders WHERE request_id = ?
        UNION ALL SELECT order_id AS id FROM order_requests WHERE request_id = ?
        LIMIT 1
      `).get(input.requestId, input.requestId) as { id: string } | undefined
      if (prior) {
        const existing = orderFromRow(prior.id)
        if (!existing) throw new Error('The previously saved order could not be loaded.')
        return existing
      }

      let orderId = input.orderId
      let previousKitchenMessage = ''
      if (orderId && orderFromRow(orderId)?.savedAt) throw new Error('This bill is saved for the cashier. Refresh tables before adding items.')
      if (orderId && financial.hasUnrefundedPayments(orderId)) throw new Error('Bills with collected payments cannot be edited. Refund open-bill payments first.')
      if (orderId) {
        const existingOrder = database.prepare(`
          SELECT id, status, type, table_id AS tableId, delivery_number AS deliveryNumber, parcel_number AS parcelNumber,
            paid_at AS paidAt, voided_at AS voidedAt, customer_name AS customerName,
            contact_number AS contactNumber, delivery_address AS deliveryAddress,
            delivery_area AS deliveryArea, delivery_landmark AS deliveryLandmark,
            delivery_instructions AS deliveryInstructions, kitchen_message AS kitchenMessage
          FROM orders WHERE id = ?
        `).get(orderId) as {
          id: string; status: OrderStatus; type: OrderType; tableId: string | null; deliveryNumber: number | null
          parcelNumber: number | null; paidAt: string | null; voidedAt: string | null
          customerName: string; contactNumber: string; deliveryAddress: string
          deliveryArea: string; deliveryLandmark: string; deliveryInstructions: string; kitchenMessage: string
        } | undefined
        if (!existingOrder || existingOrder.paidAt || existingOrder.voidedAt || !orderStatusValues.includes(existingOrder.status)) {
          throw new Error('This order is no longer open. Refresh the table before adding items.')
        }
        previousKitchenMessage = existingOrder.kitchenMessage
        if (existingOrder.type !== input.type || existingOrder.tableId !== input.tableId
          || (input.type === 'delivery' && existingOrder.deliveryNumber !== input.deliveryNumber)
          || (input.type === 'parcel' && existingOrder.parcelNumber !== input.parcelNumber)) {
          throw new Error('The order type or service slot changed. Refresh the active order before saving.')
        }
        const updatedDeliveryDetails = database.prepare(`
          UPDATE orders SET customer_name = ?, contact_number = ?, delivery_address = ?,
            delivery_area = ?, delivery_landmark = ?, delivery_instructions = ?, kitchen_message = ?
          WHERE id = ? AND type IN ('delivery', 'parcel') AND paid_at IS NULL AND voided_at IS NULL
        `).run(input.customerName, input.contactNumber ?? '', input.deliveryAddress,
          input.deliveryArea ?? '', input.deliveryLandmark ?? '', input.deliveryInstructions ?? '', input.kitchenMessage ?? existingOrder.kitchenMessage, orderId)
        if ((input.type === 'delivery' || input.type === 'parcel') && updatedDeliveryDetails.changes !== 1) {
          throw new Error('Customer details could not be saved because the order is no longer open.')
        }
        if (input.type === 'dine_in') database.prepare('UPDATE orders SET kitchen_message = ? WHERE id = ?')
          .run(input.kitchenMessage ?? existingOrder.kitchenMessage, orderId)
        if (input.type === 'delivery') {
          deliveryManagement.recordCustomerDetailsUpdated(actor, orderId, {
            customerName: existingOrder.customerName,
            contactNumber: existingOrder.contactNumber,
            deliveryAddress: existingOrder.deliveryAddress,
            deliveryArea: existingOrder.deliveryArea,
            deliveryLandmark: existingOrder.deliveryLandmark,
            deliveryInstructions: existingOrder.deliveryInstructions,
          }, {
            customerName: input.customerName,
            contactNumber: input.contactNumber ?? '',
            deliveryAddress: input.deliveryAddress,
            deliveryArea: input.deliveryArea ?? '',
            deliveryLandmark: input.deliveryLandmark ?? '',
            deliveryInstructions: input.deliveryInstructions ?? '',
          })
        }
      } else {
        orderId = randomUUID()
        const displayNumber = (database.prepare('SELECT COALESCE(MAX(display_number), 0) + 1 AS next FROM orders').get() as { next: number }).next
        const deliveryNumber = input.type === 'delivery' ? input.deliveryNumber ?? null : null
        if (deliveryNumber !== null) {
          const occupiedSlot = database.prepare(`
            SELECT id FROM orders WHERE type = 'delivery' AND delivery_number = ?
              AND delivery_settled_at IS NULL AND voided_at IS NULL AND delivery_status <> 'cancelled'
          `).get(deliveryNumber)
          if (occupiedSlot) throw new Error(`HD-${deliveryNumber} is already in use. Select another delivery slot.`)
        }
        const parcelNumber = input.type === 'parcel' ? input.parcelNumber ?? null : null
        if (parcelNumber !== null) {
          const occupiedSlot = database.prepare(`
            SELECT id FROM orders WHERE type = 'parcel' AND parcel_number = ?
              AND paid_at IS NULL AND voided_at IS NULL
          `).get(parcelNumber)
          if (occupiedSlot) throw new Error(`P-${parcelNumber} is already in use. Select another takeaway slot.`)
        }
        database.prepare(`
          INSERT INTO orders (id, display_number, type, status, table_id, customer_name, delivery_address,
            request_id, subtotal_paise, tax_paise, total_paise, discount_kind, discount_value, discount_paise,
            delivery_number, parcel_number, scheduled_delivery_at, assigned_delivery_to, contact_number,
            scheduled_pickup_at, delivery_area, delivery_landmark, delivery_instructions, kitchen_message)
          VALUES (?, ?, ?, 'ordering', ?, ?, ?, ?, 0, 0, 0, 'none', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(orderId, displayNumber, input.type, input.tableId, input.customerName, input.deliveryAddress, input.requestId,
          deliveryNumber, parcelNumber, input.scheduledDeliveryAt ?? null, '',
          input.contactNumber ?? '', input.scheduledPickupAt ?? null, input.deliveryArea ?? '', input.deliveryLandmark ?? '',
          input.deliveryInstructions ?? '', input.kitchenMessage ?? '')
      }

      const selectProduct = database.prepare(`
        SELECT id, name, price_paise AS pricePaise, tax_rate_bps AS taxRateBps
        FROM products WHERE id = ? AND available = 1
      `)
      const addLine = database.prepare(`
        INSERT INTO order_items (id, order_id, product_id, product_name, unit_price_paise,
          tax_rate_bps, quantity, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const item of input.items) {
        const product = selectProduct.get(item.productId) as {
          id: string; name: string; pricePaise: number; taxRateBps: number
        } | undefined
        if (!product) throw new Error('A selected product is no longer available. Refresh the menu and try again.')
        addLine.run(randomUUID(), orderId, product.id, product.name, product.pricePaise, product.taxRateBps, item.quantity, item.note)
      }

      const totals = calculateTotals(database.prepare(`
        SELECT unit_price_paise AS unitPricePaise, quantity, tax_rate_bps AS taxRateBps
        FROM order_items WHERE order_id = ?
      `).all(orderId) as Array<{ unitPricePaise: number; quantity: number; taxRateBps: number }>, input.discount)
      const discountKind = input.discount?.kind ?? 'none'
      const discountValue = input.discount?.kind === 'percentage'
        ? input.discount.valueBps
        : input.discount?.kind === 'fixed'
          ? input.discount.valuePaise
          : 0
      database.prepare(`
        UPDATE orders SET subtotal_paise = ?, tax_paise = ?, total_paise = ?,
          discount_kind = ?, discount_value = ?, discount_paise = ? WHERE id = ?
      `).run(totals.subtotalPaise, totals.taxPaise, totals.totalPaise,
        discountKind, discountValue, totals.discountPaise, orderId)

      database.prepare(`
        INSERT INTO invoice_discount_history (id, order_id, request_id, discount_kind, discount_value, discount_paise)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), orderId, input.requestId, discountKind, discountValue, totals.discountPaise)

      if (input.orderId) {
        database.prepare('INSERT INTO order_requests (request_id, order_id) VALUES (?, ?)').run(input.requestId, orderId)
      }
      const saved = orderFromRow(orderId)
      if (!saved) throw new Error('The order was saved but could not be read back.')
      if (input.type === 'delivery' || input.type === 'parcel') {
        upsertCustomerProfile(database, {
          orderId,
          customerName: input.customerName,
          contactNumber: input.contactNumber ?? '',
          deliveryAddress: input.type === 'delivery' ? input.deliveryAddress : undefined,
          deliveryArea: input.type === 'delivery' || input.type === 'parcel' ? input.deliveryArea : undefined,
          deliveryLandmark: input.type === 'delivery' ? input.deliveryLandmark : undefined,
          deliveryInstructions: input.type === 'delivery' ? input.deliveryInstructions : undefined,
        })
      }
      if ((input.items.length || input.prepareKitchenTicket || (input.orderId && previousKitchenMessage !== saved.kitchenMessage)) && !input.deferKitchenTicket) {
        const ticketed = new Set<string>()
        const previousTickets = database.prepare('SELECT items_json AS itemsJson FROM kitchen_tickets WHERE order_id = ?')
          .all(orderId) as Array<{ itemsJson: string }>
        for (const ticket of previousTickets) {
          const lines = JSON.parse(ticket.itemsJson) as Array<{ id: string }>
          for (const line of lines) ticketed.add(line.id)
        }
        const pendingLines = saved.items.filter(item => !ticketed.has(item.id))
        if (pendingLines.length || (input.orderId && previousKitchenMessage !== saved.kitchenMessage && saved.kitchenMessage)) database.prepare(`INSERT INTO kitchen_tickets(id,order_id,status,items_json) VALUES(?,?,'ordering',?)`)
          .run(randomUUID(), orderId, JSON.stringify(pendingLines))
      }
      if (input.items.length) {
        database.prepare("UPDATE orders SET status = 'ordering' WHERE id = ?").run(orderId)
        saved.status = 'ordering'
      }
      database.prepare(`
        INSERT INTO audit_log (id, action, entity_type, entity_id, actor, reason, details_json)
        VALUES (?, ?, 'order', ?, ?, ?, ?)
      `).run(randomUUID(), input.orderId ? 'order.updated' : 'order.created', orderId, actor.username,
        input.orderId ? 'cashier_bill_update' : 'cashier_bill_created', JSON.stringify({
          staffRole: actor.role,
          orderType: saved.type,
          totalPaise: saved.totalPaise,
          discountPaise: saved.discountPaise,
        }))
      recordOrderLifecycleEvent(database, orderId, input.orderId ? 'order.updated' : 'order.created', actor.username,
        'cashier', { orderType: saved.type, totalPaise: saved.totalPaise, discountPaise: saved.discountPaise })
      if (input.type === 'delivery' && input.whatsappBillOptIn && !input.deferKitchenTicket
        && (input.prepareKitchenTicket || !input.orderId)) deliveryWhatsApp.queue(saved)
      if (input.type === 'dine_in' && input.tableId) customerWaiting.orderPlaced(input.tableId)
      return saved
    })
  }


  migrateAndSeed(database)
  customerWaiting = new CustomerWaitingService(database, action => withTransaction(database, action))
  customerWaiting.migrate()
  customerWaiting.start()
  const stopWaitingCleanup = cleanup
  cleanup = () => { customerWaiting.stop(); stopWaitingCleanup() }
  deliveryWhatsApp.migrate()
  deliveryWhatsApp.start()
  const stopExistingCleanup = cleanup
  cleanup = () => { deliveryWhatsApp.stop(); stopExistingCleanup() }
  staffAuth = new StaffAuthService(database, (action) => withTransaction(database, action))
  deliveryManagement = new DeliveryManagementService(database, (action) => withTransaction(database, action))
  const handlers = new Map<string, Operation>()
  const register = (channel: string, operation: Operation) => handlers.set(channel, operation)
  register('backups:list', event => { requireStaffPermission(event, 'settings:manage'); return backups.list() })
  register('backups:create', event => { requireStaffPermission(event, 'settings:manage'); return backups.create() })
  const restaurant = new RestaurantManagementService(database, action => withTransaction(database, action))
  restaurant.migrate()
  const financial = new FinancialManagementService(database, action => withTransaction(database, action))
  financial.migrate()
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version = 14').get()) return
    database.exec(`CREATE TABLE staff_users_v14 (
      id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','manager','cashier','waiter','kitchen','inventory','accountant')),
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_login_attempts >= 0),
      locked_until TEXT, created_at TEXT NOT NULL DEFAULT(datetime('now')));
      INSERT INTO staff_users_v14 SELECT * FROM staff_users;
      DROP TABLE staff_users;
      ALTER TABLE staff_users_v14 RENAME TO staff_users;
      CREATE INDEX staff_users_active_role ON staff_users(active,role);
      INSERT INTO schema_migrations(version) VALUES(14);`)
  })
  register('waiter:menu', event => {
    requireStaffPermission(event, 'waiter:operate')
    const menu = loadMenu()
    const orders = menu.activeOrders.filter(order => order.type === 'dine_in' && !order.savedAt)
    const actor = getStaffAccessState(event).staff!
    return { ...menu, activeOrders: orders.map(order => ({ ...order, kitchenTickets: printing.tickets(order.id) })), printJobs: printing.list(orders.map(order => order.id)), notices: kitchenNotices(actor.id), waiting: customerWaiting.list() }
  })
  register('waiter:transfer-table', (event, raw) => {
    requireStaffPermission(event, 'waiter:operate')
    const input = z.object({ orderId: z.string().min(1), fromTableId: z.string().min(1), toTableId: z.string().min(1) }).parse(raw)
    if (input.fromTableId === input.toTableId) throw new Error('Choose another table.')
    return withTransaction(database, () => {
      const order = database.prepare(`SELECT id,table_id AS tableId,type,status,saved_at AS savedAt,
        paid_at AS paidAt,voided_at AS voidedAt,joined_at AS joinedAt FROM orders WHERE id=?`).get(input.orderId) as
        { id: string; tableId: string | null; type: string; status: string; savedAt: string | null; paidAt: string | null; voidedAt: string | null; joinedAt: string | null } | undefined
      if (!order || order.type !== 'dine_in' || order.savedAt || order.paidAt || order.voidedAt || order.joinedAt || !['ordering','preparing','ready','payment_pending'].includes(order.status)) throw new Error('This order is no longer open.')
      if (order.tableId === input.toTableId) return orderFromRow(order.id)
      if (order.tableId !== input.fromTableId) throw new Error('The order moved to another table. Refresh and try again.')
      const destination = database.prepare('SELECT id FROM restaurant_tables WHERE id=?').get(input.toTableId)
      if (!destination) throw new Error('The destination table does not exist.')
      const occupied = database.prepare(`SELECT id FROM orders WHERE table_id=? AND saved_at IS NULL
        AND status IN ('ordering','preparing','ready','payment_pending') AND paid_at IS NULL AND voided_at IS NULL AND joined_at IS NULL LIMIT 1`).get(input.toTableId)
      if (occupied) throw new Error('That table already has an open order.')
      database.prepare('UPDATE orders SET table_id=? WHERE id=?').run(input.toTableId,input.orderId)
      return orderFromRow(input.orderId)
    })
  })
  register('waiter:waiting-confirm', (event, raw) => {
    requireStaffPermission(event, 'settings:manage')
    const input = z.object({ tableId: z.string().min(1).max(80), occupied: z.boolean() }).parse(raw)
    customerWaiting.confirm(input.tableId, input.occupied)
    return customerWaiting.list()
  })
  register('waiter:waiting-ack', (event, raw) => {
    requireStaffPermission(event, 'waiter:operate')
    customerWaiting.acknowledge(z.string().uuid().parse(raw))
    return customerWaiting.list()
  })
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version = 15').get()) return
    database.exec(`CREATE TABLE kitchen_tickets(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),
      status TEXT NOT NULL CHECK(status IN ('ordering','preparing','ready','payment_pending')),items_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT(datetime('now')));
      CREATE INDEX kitchen_tickets_status ON kitchen_tickets(status,created_at);`)
    const rows = database.prepare("SELECT id,status FROM orders WHERE paid_at IS NULL AND voided_at IS NULL AND status IN ('ordering','preparing','ready')").all() as { id: string; status: string }[]
    for (const row of rows) {
      const items = database.prepare(`SELECT id, product_id AS productId, product_name AS productName,
        unit_price_paise AS unitPricePaise, tax_rate_bps AS taxRateBps, quantity, note
        FROM order_items WHERE order_id=? ORDER BY rowid`).all(row.id).map(item => savedOrderItemSchema.parse(item))
      database.prepare('INSERT INTO kitchen_tickets(id,order_id,status,items_json) VALUES(?,?,?,?)').run(randomUUID(), row.id, row.status, JSON.stringify(items))
    }
    database.prepare('INSERT INTO schema_migrations(version) VALUES(15)').run()
  })
  const printing = new PrintManagementService(database, action => withTransaction(database, action), orderFromRow)
  printing.migrate()
  const savedTableBills = new SavedTableBills(database, action => withTransaction(database, action), orderFromRow)
  savedTableBills.migrate()
  const deliveryCashHandovers = new DeliveryCashHandovers(database, action => withTransaction(database, action), financial)
  deliveryCashHandovers.migrate()
  const deliveryRunSettlements = new DeliveryRunSettlements(database, action => withTransaction(database, action), financial)
  deliveryRunSettlements.migrate()
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version=20').get()) return
    database.exec(`CREATE TABLE order_item_voids (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), item_id TEXT NOT NULL,
      product_id TEXT NOT NULL, product_name TEXT NOT NULL, unit_price_paise INTEGER NOT NULL,
      tax_rate_bps INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0), note TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now'))
    ); CREATE INDEX order_item_voids_order ON order_item_voids(order_id,created_at DESC);
    INSERT INTO schema_migrations(version) VALUES(20);`)
  })
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version=21').get()) return
    database.exec(`DROP INDEX IF EXISTS one_open_order_per_table;
      CREATE INDEX IF NOT EXISTS open_orders_by_table ON orders(table_id, created_at DESC)
        WHERE table_id IS NOT NULL AND saved_at IS NULL AND paid_at IS NULL AND voided_at IS NULL
          AND status IN ('ordering','preparing','ready','payment_pending');
      INSERT INTO schema_migrations(version) VALUES(21);`)
  })
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version=22').get()) return
    database.exec(`CREATE TABLE order_splits (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      source_order_id TEXT NOT NULL REFERENCES orders(id), split_order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
      actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now'))
    ); CREATE INDEX order_splits_source ON order_splits(source_order_id, created_at DESC);
    INSERT INTO schema_migrations(version) VALUES(22);`)
  })
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version=23').get()) return
    database.exec(`ALTER TABLE orders ADD COLUMN joined_at TEXT;
      ALTER TABLE orders ADD COLUMN joined_into_order_id TEXT REFERENCES orders(id);
      CREATE TABLE order_joins (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, source_order_ids_json TEXT NOT NULL,
        joined_order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), actor TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT(datetime('now'))
      ); CREATE INDEX order_joins_joined ON order_joins(joined_order_id);
      INSERT INTO schema_migrations(version) VALUES(23);`)
  })
  migrateProfessionalBillingSchema(database, action => withTransaction(database, action))
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version=25').get()) return
    database.exec(`CREATE TABLE kitchen_notices (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('delay','availability')),
      order_id TEXT REFERENCES orders(id), product_id TEXT REFERENCES products(id),
      available INTEGER, delay_minutes INTEGER, reason TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now'))
    );
    CREATE INDEX kitchen_notices_order ON kitchen_notices(order_id,created_at DESC);
    CREATE TABLE kitchen_notice_acks (
      notice_id TEXT NOT NULL REFERENCES kitchen_notices(id), staff_id TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL DEFAULT(datetime('now')),
      PRIMARY KEY(notice_id,staff_id)
    );
    INSERT INTO schema_migrations(version) VALUES(25);`)
  })
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version=26').get()) return
    database.exec(`CREATE TABLE mobile_voice_messages (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      target TEXT NOT NULL CHECK(target IN ('dining','kitchen')),
      sender_id TEXT NOT NULL, sender_name TEXT NOT NULL,
      mime TEXT NOT NULL CHECK(mime IN ('audio/mp4','audio/3gpp')),
      audio BLOB NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now'))
    );
    CREATE INDEX mobile_voice_messages_target ON mobile_voice_messages(target,created_at DESC);
    INSERT INTO schema_migrations(version) VALUES(26);`)
  })
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version=27').get()) return
    database.exec(`CREATE TABLE delivery_bill_cashouts (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
      collected_paise INTEGER NOT NULL CHECK(collected_paise >= 0), actor TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT(datetime('now'))
    ); INSERT INTO schema_migrations(version) VALUES(27);`)
  })
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version=28').get()) return
    database.exec(`CREATE TABLE cash_openings (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      after_close_id TEXT REFERENCES cash_closes(id), opening_paise INTEGER NOT NULL CHECK(opening_paise >= 0),
      actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now'))
    ); INSERT INTO schema_migrations(version) VALUES(28);`)
  })
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version=29').get()) return
    database.exec(`CREATE TABLE mobile_text_messages (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, target TEXT NOT NULL CHECK(target IN ('dining','kitchen')),
      sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT(datetime('now'))
    ); CREATE INDEX idx_mobile_text_target_time ON mobile_text_messages(target,created_at);
    INSERT INTO schema_migrations(version) VALUES(29);`)
  })
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version=30').get()) return
    database.exec(`DROP INDEX one_active_delivery_slot;
      CREATE UNIQUE INDEX one_active_delivery_slot ON orders(delivery_number)
        WHERE type='delivery' AND delivery_number IS NOT NULL
          AND delivery_settled_at IS NULL AND voided_at IS NULL AND delivery_status <> 'cancelled';
      INSERT INTO schema_migrations(version) VALUES(30);`)
  })
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version=31').get()) return
    database.exec("ALTER TABLE orders ADD COLUMN kitchen_message TEXT NOT NULL DEFAULT ''; INSERT INTO schema_migrations(version) VALUES(31);")
  })
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version=32').get()) return
    database.exec(`ALTER TABLE mobile_text_messages ADD COLUMN table_id TEXT;
      ALTER TABLE mobile_text_messages ADD COLUMN table_name TEXT;
      ALTER TABLE mobile_voice_messages ADD COLUMN table_id TEXT;
      ALTER TABLE mobile_voice_messages ADD COLUMN table_name TEXT;
      INSERT INTO schema_migrations(version) VALUES(32);`)
  })
  const messageTable = (tableId: string | undefined) => {
    if (!tableId) return null
    const table = database.prepare('SELECT id,name FROM restaurant_tables WHERE id=?').get(tableId) as { id: string; name: string } | undefined
    if (!table) throw new Error('This table no longer exists.')
    return table
  }
  const requireVoiceWorkspace = (event: RequestContext, workspace: 'dining' | 'kitchen') =>
    requireStaffPermission(event, workspace === 'dining' ? 'waiter:operate' : 'kitchen:operate')
  register('message:list', (event, raw) => {
    const workspace = z.enum(['dining', 'kitchen']).parse(raw)
    const actor = requireVoiceWorkspace(event, workspace)
    return database.prepare(`SELECT * FROM (
      SELECT id,'voice' AS kind,sender_id AS senderId,sender_name AS senderName,target,
        NULL AS text,mime,table_id AS tableId,table_name AS tableName,created_at AS createdAt FROM mobile_voice_messages
        WHERE (target=? OR sender_id=?) AND created_at >= datetime('now','-1 day')
      UNION ALL
      SELECT id,'text' AS kind,sender_id AS senderId,sender_name AS senderName,target,
        text,NULL AS mime,table_id AS tableId,table_name AS tableName,created_at AS createdAt FROM mobile_text_messages
        WHERE (target=? OR sender_id=?) AND created_at >= datetime('now','-1 day')
    ) ORDER BY createdAt DESC,id DESC LIMIT 50`).all(workspace,actor.id,workspace,actor.id)
  })
  register('message:send', (event, raw) => {
    const input = z.object({ requestId: z.string().uuid(), target: z.enum(['dining','kitchen']), text: z.string().trim().min(1).max(500), tableId: z.string().min(1).max(80).optional() }).parse(raw)
    const sender = requireVoiceWorkspace(event, input.target === 'dining' ? 'kitchen' : 'dining')
    if (input.tableId && input.target !== 'kitchen') throw new Error('Only Dining can attach a table to a message.')
    return withTransaction(database, () => {
      const existing = database.prepare('SELECT id,table_name AS tableName FROM mobile_text_messages WHERE request_id=?').get(input.requestId) as { id: string; tableName: string | null } | undefined
      if (existing) return { id: existing.id, senderName: sender.displayName, tableName: existing.tableName }
      database.prepare(`DELETE FROM mobile_text_messages WHERE created_at < datetime('now','-1 day')`).run()
      const id = randomUUID()
      const table = messageTable(input.tableId)
      database.prepare(`INSERT INTO mobile_text_messages(id,request_id,target,sender_id,sender_name,text,table_id,table_name)
        VALUES(?,?,?,?,?,?,?,?)`).run(id,input.requestId,input.target,sender.id,sender.displayName,input.text,table?.id ?? null,table?.name ?? null)
      return { id, senderName: sender.displayName, tableName: table?.name ?? null }
    })
  })
  register('voice:list', (event, raw) => {
    const workspace = z.enum(['dining', 'kitchen']).parse(raw)
    requireVoiceWorkspace(event, workspace)
    return database.prepare(`SELECT id,sender_name AS senderName,mime,created_at AS createdAt
      FROM mobile_voice_messages WHERE target=? AND created_at >= datetime('now','-1 day')
      ORDER BY created_at DESC,rowid DESC LIMIT 20`).all(workspace)
  })
  register('voice:send', (event, raw) => {
    const input = z.object({ requestId: z.string().uuid(), target: z.enum(['dining','kitchen']),
      mime: z.enum(['audio/mp4','audio/3gpp']), audio: z.string().min(1).max(262144).regex(/^[A-Za-z0-9+/]+={0,2}$/), tableId: z.string().min(1).max(80).optional() }).parse(raw)
    const sender = requireVoiceWorkspace(event, input.target === 'dining' ? 'kitchen' : 'dining')
    if (input.tableId && input.target !== 'kitchen') throw new Error('Only Dining can attach a table to a message.')
    const bytes = Buffer.from(input.audio, 'base64')
    if (!bytes.length || bytes.length > 192 * 1024) throw new Error('Voice message must be under 15 seconds and 192 KB.')
    return withTransaction(database, () => {
      const existing = database.prepare('SELECT id,table_name AS tableName FROM mobile_voice_messages WHERE request_id=?').get(input.requestId) as { id: string; tableName: string | null } | undefined
      if (existing) return { id: existing.id, senderName: sender.displayName, tableName: existing.tableName }
      database.prepare(`DELETE FROM mobile_voice_messages WHERE created_at < datetime('now','-1 day')`).run()
      const id = randomUUID()
      const table = messageTable(input.tableId)
      database.prepare(`INSERT INTO mobile_voice_messages(id,request_id,target,sender_id,sender_name,mime,audio,table_id,table_name)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id,input.requestId,input.target,sender.id,sender.displayName,input.mime,bytes,table?.id ?? null,table?.name ?? null)
      return { id, senderName: sender.displayName, tableName: table?.name ?? null }
    })
  })
  register('voice:get', (event, raw) => {
    const input = z.object({ workspace: z.enum(['dining','kitchen']), id: z.string().uuid() }).parse(raw)
    const actor = requireVoiceWorkspace(event, input.workspace)
    return database.prepare(`SELECT mime,audio FROM mobile_voice_messages
      WHERE id=? AND (target=? OR sender_id=?) AND created_at >= datetime('now','-1 day')`).get(input.id,input.workspace,actor.id) as { mime: string; audio: Buffer } | undefined
  })
  const kitchenNotices = (staffId: string) => database.prepare(`SELECT n.id,n.kind,n.order_id AS orderId,
    n.product_id AS productId,n.available,n.delay_minutes AS delayMinutes,n.reason,n.actor,
    n.created_at AS createdAt,p.name AS productName,o.table_id AS tableId,
    t.name AS tableName FROM kitchen_notices n
    LEFT JOIN products p ON p.id=n.product_id
    LEFT JOIN orders o ON o.id=n.order_id
    LEFT JOIN restaurant_tables t ON t.id=o.table_id
    WHERE n.created_at >= datetime('now','-1 day')
      AND NOT EXISTS (SELECT 1 FROM kitchen_notice_acks a WHERE a.notice_id=n.id AND a.staff_id=?)
    ORDER BY n.created_at DESC,n.rowid DESC LIMIT 50`).all(staffId)
  register('waiter:notices', event => {
    const actor = requireStaffPermission(event, 'waiter:operate')
    return kitchenNotices(actor.id)
  })
  register('waiter:ack-notice', (event, raw) => {
    const actor = requireStaffPermission(event, 'waiter:operate')
    const id = z.string().uuid().parse(raw)
    return withTransaction(database, () => {
      if (!database.prepare('SELECT id FROM kitchen_notices WHERE id=?').get(id)) throw new Error('Notice no longer exists.')
      database.prepare('INSERT OR IGNORE INTO kitchen_notice_acks(notice_id,staff_id) VALUES(?,?)').run(id,actor.id)
    })
  })
  register('kitchen:set-availability', (event, raw) => {
    const actor = requireStaffPermission(event, 'kitchen:operate')
    const input = z.object({ requestId: z.string().uuid(), productId: z.string().min(1).max(80), available: z.boolean() }).parse(raw)
    return withTransaction(database, () => {
      const previous = database.prepare('SELECT id FROM kitchen_notices WHERE request_id=?').get(input.requestId)
      if (previous) return
      const product = database.prepare('SELECT id,available FROM products WHERE id=?').get(input.productId) as { id: string; available: number } | undefined
      if (!product) throw new Error('Product no longer exists.')
      if (Boolean(product.available) === input.available) return
      database.prepare('UPDATE products SET available=? WHERE id=?').run(input.available ? 1 : 0,input.productId)
      database.prepare(`INSERT INTO kitchen_notices(id,request_id,kind,product_id,available,actor)
        VALUES(?,?,'availability',?,?,?)`).run(randomUUID(),input.requestId,input.productId,input.available ? 1 : 0,actor.username)
    })
  })
  register('kitchen:delay-notice', (event, raw) => {
    const actor = requireStaffPermission(event, 'kitchen:operate')
    const input = z.object({ requestId: z.string().uuid(), orderId: z.string().uuid(),
      delayMinutes: z.number().int().min(1).max(120), reason: z.string().trim().min(3).max(250) }).parse(raw)
    return withTransaction(database, () => {
      if (database.prepare('SELECT id FROM kitchen_notices WHERE request_id=?').get(input.requestId)) return
      const order = database.prepare(`SELECT id FROM orders WHERE id=? AND type='dine_in'
        AND paid_at IS NULL AND voided_at IS NULL AND saved_at IS NULL`).get(input.orderId)
      if (!order) throw new Error('This table order is no longer open.')
      database.prepare(`INSERT INTO kitchen_notices(id,request_id,kind,order_id,delay_minutes,reason,actor)
        VALUES(?,?,'delay',?,?,?,?)`).run(randomUUID(),input.requestId,input.orderId,input.delayMinutes,input.reason,actor.username)
    })
  })
  register('waiter:save-bill', (event, input) => savedTableBills.save(requireStaffPermission(event, 'waiter:operate'), input))
  register('delivery:cash-handovers', (event, riderId) => deliveryCashHandovers.list(requireStaffPermission(event, 'delivery:view'), riderId))
  register('delivery:record-cash-handover', (event, input) => deliveryCashHandovers.record(requireStaffPermission(event, 'payments:record'), input))
  register('delivery:rider-run-state', (event, riderId) => deliveryRunSettlements.state(requireStaffPermission(event, 'delivery:view'), riderId))
  register('delivery:issue-float', (event, input) => deliveryRunSettlements.issue(requireStaffPermission(event, 'payments:record'), input))
  register('delivery:close-run', (event, input) => deliveryRunSettlements.close(requireStaffPermission(event, 'payments:record'), input))
  register('delivery:cash-out', (event, input) => {
    const actor = requireStaffPermission(event, 'payments:record')
    requireStaffPermission(event, 'delivery:view')
    return cashOutDelivery(input, actor)
  })
  const printerActor = (event: RequestContext) => {
    const staff = getStaffAccessState(event).staff
    if (!staff) throw new Error('Sign in to operate desktop printers.')
    return staff
  }
  register('print:request', (event, input) => printing.request(requireStaffPermission(event, 'waiter:operate'), input))
  register('print:request-pos', (event, input) => printing.request(requireStaffPermission(event, 'pos:access'), input))
  register('print:details', (event, raw) => {
    requireStaffPermission(event, 'pos:access')
    const orderId = z.string().uuid().parse(raw)
    const order = orderFromRow(orderId)
    if (!order || order.status === 'paid' || order.status === 'voided' || order.status === 'joined') throw new Error('Select an open saved order.')
    return { order, kitchenTickets: printing.tickets(orderId), jobs: printing.list([orderId]) }
  })
  register('print:claim', (event, input) => printing.claim(printerActor(event), input))
  register('print:finish', (event, input) => printing.finish(printerActor(event), input))
  register('print:list', event => {
    const actor = printerActor(event)
    if (actor.role !== 'kitchen') requireStaffPermission(event, 'pos:access')
    return printing.list().filter(job => actor.role !== 'kitchen' || job.kind === 'kot')
  })
  register('payments:ledger', (event, input) => { requireStaffPermission(event, 'pos:access'); return financial.ledger(input) })
  register('pos:split-order', (event, input) => splitOrder(input, requireStaffPermission(event, 'orders:write')))
  register('pos:join-orders', (event, input) => joinOrders(input, requireStaffPermission(event, 'orders:write')))
  register('payments:collect', (event, input) => financial.collect(requireStaffPermission(event, 'payments:record'), input))
  register('payments:refund', (event, input) => financial.refund(requireStaffPermission(event, 'payments:refund'), input))
  register('inventory:list', event => { requireStaffPermission(event, 'inventory:manage'); return restaurant.inventory() })
  register('inventory:save-item', (event, input) => restaurant.saveInventoryItem(requireStaffPermission(event, 'inventory:manage'), input))
  register('inventory:move-stock', (event, input) => restaurant.moveStock(requireStaffPermission(event, 'inventory:manage'), input))
  register('inventory:history', (event, input) => { requireStaffPermission(event, 'inventory:manage'); return restaurant.stockHistory(input) })
  register('cash:summary', event => { requireStaffPermission(event, 'payments:record'); return restaurant.cashSummary() })
  register('cash:open', (event, input) => restaurant.openCash(requireStaffPermission(event, 'payments:record'), input))
  register('cash:close', (event, input) => restaurant.closeCash(requireStaffPermission(event, 'cash:close'), input))
  register('kitchen:queue', event => {
    requireStaffPermission(event, 'kitchen:operate')
    const rows = database.prepare(`SELECT t.id AS ticketId,t.order_id AS orderId,t.status,t.items_json AS itemsJson,t.created_at AS createdAt,
      rt.name AS tableName FROM kitchen_tickets t JOIN orders o ON o.id = t.order_id
      LEFT JOIN restaurant_tables rt ON rt.id=o.table_id WHERE o.voided_at IS NULL
      AND t.status IN ('ordering','preparing','ready') ORDER BY t.created_at,t.rowid`).all() as { ticketId: string; orderId: string; status: OrderStatus; itemsJson: string; createdAt: string; tableName: string | null }[]
    return { orders: rows.map(row => ({ ...orderFromRow(row.orderId)!, ticketId: row.ticketId, status: row.status, tableName: row.tableName,
      createdAt: row.createdAt, items: z.array(savedOrderItemSchema).parse(JSON.parse(row.itemsJson)) })),
      products: database.prepare('SELECT id,name,available FROM products ORDER BY name').all() }
  })
  register('kitchen:update', (event, raw) => {
    const actor = requireStaffPermission(event, 'kitchen:operate')
    const input = z.object({ orderId: z.string().uuid(), ticketId: z.string().uuid().optional(), status: z.enum(['preparing','ready','payment_pending']) }).parse(raw)
    return withTransaction(database, () => {
      const order = database.prepare(`SELECT t.id,t.status,o.voided_at AS voidedAt FROM kitchen_tickets t
        JOIN orders o ON o.id = t.order_id WHERE t.order_id = ? AND (? IS NULL OR t.id = ?)
        ORDER BY CASE WHEN t.status = 'payment_pending' THEN 1 ELSE 0 END,t.rowid LIMIT 1`).get(input.orderId, input.ticketId ?? null, input.ticketId ?? null) as { id: string; status: string; voidedAt: string | null } | undefined
      if (!order || order.voidedAt) throw new Error('This order is no longer open.')
      if (order.status === input.status) return
      if (!(order.status === 'ordering' && input.status === 'preparing') && !(order.status === 'preparing' && input.status === 'ready') && !(order.status === 'ready' && input.status === 'payment_pending')) throw new Error('Refresh the queue and follow the preparation sequence.')
      database.prepare('UPDATE kitchen_tickets SET status = ? WHERE id = ?').run(input.status, order.id)
      const pending = database.prepare(`SELECT status FROM kitchen_tickets WHERE order_id = ? AND status <> 'payment_pending'
        ORDER BY CASE status WHEN 'ordering' THEN 0 WHEN 'preparing' THEN 1 ELSE 2 END LIMIT 1`).get(input.orderId) as { status: string } | undefined
      database.prepare('UPDATE orders SET status = ? WHERE id = ?').run(pending?.status ?? 'payment_pending', input.orderId)
      database.prepare(`INSERT INTO audit_log(id, action, entity_type, entity_id, actor, reason, details_json)
        VALUES(?, 'kitchen.status_changed', 'order', ?, ?, 'kitchen_preparation', ?)`).run(randomUUID(), input.orderId, actor.username, JSON.stringify({ ticketId: order.id, previous: order.status, current: input.status }))
    })
  })
  register('menu:catalog', event => {
    requireStaffPermission(event, 'menu:manage')
    return restaurant.catalog()
  })
  register('menu:save-category', (event, input) => restaurant.saveCategory(requireStaffPermission(event, 'menu:manage'), input))
  register('menu:save-product', (event, input) => restaurant.saveProduct(requireStaffPermission(event, 'menu:manage'), input))
  register('tables:add', (event, raw) => {
    const actor = requireStaffPermission(event, 'menu:manage')
    const input = z.object({ name: z.string().trim().min(1).max(40), floor: z.string().trim().min(1).max(80), capacity: z.number().int().min(1).max(100) }).strict().parse(raw)
    return withTransaction(database, () => {
      const existingFloor = database.prepare('SELECT floor FROM restaurant_tables WHERE lower(trim(floor)) = lower(?) LIMIT 1').get(input.floor) as { floor: string } | undefined
      if (existingFloor) input.floor = existingFloor.floor
      const duplicate = database.prepare('SELECT id FROM restaurant_tables WHERE lower(trim(name)) = lower(?) AND lower(trim(floor)) = lower(?)').get(input.name, input.floor)
      if (duplicate) throw new Error('A table with this name already exists on this floor.')
      const id = randomUUID()
      database.prepare('INSERT INTO restaurant_tables (id, name, floor, capacity) VALUES (?, ?, ?, ?)').run(id, input.name, input.floor, input.capacity)
      database.prepare(`INSERT INTO audit_log(id, action, entity_type, entity_id, actor, reason, details_json)
        VALUES(?, 'table.created', 'table', ?, ?, 'management', ?)`).run(randomUUID(), id, actor.username, JSON.stringify(input))
      return { id, ...input }
    })
  })
  register('cards:save-settings', (event, raw) => {
    const actor = requireStaffPermission(event, 'menu:manage')
    const input = z.object({ parcelCount: z.number().int().min(1).max(PARCEL_SLOT_COUNT), deliveryCount: z.number().int().min(1).max(DELIVERY_SLOT_COUNT) }).strict().parse(raw)
    return withTransaction(database, () => {
      const hidden = database.prepare(`SELECT type, CASE WHEN type = 'parcel' THEN parcel_number ELSE delivery_number END AS number
        FROM orders WHERE voided_at IS NULL AND joined_at IS NULL
        AND status IN ('ordering', 'preparing', 'ready', 'payment_pending')
        AND ((type = 'parcel' AND paid_at IS NULL AND parcel_number > ?)
          OR (type = 'delivery' AND (paid_at IS NULL OR delivery_settled_at IS NULL) AND COALESCE(delivery_status, '') <> 'cancelled' AND delivery_number > ?)) LIMIT 1`).get(input.parcelCount, input.deliveryCount) as { type: string; number: number } | undefined
      if (hidden) throw new Error(`Cannot hide ${hidden.type === 'parcel' ? 'P' : 'HD'}-${hidden.number} while its order is active.`)
      database.prepare('INSERT INTO card_settings (id, parcel_count, delivery_count) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET parcel_count = excluded.parcel_count, delivery_count = excluded.delivery_count').run(input.parcelCount, input.deliveryCount)
      database.prepare(`INSERT INTO audit_log(id, action, entity_type, entity_id, actor, reason, details_json) VALUES(?, 'cards.settings_changed', 'settings', 'cards', ?, 'management', ?)`).run(randomUUID(), actor.username, JSON.stringify(input))
      return input
    })
  })
  register('reports:sales', (event, input) => {
    requireStaffPermission(event, 'reports:view')
    return restaurant.salesReport(input)
  })
  register('staff:get-access-state', (event) => getStaffAccessState(event))
  register('staff:setup-owner', (event, input: unknown) => setupOwner(event, input))
  register('staff:login', (event, input: unknown) => loginStaff(event, input))
  register('staff:logout', (event) => logoutStaff(event))
  register('staff:list', (event) => listStaff(event))
  register('staff:create', (event, input: unknown) => createStaffUser(event, input))
  register('staff:reset-manager-password', (event, input: unknown) => staffAuth.resetManagerPassword(event.sender.id, input))
  register('delivery:list-schedule', (event) => listDeliverySchedule(event))
  register('delivery:find-customer', (event, contactNumber: unknown) => findSavedDeliveryCustomer(event, contactNumber))
  register('delivery:list-customers', (event, query: unknown) => listDeliveryCustomers(event, query))
  register('delivery:save-customer', (event, input: unknown) => saveDeliveryCustomer(event, input))
  register('delivery:list-riders', (event) => listDeliveryRiders(event))
  register('delivery:save-rider', (event, input: unknown) => saveDeliveryRider(event, input))
  register('delivery:update-schedule', (event, input: unknown) => updateDeliverySchedule(event, input))
  register('delivery:assign-rider', (event, input: unknown) => assignDeliveryRider(event, input))
  register('delivery:assign-rider-batch', (event, input: unknown) => assignDeliveryRiderBatch(event, input))
  register('delivery:operate', (event, input: unknown) => operateDelivery(event, input))
  register('delivery:list-events', (event, orderId: unknown) => listDeliveryEvents(event, orderId))
  register('pos:load-menu', (event) => {
    requireStaffPermission(event, 'pos:access')
    return loadMenu()
  })
  register('pos:create-order', (event, input: unknown) => createOrderForStaff(event, input))
  register('pos:get-order', (event, orderId: unknown) => {
    requireStaffPermission(event, 'pos:access')
    if (typeof orderId !== 'string' || orderId.length > 80) throw new Error('Invalid order ID.')
    return orderFromRow(orderId)
  })
  register('pos:list-bill-history', (event) => {
    requireStaffPermission(event, 'pos:access')
    return listBillHistory()
  })
  register('pos:record-payment', (event, input: unknown) => {
    const actor = requireStaffPermission(event, 'payments:record')
    return recordPayment(input, actor)
  })
  register('pos:manager-pin-configured', (event) => {
    requireStaffPermission(event, 'bill:void')
    return managerPinConfigured()
  })
  register('pos:set-manager-pin', (event, pin: unknown) => {
    const actor = requireStaffPermission(event, 'settings:manage')
    return setManagerPin(pin, actor)
  })
  register('pos:authorize-management', (event, pin: unknown) => {
    const actor = requireStaffPermission(event, 'menu:manage')
    return authorizeManagement(pin, actor)
  })
  register('pos:reset-manager-pin', (event, input: unknown) => {
    const actor = requireStaffPermission(event, 'settings:manage')
    return resetManagerPin(input, actor, event.sender.id)
  })
  register('pos:void-order', (event, input: unknown) => voidOrderForStaff(event, input))
  register('pos:void-order-item', (event, input: unknown) => {
    const actor = requireStaffPermission(event, 'bill:void')
    return voidOrderItem(input, actor)
  })
  register('pos:record-duplicate-kot-request', (event, orderId: unknown) => {
    const actor = requireStaffPermission(event, 'bill:reprint')
    return recordDuplicateKotRequest(orderId, actor)
  })

  return {
    onWaitingAlertCreated(listener: (alert: import('./services/customerWaiting.cjs').WaitingAlert) => void) {
      return customerWaiting.onAlertCreated(listener)
    },
    invoke(channel: string, senderId: number, input?: unknown): unknown {
      const operation = handlers.get(channel)
      if (!operation) throw new Error('Unknown operation.')
      return operation({ sender: { id: senderId } }, input)
    },
    logout(senderId: number) { staffAuth.logout(senderId) },
    close() { cleanup(); database.close(); lease.release() },
  }
  } catch (error) { cleanup(); closeOnFailure(); lease.release(); throw error }
}
