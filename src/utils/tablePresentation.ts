import type { RestaurantTable } from '../../shared/domain'

export function elapsedLabel(startedAt: string | null): string {
  if (!startedAt) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(`${startedAt.replace(' ', 'T')}Z`).getTime()) / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function elapsedClockLabel(startedAt: string | null, now: number = Date.now()): string {
  if (!startedAt) return ''
  const normalized = startedAt.includes('T') ? startedAt : `${startedAt.replace(' ', 'T')}Z`
  const startedAtMs = Date.parse(normalized)
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
