import type { BillDiscount } from './billing.js'

export type OrderType = 'dine_in' | 'parcel' | 'delivery'
export type OrderStatus = 'ordering' | 'preparing' | 'ready' | 'payment_pending' | 'paid' | 'voided'
export type DeliveryStatus = 'pending' | 'assigned' | 'dispatched' | 'delivered' | 'failed' | 'cancelled'
export type RiderAvailability = 'available' | 'unavailable' | 'off_shift'
export type TableStatus = 'available' | 'ordering' | 'preparing' | 'ready' | 'payment_pending'
export type PaymentMethod = 'cash' | 'card' | 'upi'
export const STAFF_ROLES = ['owner', 'manager', 'cashier', 'waiter', 'kitchen', 'inventory', 'accountant'] as const
export type StaffRole = typeof STAFF_ROLES[number]
export type StaffPermission =
  | 'pos:access'
  | 'orders:write'
  | 'discount:apply'
  | 'payments:record'
  | 'bill:void'
  | 'bill:reprint'
  | 'staff:manage'
  | 'settings:manage'
  | 'menu:manage'
  | 'cash:close'
  | 'payments:refund'
  | 'reports:view'
  | 'inventory:manage'
  | 'kitchen:operate'
  | 'waiter:operate'
  | 'delivery:view'
  | 'delivery:assign'
  | 'delivery:reassign'
  | 'delivery:operate'
  | 'delivery:cancel'
  | 'delivery:riders'
export const DELIVERY_SLOT_COUNT = 100
export const PARCEL_SLOT_COUNT = 100
export type { BillDiscount } from './billing.js'

export interface StaffIdentity {
  id: string
  username: string
  displayName: string
  role: StaffRole
}

export interface StaffAccessState {
  needsOwnerSetup: boolean
  staff: StaffIdentity | null
}

export interface StaffLoginInput {
  username: string
  password: string
}

export interface OwnerSetupInput extends StaffLoginInput {
  displayName: string
  setupToken?: string
}

export interface CreateStaffInput extends StaffLoginInput {
  displayName: string
  role: Exclude<StaffRole, 'owner'>
}

export interface Category {
  id: string
  name: string
  sortOrder: number
}

export interface Product {
  id: string
  categoryId: string
  name: string
  description: string
  pricePaise: number
  taxRateBps: number
  available: boolean
}

export interface RestaurantTable {
  id: string
  name: string
  floor: string
  capacity: number
  status: TableStatus
  orderId: string | null
  orderNumber: number | null
  amountPaise: number | null
  startedAt: string | null
}

export interface OrderLineInput {
  productId: string
  quantity: number
  note: string
}

export interface CreateOrderInput {
  requestId: string
  type: OrderType
  tableId: string | null
  customerName: string
  contactNumber?: string
  deliveryAddress: string
  items: OrderLineInput[]
  discount: BillDiscount | null
  deliveryNumber?: number | null
  parcelNumber?: number | null
  scheduledDeliveryAt?: string | null
  scheduledPickupAt?: string | null
  assignedDeliveryTo?: string
  deliveryArea?: string
  deliveryLandmark?: string
  deliveryInstructions?: string
  orderId?: string
}

export interface SavedOrder {
  savedAt?: string | null
  savedBy?: string | null
  savedTableName?: string | null
  savedTableFloor?: string | null
  id: string
  orderNumber: number
  deliveryNumber: number | null
  parcelNumber: number | null
  scheduledDeliveryAt: string | null
  scheduledPickupAt: string | null
  readyForPickupAt: string | null
  actualPickupAt: string | null
  dispatchedAt: string | null
  deliveredAt: string | null
  assignedDeliveryTo: string
  deliveryStatus: DeliveryStatus
  deliveryRiderId: string | null
  deliveryArea: string
  deliveryLandmark: string
  deliveryInstructions: string
  type: OrderType
  status: OrderStatus
  tableId: string | null
  customerName: string
  contactNumber: string
  deliveryAddress: string
  createdAt: string
  subtotalPaise: number
  taxPaise: number
  totalPaise: number
  discount: BillDiscount | null
  discountPaise: number
  voidReason: string | null
  items: Array<OrderLineInput & {
    id: string
    productName: string
    unitPricePaise: number
    taxRateBps: number
  }>
}

export interface DeliveryRider {
  id: string
  name: string
  employeeCode: string
  contactNumber: string
  active: boolean
  availability: RiderAvailability
  maxActiveDeliveries: number
  activeDeliveryCount: number
  completedDeliveryCount: number
  lastStatusUpdate: string
  canAcceptDelivery: boolean
  derivedAvailability: 'available' | 'busy' | 'unavailable' | 'off_shift' | 'inactive'
}

export interface DeliveryScheduleEntry {
  id: string
  reference: string
  orderNumber: number
  createdAt: string
  scheduledPickupAt: string | null
  readyForPickupAt: string | null
  promisedDeliveryAt: string | null
  actualPickupAt: string | null
  dispatchedAt: string | null
  deliveredAt: string | null
  deliveryStatus: DeliveryStatus
  foodStatus: OrderStatus
  paymentStatus: 'paid' | 'unpaid' | 'voided'
  customerName: string
  contactNumber: string
  deliveryAddress: string
  deliveryArea: string
  deliveryLandmark: string
  deliveryInstructions: string
  assignedDeliveryTo: string
  rider: DeliveryRider | null
  totalPaise: number
  items: SavedOrder['items']
}

export interface DeliveryScheduleInput {
  orderId: string
  scheduledPickupAt: string | null
  promisedDeliveryAt: string | null
}

export interface SavedDeliveryCustomerDetails {
  customerName: string
  contactNumber: string
  deliveryAddress: string
  deliveryArea: string
  deliveryLandmark: string
  deliveryInstructions: string
}

export interface DeliveryRiderInput {
  id?: string
  name: string
  employeeCode: string
  contactNumber: string
  active: boolean
  availability: RiderAvailability
  maxActiveDeliveries: number
}

export type DeliveryOperation =
  | { kind: 'ready_for_pickup'; orderId: string }
  | { kind: 'dispatch'; orderId: string }
  | { kind: 'delivered'; orderId: string; notes?: string }
  | { kind: 'failed'; orderId: string; reason: string }
  | { kind: 'cancelled'; orderId: string; reason: string }

export interface DeliveryEvent {
  id: string
  orderId: string
  eventType: string
  previousStatus: string | null
  newStatus: string | null
  previousRiderId: string | null
  newRiderId: string | null
  actor: string
  reason: string
  createdAt: string
}

export function formatOrderReference(order: Pick<SavedOrder, 'type' | 'orderNumber' | 'deliveryNumber' | 'parcelNumber'>): string {
  return order.type === 'delivery' && order.deliveryNumber !== null
    ? `HD-${order.deliveryNumber}`
    : order.type === 'parcel' && order.parcelNumber !== null
      ? `P-${order.parcelNumber}`
    : `#${order.orderNumber}`
}

export function isValidDeliveryNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= DELIVERY_SLOT_COUNT
}

export function isValidParcelNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= PARCEL_SLOT_COUNT
}

export interface RecordPaymentInput {
  requestId: string
  orderId: string
  method: PaymentMethod
}

export interface PaymentRecord {
  id: string
  orderId: string
  method: PaymentMethod | 'split'
  amountPaise: number
  paidAt: string
}

export interface BillHistoryEntry {
  order: SavedOrder
  payment: PaymentRecord | null
}

export interface MenuData {
  categories: Category[]
  products: Product[]
  tables: RestaurantTable[]
  activeOrders: SavedOrder[]
}
