import type { Menu } from './api'

export const TABLE_HOLD_MS = 2000
export function tableOrder(menu: Menu | null, tableId: string) {
  const orderId = menu?.tables.find(table => table.id === tableId)?.orderId
  return menu?.activeOrders.find(order => order.id === orderId && !order.savedAt)
}
export function tableChanged(menu: Menu | null, tableId: string, openedOrderId: string | null) {
  const table = menu?.tables.find(table => table.id === tableId)
  return !table || (table.orderId ?? null) !== openedOrderId
}
