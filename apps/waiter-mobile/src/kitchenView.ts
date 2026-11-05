import type { KitchenQueue, KitchenTicket } from './api'

export type OrderFilter = 'all' | 'ordering' | 'preparing' | 'ready'

export function kitchenCounts(orders: KitchenTicket[]) {
  return {
    all: orders.length,
    ordering: orders.filter(order => order.status === 'ordering').length,
    preparing: orders.filter(order => order.status === 'preparing').length,
    ready: orders.filter(order => order.status === 'ready').length,
  }
}

export function visibleKitchenOrders(orders: KitchenTicket[], filter: OrderFilter, query: string) {
  const needle = query.trim().toLocaleLowerCase()
  return orders.filter(order => (filter === 'all' || order.status === filter) && (!needle || [
    String(order.orderNumber), order.tableName ?? '', order.type,
    ...order.items.flatMap(item => [item.productName, item.note]),
  ].some(value => value.toLocaleLowerCase().includes(needle))))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

export function visibleKitchenProducts(products: KitchenQueue['products'], query: string, unavailableOnly: boolean) {
  const needle = query.trim().toLocaleLowerCase()
  return products.filter(product => (!unavailableOnly || !product.available) && product.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name))
}
