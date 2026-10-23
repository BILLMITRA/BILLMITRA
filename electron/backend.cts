import { randomUUID } from 'node:crypto'
import { RestaurantManagementService } from './services/restaurantManagement.cjs'
import { PrintManagementService } from './services/printManagement.cjs'
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
import { DeliveryManagementService } from './services/deliveryManagement.cjs'
import { findSavedDeliveryCustomer as lookupSavedDeliveryCustomer } from './services/deliveryCustomers.cjs'
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
  const voidOrderSchema = z.object({
    orderId: z.string().uuid(),
    pin: managerPinSchema,
    reason: z.string().trim().min(3).max(250),
  })
  const database = new DatabaseSync(databasePath)
  closeOnFailure = () => database.close()
  const backups = new DatabaseBackupService(database, databasePath)
  cleanup = () => backups.stop()
  backups.start()
  let staffAuth: StaffAuthService
  let deliveryManagement: DeliveryManagementService

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
        COALESCE(NULLIF(assigned_delivery_to, ''), (
          SELECT name FROM delivery_riders WHERE id = orders.delivery_rider_id
        ), '') AS assignedDeliveryTo, contact_number AS contactNumber, type,
        CASE WHEN voided_at IS NOT NULL THEN 'voided'
          WHEN paid_at IS NULL THEN status ELSE 'paid' END AS status,
        paid_at AS paidAt, table_id AS tableId,
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
        o.created_at AS startedAt, o.status
      FROM restaurant_tables t
      LEFT JOIN orders o ON o.table_id = t.id
        AND o.status IN ('ordering', 'preparing', 'ready', 'payment_pending')
        AND o.paid_at IS NULL AND o.voided_at IS NULL
      ORDER BY t.floor, t.name
    `).all() as Array<{
      id: string; name: string; floor: string; capacity: number; orderId: string | null
      orderNumber: number | null; amountPaise: number | null; startedAt: string | null; status: OrderStatus | null
    }>
    const activeOrders = database.prepare(`
      SELECT id FROM orders WHERE paid_at IS NULL AND voided_at IS NULL
        AND status IN ('ordering', 'preparing', 'ready', 'payment_pending')
      ORDER BY created_at DESC
    `).all() as Array<{ id: string }>

    return {
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
    if (input.type === 'delivery' && input.assignedDeliveryTo?.trim()) {
      throw new Error('Assign delivery riders from the saved delivery schedule.')
    }
    if (input.type !== 'delivery' && (input.scheduledPickupAt != null
      || input.deliveryArea || input.deliveryLandmark || input.deliveryInstructions)) {
      throw new Error('Only home-delivery orders can have delivery details.')
    }
    if (input.type === 'delivery' && input.orderId && (!input.contactNumber?.trim() || !input.deliveryAddress.trim())) {
      throw new Error('Enter the customer contact number and delivery address for delivery orders.')
    }
    if (input.type === 'parcel' && !input.customerName) {
      throw new Error('Enter a customer name for takeaway orders.')
    }

    try {
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
      if (orderId && financial.hasUnrefundedPayments(orderId)) throw new Error('Bills with collected payments cannot be edited. Refund open-bill payments first.')
      if (orderId) {
        const existingOrder = database.prepare(`
          SELECT id, status, type, table_id AS tableId, delivery_number AS deliveryNumber, parcel_number AS parcelNumber,
            paid_at AS paidAt, voided_at AS voidedAt, customer_name AS customerName,
            contact_number AS contactNumber, delivery_address AS deliveryAddress,
            delivery_area AS deliveryArea, delivery_landmark AS deliveryLandmark,
            delivery_instructions AS deliveryInstructions
          FROM orders WHERE id = ?
        `).get(orderId) as {
          id: string; status: OrderStatus; type: OrderType; tableId: string | null; deliveryNumber: number | null
          parcelNumber: number | null; paidAt: string | null; voidedAt: string | null
          customerName: string; contactNumber: string; deliveryAddress: string
          deliveryArea: string; deliveryLandmark: string; deliveryInstructions: string
        } | undefined
        if (!existingOrder || existingOrder.paidAt || existingOrder.voidedAt || !orderStatusValues.includes(existingOrder.status)) {
          throw new Error('This order is no longer open. Refresh the table before adding items.')
        }
        if (existingOrder.type !== input.type || existingOrder.tableId !== input.tableId
          || (input.type === 'delivery' && existingOrder.deliveryNumber !== input.deliveryNumber)
          || (input.type === 'parcel' && existingOrder.parcelNumber !== input.parcelNumber)) {
          throw new Error('The order type or service slot changed. Refresh the active order before saving.')
        }
        const updatedDeliveryDetails = database.prepare(`
          UPDATE orders SET customer_name = ?, contact_number = ?, delivery_address = ?,
            delivery_area = ?, delivery_landmark = ?, delivery_instructions = ?
          WHERE id = ? AND type = 'delivery' AND paid_at IS NULL AND voided_at IS NULL
        `).run(input.customerName, input.contactNumber ?? '', input.deliveryAddress,
          input.deliveryArea ?? '', input.deliveryLandmark ?? '', input.deliveryInstructions ?? '', orderId)
        if (input.type === 'delivery' && updatedDeliveryDetails.changes !== 1) {
          throw new Error('Delivery details could not be saved because the order is no longer open.')
        }
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
        if (input.tableId) {
          const openOrder = database.prepare(`
            SELECT id FROM orders WHERE table_id = ?
              AND paid_at IS NULL AND voided_at IS NULL
              AND status IN ('ordering', 'preparing', 'ready', 'payment_pending')
          `).get(input.tableId)
          if (openOrder) throw new Error('This table already has an open order. Refresh and select that order instead.')
        }
        orderId = randomUUID()
        const displayNumber = (database.prepare('SELECT COALESCE(MAX(display_number), 0) + 1 AS next FROM orders').get() as { next: number }).next
        const deliveryNumber = input.type === 'delivery' ? input.deliveryNumber ?? null : null
        if (deliveryNumber !== null) {
          const occupiedSlot = database.prepare(`
            SELECT id FROM orders WHERE type = 'delivery' AND delivery_number = ?
              AND paid_at IS NULL AND voided_at IS NULL
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
            scheduled_pickup_at, delivery_area, delivery_landmark, delivery_instructions)
          VALUES (?, ?, ?, 'ordering', ?, ?, ?, ?, 0, 0, 0, 'none', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(orderId, displayNumber, input.type, input.tableId, input.customerName, input.deliveryAddress, input.requestId,
          deliveryNumber, parcelNumber, input.scheduledDeliveryAt ?? null, '',
          input.contactNumber ?? '', input.scheduledPickupAt ?? null, input.deliveryArea ?? '', input.deliveryLandmark ?? '',
          input.deliveryInstructions ?? '')
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
      if (input.items.length) {
        database.prepare(`INSERT INTO kitchen_tickets(id,order_id,status,items_json) VALUES(?,?,'ordering',?)`).run(randomUUID(), orderId, JSON.stringify(saved.items.slice(-input.items.length)))
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
      return saved
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('one_open_order_per_table')) {
        throw new Error('This table already has an open order. Refresh and select that order instead.')
      }
      throw error
    }
  }


  migrateAndSeed(database)
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
    const orders = menu.activeOrders.filter(order => order.type === 'dine_in')
    return { ...menu, activeOrders: orders.map(order => ({ ...order, kitchenTickets: printing.tickets(order.id) })), printJobs: printing.list(orders.map(order => order.id)) }
  })
  withTransaction(database, () => {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version = 15').get()) return
    database.exec(`CREATE TABLE kitchen_tickets(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),
      status TEXT NOT NULL CHECK(status IN ('ordering','preparing','ready','payment_pending')),items_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT(datetime('now')));
      CREATE INDEX kitchen_tickets_status ON kitchen_tickets(status,created_at);`)
    const rows = database.prepare("SELECT id,status FROM orders WHERE paid_at IS NULL AND voided_at IS NULL AND status IN ('ordering','preparing','ready')").all() as { id: string; status: string }[]
    for (const row of rows) {
      database.prepare('INSERT INTO kitchen_tickets(id,order_id,status,items_json) VALUES(?,?,?,?)').run(randomUUID(), row.id, row.status, JSON.stringify(orderFromRow(row.id)!.items))
    }
    database.prepare('INSERT INTO schema_migrations(version) VALUES(15)').run()
  })
  const printing = new PrintManagementService(database, action => withTransaction(database, action), orderFromRow)
  printing.migrate()
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
    if (!order || order.type !== 'dine_in' || order.status === 'paid' || order.status === 'voided') throw new Error('Select an open saved table order.')
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
  register('payments:collect', (event, input) => financial.collect(requireStaffPermission(event, 'payments:record'), input))
  register('payments:refund', (event, input) => financial.refund(requireStaffPermission(event, 'payments:refund'), input))
  register('inventory:list', event => { requireStaffPermission(event, 'inventory:manage'); return restaurant.inventory() })
  register('inventory:save-item', (event, input) => restaurant.saveInventoryItem(requireStaffPermission(event, 'inventory:manage'), input))
  register('inventory:move-stock', (event, input) => restaurant.moveStock(requireStaffPermission(event, 'inventory:manage'), input))
  register('inventory:history', (event, input) => { requireStaffPermission(event, 'inventory:manage'); return restaurant.stockHistory(input) })
  register('cash:summary', event => { requireStaffPermission(event, 'cash:close'); return restaurant.cashSummary() })
  register('cash:close', (event, input) => restaurant.closeCash(requireStaffPermission(event, 'cash:close'), input))
  register('kitchen:queue', event => {
    requireStaffPermission(event, 'kitchen:operate')
    const rows = database.prepare(`SELECT t.id AS ticketId,t.order_id AS orderId,t.status,t.items_json AS itemsJson,t.created_at AS createdAt
      FROM kitchen_tickets t JOIN orders o ON o.id = t.order_id WHERE o.voided_at IS NULL
      AND t.status IN ('ordering','preparing','ready') ORDER BY t.created_at,t.rowid`).all() as { ticketId: string; orderId: string; status: OrderStatus; itemsJson: string; createdAt: string }[]
    return { orders: rows.map(row => ({ ...orderFromRow(row.orderId)!, ticketId: row.ticketId, status: row.status,
      createdAt: row.createdAt, items: z.array(savedOrderItemSchema).parse(JSON.parse(row.itemsJson)) })) }
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
  register('delivery:list-schedule', (event) => listDeliverySchedule(event))
  register('delivery:find-customer', (event, contactNumber: unknown) => findSavedDeliveryCustomer(event, contactNumber))
  register('delivery:list-riders', (event) => listDeliveryRiders(event))
  register('delivery:save-rider', (event, input: unknown) => saveDeliveryRider(event, input))
  register('delivery:update-schedule', (event, input: unknown) => updateDeliverySchedule(event, input))
  register('delivery:assign-rider', (event, input: unknown) => assignDeliveryRider(event, input))
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
  register('pos:void-order', (event, input: unknown) => voidOrderForStaff(event, input))
  register('pos:record-duplicate-kot-request', (event, orderId: unknown) => {
    const actor = requireStaffPermission(event, 'bill:reprint')
    return recordDuplicateKotRequest(orderId, actor)
  })

  return {
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
