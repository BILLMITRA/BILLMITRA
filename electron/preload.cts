import { contextBridge, ipcRenderer } from 'electron'
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
  DeliveryFloatIssue,
  DeliveryRunSettlement,
  RiderRunState,
  DeliveryOperation,
  DeliveryRider,
  DeliveryRiderInput,
  DeliveryScheduleEntry,
  DeliveryScheduleInput,
  SavedDeliveryCustomerDetails,
  SplitOrderInput,
  SplitOrderResult,
  JoinOrdersInput,
} from '../shared/domain.js'

const api = {
  connectionMode: process.env.BILLMITRA_DESKTOP_SERVER ? 'connected' as const : 'local' as const,
  getWaiterMenu: () => ipcRenderer.invoke('waiter:menu'),
  listBackups: () => ipcRenderer.invoke('backups:list'),
  createBackup: () => ipcRenderer.invoke('backups:create'),
  getPaymentLedger: (input: string) => ipcRenderer.invoke('payments:ledger', input),
  collectPayment: (input: unknown) => ipcRenderer.invoke('payments:collect', input),
  refundPayment: (input: unknown) => ipcRenderer.invoke('payments:refund', input),
  listInventory: () => ipcRenderer.invoke('inventory:list'),
  saveInventoryItem: (input: unknown) => ipcRenderer.invoke('inventory:save-item', input),
  moveStock: (input: unknown) => ipcRenderer.invoke('inventory:move-stock', input),
  getStockHistory: (input: string) => ipcRenderer.invoke('inventory:history', input),
  getCashSummary: () => ipcRenderer.invoke('cash:summary'),
  closeCash: (input: unknown) => ipcRenderer.invoke('cash:close', input),
  getKitchenQueue: () => ipcRenderer.invoke('kitchen:queue'),
  updateKitchenStatus: (input: unknown) => ipcRenderer.invoke('kitchen:update', input),
  getMenuCatalog: () => ipcRenderer.invoke('menu:catalog'),
  saveCategory: (input: unknown) => ipcRenderer.invoke('menu:save-category', input),
  saveProduct: (input: unknown) => ipcRenderer.invoke('menu:save-product', input),
  getSalesReport: (input: unknown) => ipcRenderer.invoke('reports:sales', input),
  getStaffAccessState: (): Promise<StaffAccessState> => ipcRenderer.invoke('staff:get-access-state'),
  setupOwner: (input: OwnerSetupInput): Promise<StaffIdentity> => ipcRenderer.invoke('staff:setup-owner', input),
  loginStaff: (input: StaffLoginInput): Promise<StaffIdentity> => ipcRenderer.invoke('staff:login', input),
  logoutStaff: (): Promise<void> => ipcRenderer.invoke('staff:logout'),
  listStaff: (): Promise<StaffIdentity[]> => ipcRenderer.invoke('staff:list'),
  createStaff: (input: CreateStaffInput): Promise<StaffIdentity> => ipcRenderer.invoke('staff:create', input),
  loadMenu: (): Promise<MenuData> => ipcRenderer.invoke('pos:load-menu'),
  createOrder: (input: CreateOrderInput): Promise<SavedOrder> =>
    ipcRenderer.invoke('pos:create-order', input),
  getOrder: (orderId: string): Promise<SavedOrder | null> =>
    ipcRenderer.invoke('pos:get-order', orderId),
  listBillHistory: (): Promise<BillHistoryEntry[]> =>
    ipcRenderer.invoke('pos:list-bill-history'),
  recordPayment: (input: RecordPaymentInput): Promise<PaymentRecord> =>
    ipcRenderer.invoke('pos:record-payment', input),
  managerPinConfigured: (): Promise<boolean> =>
    ipcRenderer.invoke('pos:manager-pin-configured'),
  setManagerPin: (pin: string): Promise<void> =>
    ipcRenderer.invoke('pos:set-manager-pin', pin),
  voidOrder: (input: { orderId: string; pin: string; reason: string }): Promise<SavedOrder> =>
    ipcRenderer.invoke('pos:void-order', input),
  voidOrderItem: (input: { orderId: string; itemId: string; quantity: number; pin: string; reason: string }): Promise<SavedOrder> =>
    ipcRenderer.invoke('pos:void-order-item', input),
  splitOrder: (input: SplitOrderInput): Promise<SplitOrderResult> =>
    ipcRenderer.invoke('pos:split-order', input),
  joinOrders: (input: JoinOrdersInput): Promise<SavedOrder> => ipcRenderer.invoke('pos:join-orders', input),
  recordDuplicateKotRequest: (orderId: string): Promise<void> =>
    ipcRenderer.invoke('pos:record-duplicate-kot-request', orderId),
  listDeliverySchedule: (): Promise<DeliveryScheduleEntry[]> =>
    ipcRenderer.invoke('delivery:list-schedule'),
  findSavedDeliveryCustomer: (contactNumber: string): Promise<SavedDeliveryCustomerDetails | null> =>
    ipcRenderer.invoke('delivery:find-customer', contactNumber),
  listDeliveryRiders: (): Promise<DeliveryRider[]> =>
    ipcRenderer.invoke('delivery:list-riders'),
  saveDeliveryRider: (input: DeliveryRiderInput): Promise<DeliveryRider> =>
    ipcRenderer.invoke('delivery:save-rider', input),
  updateDeliverySchedule: (input: DeliveryScheduleInput): Promise<void> =>
    ipcRenderer.invoke('delivery:update-schedule', input),
  assignDeliveryRider: (input: { orderId: string; riderId: string; reason?: string }): Promise<void> =>
    ipcRenderer.invoke('delivery:assign-rider', input),
  assignDeliveryRiderBatch: (input: { orderIds: string[]; riderId: string; reason?: string }): Promise<void> =>
    ipcRenderer.invoke('delivery:assign-rider-batch', input),
  listDeliveryCashHandovers: (riderId: string): Promise<DeliveryCashHandover[]> =>
    ipcRenderer.invoke('delivery:cash-handovers', riderId),
  recordDeliveryCashHandover: (input: DeliveryCashHandoverInput): Promise<DeliveryCashHandover> =>
    ipcRenderer.invoke('delivery:record-cash-handover', input),
  getRiderRunState: (riderId: string): Promise<RiderRunState> =>
    ipcRenderer.invoke('delivery:rider-run-state', riderId),
  issueDeliveryFloat: (input: { requestId: string; riderId: string; amountPaise: number; notes: string }): Promise<DeliveryFloatIssue> =>
    ipcRenderer.invoke('delivery:issue-float', input),
  closeDeliveryRun: (input: { requestId: string; riderId: string; receivedPaise: number; notes: string }): Promise<DeliveryRunSettlement> =>
    ipcRenderer.invoke('delivery:close-run', input),
  operateDelivery: (input: DeliveryOperation): Promise<void> =>
    ipcRenderer.invoke('delivery:operate', input),
  listDeliveryEvents: (orderId: string): Promise<DeliveryEvent[]> =>
    ipcRenderer.invoke('delivery:list-events', orderId),
}

contextBridge.exposeInMainWorld('pos', api)
contextBridge.exposeInMainWorld('desktopPrinting', {
  getState: () => ipcRenderer.invoke('desktop-print:state'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('desktop-print:settings', settings),
  getOrderDetails: (orderId: unknown) => ipcRenderer.invoke('desktop-print:details', orderId),
  request: (input: unknown) => ipcRenderer.invoke('desktop-print:request', input),
})
