import type { SavedOrder } from './domain.js'

export type PrintKind = 'bill' | 'kot'
export type PrintStatus = 'queued' | 'printing' | 'submitted' | 'failed' | 'unknown'
export interface PrintRequest { requestId: string; orderId: string; kind: PrintKind; ticketId?: string }
export interface PrintJobSummary {
  id: string; orderId: string; kind: PrintKind; ticketId: string | null; status: PrintStatus
  createdAt: string; error: string; copy: boolean
}
export interface PrintDocument {
  order: SavedOrder; tableName: string; floor: string; requestedBy: string
  ticketId: string | null; ticketCreatedAt: string | null; copy: boolean
}
export interface ClaimedPrintJob extends PrintJobSummary { claimToken: string; document: PrintDocument }
export interface PrinterSettings { bill: string; kot: string; restaurant: string; branch: string }
export interface PrinterState {
  settings: PrinterSettings; printers: { name: string; displayName: string }[]; error: string
  jobs: PrintJobSummary[]
}
export interface DesktopPrinting {
  getState(): Promise<PrinterState>
  saveSettings(settings: PrinterSettings): Promise<void>
  getOrderDetails(orderId: string): Promise<OrderPrintDetails>
  request(input: Omit<PrintRequest, 'requestId'>): Promise<PrintJobSummary>
}
export interface OrderPrintDetails {
  order: SavedOrder
  kitchenTickets: { id: string; createdAt: string }[]
  jobs: PrintJobSummary[]
  pendingRequests: PrintRequest[]
}
