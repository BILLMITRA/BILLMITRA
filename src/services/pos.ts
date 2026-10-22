import { browserPos } from './browserPos'
import type {
  CreateOrderInput,
  CreateStaffInput,
  OwnerSetupInput,
  RecordPaymentInput,
  StaffLoginInput,
  DeliveryEvent,
  DeliveryOperation,
  DeliveryRider,
  DeliveryRiderInput,
  DeliveryScheduleEntry,
  DeliveryScheduleInput,
  SavedDeliveryCustomerDetails,
} from '../../shared/domain'

const posApi = window.pos ?? browserPos
export const getWaiterMenu = () => posApi.getWaiterMenu()
export const listBackups = () => posApi.listBackups()
export const createBackup = () => posApi.createBackup()
export const getPaymentLedger: Window['pos']['getPaymentLedger'] = input => posApi.getPaymentLedger(input)
export const collectPayment: Window['pos']['collectPayment'] = input => posApi.collectPayment(input)
export const refundPayment: Window['pos']['refundPayment'] = input => posApi.refundPayment(input)
export const listInventory = () => posApi.listInventory()
export const saveInventoryItem: Window['pos']['saveInventoryItem'] = input => posApi.saveInventoryItem(input)
export const moveStock: Window['pos']['moveStock'] = input => posApi.moveStock(input)
export const getStockHistory: Window['pos']['getStockHistory'] = input => posApi.getStockHistory(input)
export const getCashSummary = () => posApi.getCashSummary()
export const closeCash: Window['pos']['closeCash'] = input => posApi.closeCash(input)
export const getKitchenQueue = () => posApi.getKitchenQueue()
export const updateKitchenStatus: Window['pos']['updateKitchenStatus'] = input => posApi.updateKitchenStatus(input)
export const getMenuCatalog = () => posApi.getMenuCatalog()
export const saveCategory: Window['pos']['saveCategory'] = input => posApi.saveCategory(input)
export const saveProduct: Window['pos']['saveProduct'] = input => posApi.saveProduct(input)
export const getSalesReport: Window['pos']['getSalesReport'] = input => posApi.getSalesReport(input)

export function getStaffAccessState() {
  return posApi.getStaffAccessState()
}

export function setupOwner(input: OwnerSetupInput) {
  return posApi.setupOwner(input)
}

export function loginStaff(input: StaffLoginInput) {
  return posApi.loginStaff(input)
}

export function logoutStaff() {
  return posApi.logoutStaff()
}

export function listStaff() {
  return posApi.listStaff()
}

export function createStaff(input: CreateStaffInput) {
  return posApi.createStaff(input)
}

export function loadMenu() {
  return posApi.loadMenu()
}

export function createOrder(input: CreateOrderInput) {
  return posApi.createOrder(input)
}

export function listBillHistory() {
  return posApi.listBillHistory()
}

export function recordPayment(input: RecordPaymentInput) {
  return posApi.recordPayment(input)
}

export function getOrder(orderId: string) {
  return posApi.getOrder(orderId)
}

export function managerPinConfigured() {
  return posApi.managerPinConfigured()
}

export function setManagerPin(pin: string) {
  return posApi.setManagerPin(pin)
}

export function voidOrder(input: { orderId: string; pin: string; reason: string }) {
  return posApi.voidOrder(input)
}

export function recordDuplicateKotRequest(orderId: string) {
  return posApi.recordDuplicateKotRequest(orderId)
}

export function listDeliverySchedule(): Promise<DeliveryScheduleEntry[]> {
  return posApi.listDeliverySchedule()
}

export function findSavedDeliveryCustomer(contactNumber: string): Promise<SavedDeliveryCustomerDetails | null> {
  return posApi.findSavedDeliveryCustomer(contactNumber)
}

export function listDeliveryRiders(): Promise<DeliveryRider[]> {
  return posApi.listDeliveryRiders()
}

export function saveDeliveryRider(input: DeliveryRiderInput): Promise<DeliveryRider> {
  return posApi.saveDeliveryRider(input)
}

export function updateDeliverySchedule(input: DeliveryScheduleInput): Promise<void> {
  return posApi.updateDeliverySchedule(input)
}

export function assignDeliveryRider(input: { orderId: string; riderId: string; reason?: string }): Promise<void> {
  return posApi.assignDeliveryRider(input)
}

export function operateDelivery(input: DeliveryOperation): Promise<void> {
  return posApi.operateDelivery(input)
}

export function listDeliveryEvents(orderId: string): Promise<DeliveryEvent[]> {
  return posApi.listDeliveryEvents(orderId)
}
