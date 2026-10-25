import { posChannels } from '../../shared/posChannels'
import { selectedBranchId } from './branchContext'

async function invoke<T>(method: keyof typeof posChannels, input?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch('/api/pos/' + method, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(selectedBranchId() ? { 'X-Billmitra-Branch': selectedBranchId() } : {}) },
      body: JSON.stringify({ input }),
    })
  } catch {
    throw new Error('Cannot reach the restaurant server. Check your connection and try again.')
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The restaurant API is unavailable. Start the web server and try again.')
  }
  const payload = await response.json() as { result?: T; error?: string }
  if (!response.ok) throw new Error(payload.error ?? 'The request could not be completed.')
  return payload.result as T
}

export const browserPos: Window['pos'] = {
  connectionMode: 'connected',
  getWaiterMenu: () => invoke('getWaiterMenu'),
  listBackups: () => invoke('listBackups'),
  createBackup: () => invoke('createBackup'),
  getPaymentLedger: input => invoke('getPaymentLedger', input),
  collectPayment: input => invoke('collectPayment', input),
  refundPayment: input => invoke('refundPayment', input),
  listInventory: () => invoke('listInventory'),
  saveInventoryItem: input => invoke('saveInventoryItem', input),
  moveStock: input => invoke('moveStock', input),
  getStockHistory: input => invoke('getStockHistory', input),
  getCashSummary: () => invoke('getCashSummary'),
  closeCash: input => invoke('closeCash', input),
  getKitchenQueue: () => invoke('getKitchenQueue'),
  updateKitchenStatus: input => invoke('updateKitchenStatus', input),
  getMenuCatalog: () => invoke('getMenuCatalog'),
  saveCategory: input => invoke('saveCategory', input),
  saveProduct: input => invoke('saveProduct', input),
  getSalesReport: input => invoke('getSalesReport', input),
  getStaffAccessState: () => invoke('getStaffAccessState'),
  setupOwner: (input) => invoke('setupOwner', input),
  loginStaff: (input) => invoke('loginStaff', input),
  logoutStaff: () => invoke('logoutStaff'),
  listStaff: () => invoke('listStaff'),
  createStaff: (input) => invoke('createStaff', input),
  loadMenu: () => invoke('loadMenu'),
  createOrder: (input) => invoke('createOrder', input),
  getOrder: (input) => invoke('getOrder', input),
  listBillHistory: () => invoke('listBillHistory'),
  recordPayment: (input) => invoke('recordPayment', input),
  managerPinConfigured: () => invoke('managerPinConfigured'),
  setManagerPin: (input) => invoke('setManagerPin', input),
  voidOrder: (input) => invoke('voidOrder', input),
  voidOrderItem: (input) => invoke('voidOrderItem', input),
  splitOrder: (input) => invoke('splitOrder', input),
  recordDuplicateKotRequest: (input) => invoke('recordDuplicateKotRequest', input),
  listDeliverySchedule: () => invoke('listDeliverySchedule'),
  findSavedDeliveryCustomer: (input) => invoke('findSavedDeliveryCustomer', input),
  listDeliveryRiders: () => invoke('listDeliveryRiders'),
  saveDeliveryRider: (input) => invoke('saveDeliveryRider', input),
  updateDeliverySchedule: (input) => invoke('updateDeliverySchedule', input),
  assignDeliveryRider: (input) => invoke('assignDeliveryRider', input),
  assignDeliveryRiderBatch: (input) => invoke('assignDeliveryRiderBatch', input),
  listDeliveryCashHandovers: (input) => invoke('listDeliveryCashHandovers', input),
  recordDeliveryCashHandover: (input) => invoke('recordDeliveryCashHandover', input),
  getRiderRunState: (input) => invoke('getRiderRunState', input),
  issueDeliveryFloat: (input) => invoke('issueDeliveryFloat', input),
  closeDeliveryRun: (input) => invoke('closeDeliveryRun', input),
  operateDelivery: (input) => invoke('operateDelivery', input),
  listDeliveryEvents: (input) => invoke('listDeliveryEvents', input),
}
