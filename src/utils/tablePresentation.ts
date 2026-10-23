import type { RestaurantTable } from '../../shared/domain'

function orderStart(value: string | null): number {
  if (!value) return NaN
  const normalized = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value
  return Date.parse(normalized)
}

export function tableOrderTimer(table: Pick<RestaurantTable, 'orderId' | 'startedAt'>, now: number) {
  if (!table.orderId) return { state: 'available' as const, label: '' }
  const start = orderStart(table.startedAt)
  const label = elapsedClockLabel(table.startedAt, now)
  return { state: Number.isFinite(start) && now - start >= 3600000 ? 'overdue' as const : 'open' as const, label: label ? label.padStart(8, '0') : 'Time unavailable' }
}

export function elapsedLabel(startedAt: string | null): string {
  if (!startedAt) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(`${startedAt.replace(' ', 'T')}Z`).getTime()) / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function elapsedClockLabel(startedAt: string | null, now: number = Date.now()): string {
  if (!startedAt) return ''
  const startedAtMs = orderStart(startedAt)
  if (!Number.isFinite(startedAtMs)) return ''
  const seconds = Math.max(0, Math.floor((now - startedAtMs) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

export function tableStatusLabel(table: RestaurantTable): string {
  if (table.status === 'available') return 'Available'
  if (table.status === 'payment_pending') return 'Bill requested'
  return table.status[0].toUpperCase() + table.status.slice(1)
}
