import type {
  BillHistoryEntry,
  CreateOrderInput,
  MenuData,
  PaymentRecord,
  RecordPaymentInput,
  SavedOrder,
  CreateStaffInput,
  OwnerSetupInput,
  StaffAccessState,
  StaffIdentity,
  StaffLoginInput,
  DeliveryEvent,
  DeliveryCashHandover,
  DeliveryCashHandoverInput,
  DeliveryOperation,
  DeliveryRider,
  DeliveryRiderInput,
  DeliveryScheduleEntry,
  DeliveryScheduleInput,
  SavedDeliveryCustomerDetails,
} from '../../shared/domain'
import type { CategoryInput, ProductInput, MenuCatalog, SalesReportInput, SalesReport } from '../../shared/restaurant'
import type { Category, Product } from '../../shared/domain'
import type { InventoryItem, InventoryItemInput, StockMovementInput, StockMovement, KitchenQueue, KitchenStatusInput, CashSummary, CashClose, CashCloseInput } from '../../shared/restaurant'
import type { PaymentLedger, TenderInput, RefundInput } from '../../shared/restaurant'
import type { BackupInfo } from '../../shared/restaurant'

declare global {
  interface Window {
    pos: {
      connectionMode: 'connected' | 'local'
      getWaiterMenu: () => Promise<MenuData>
      listBackups: () => Promise<BackupInfo[]>
      createBackup: () => Promise<BackupInfo>
      getPaymentLedger: (orderId: string) => Promise<PaymentLedger>
      collectPayment: (input: TenderInput) => Promise<PaymentLedger>
      refundPayment: (input: RefundInput) => Promise<PaymentLedger>
      listInventory: () => Promise<InventoryItem[]>
      saveInventoryItem: (input: InventoryItemInput) => Promise<InventoryItem>
      moveStock: (input: StockMovementInput) => Promise<InventoryItem>
      getStockHistory: (itemId: string) => Promise<StockMovement[]>
      getCashSummary: () => Promise<CashSummary>
      closeCash: (input: CashCloseInput) => Promise<CashClose>
      getKitchenQueue: () => Promise<KitchenQueue>
      updateKitchenStatus: (input: KitchenStatusInput) => Promise<void>
      getMenuCatalog: () => Promise<MenuCatalog>
      saveCategory: (input: CategoryInput) => Promise<Category>
      saveProduct: (input: ProductInput) => Promise<Product>
      getSalesReport: (input: SalesReportInput) => Promise<SalesReport>
      getStaffAccessState: () => Promise<StaffAccessState>
      setupOwner: (input: OwnerSetupInput) => Promise<StaffIdentity>
      loginStaff: (input: StaffLoginInput) => Promise<StaffIdentity>
      logoutStaff: () => Promise<void>
      listStaff: () => Promise<StaffIdentity[]>
      createStaff: (input: CreateStaffInput) => Promise<StaffIdentity>
      loadMenu: () => Promise<MenuData>
      createOrder: (input: CreateOrderInput) => Promise<SavedOrder>
      getOrder: (orderId: string) => Promise<SavedOrder | null>
      listBillHistory: () => Promise<BillHistoryEntry[]>
      recordPayment: (input: RecordPaymentInput) => Promise<PaymentRecord>
      managerPinConfigured: () => Promise<boolean>
      setManagerPin: (pin: string) => Promise<void>
      voidOrder: (input: { orderId: string; pin: string; reason: string }) => Promise<SavedOrder>
      recordDuplicateKotRequest: (orderId: string) => Promise<void>
      listDeliverySchedule: () => Promise<DeliveryScheduleEntry[]>
      findSavedDeliveryCustomer: (contactNumber: string) => Promise<SavedDeliveryCustomerDetails | null>
      listDeliveryRiders: () => Promise<DeliveryRider[]>
      saveDeliveryRider: (input: DeliveryRiderInput) => Promise<DeliveryRider>
      updateDeliverySchedule: (input: DeliveryScheduleInput) => Promise<void>
      assignDeliveryRider: (input: { orderId: string; riderId: string; reason?: string }) => Promise<void>
      assignDeliveryRiderBatch: (input: { orderIds: string[]; riderId: string; reason?: string }) => Promise<void>
      operateDelivery: (input: DeliveryOperation) => Promise<void>
      listDeliveryEvents: (orderId: string) => Promise<DeliveryEvent[]>
      listDeliveryCashHandovers: (riderId: string) => Promise<DeliveryCashHandover[]>
      recordDeliveryCashHandover: (input: DeliveryCashHandoverInput) => Promise<DeliveryCashHandover>
    }
  }
}

export {}
