import type { Category, Product, PaymentMethod, SavedOrder } from './domain.js'

export interface MenuCatalog { categories: Category[]; products: Product[] }
export interface CategoryInput { id?: string; name: string; sortOrder: number }
export interface ProductInput {
  id?: string; categoryId: string; name: string; description: string
  pricePaise: number; taxRateBps: number; available: boolean
}
export interface SalesReportInput { from: string; to: string }
export interface SalesReport {
  from: string; to: string; timezone: 'UTC'
  paidBills: number; subtotalPaise: number; discountPaise: number; taxPaise: number; totalPaise: number
  voidedBills: number; voidedPaise: number; unpaidBills: number; unpaidPaise: number
  refundedPaise: number; collectedPaise: number; netCollectionsPaise: number
  payments: { method: PaymentMethod; count: number; amountPaise: number }[]
  items: { name: string; quantity: number; subtotalPaise: number }[]
}
export interface InventoryItem { id: string; name: string; unit: string; quantityMilli: number; reorderMilli: number }
export interface InventoryItemInput { id?: string; name: string; unit: string; reorderMilli: number }
export interface StockMovementInput { requestId: string; itemId: string; deltaMilli: number; reason: string }
export interface StockMovement { id: string; itemId: string; deltaMilli: number; reason: string; actor: string; createdAt: string }
export interface KitchenQueue { orders: Array<SavedOrder & { ticketId: string }> }
export interface KitchenStatusInput { orderId: string; ticketId?: string; status: 'preparing' | 'ready' | 'payment_pending' }
export interface CashCloseInput { requestId: string; openingPaise: number; countedPaise: number; notes: string }
export interface CashClose { id: string; openingPaise: number; receiptsPaise: number; expectedPaise: number; countedPaise: number; variancePaise: number; notes: string; actor: string; createdAt: string }
export interface CashSummary { receiptsPaise: number; lastClose: CashClose | null }
export interface TenderInput { requestId: string; orderId: string; method: PaymentMethod; amountPaise: number }
export interface RefundInput { requestId: string; tenderId: string; amountPaise: number; reason: string }
export interface Tender { id: string; orderId: string; method: PaymentMethod; amountPaise: number; createdAt: string }
export interface Refund { id: string; tenderId: string; amountPaise: number; reason: string; actor: string; createdAt: string }
export interface PaymentLedger { orderId: string; totalPaise: number; collectedPaise: number; refundedPaise: number; balancePaise: number; settled: boolean; tenders: Tender[]; refunds: Refund[] }
export interface BackupInfo { name: string; sizeBytes: number; createdAt: string }
export interface BranchInfo { id: string; name: string }
