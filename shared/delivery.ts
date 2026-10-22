import type { DeliveryScheduleEntry } from './domain.js'

export type DeliveryStatusFilter = 'all' | 'unassigned' | DeliveryScheduleEntry['deliveryStatus']

function parsedDate(value: string | null): Date | null {
  if (!value) return null
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

export function filterDeliverySchedule(
  entries: readonly DeliveryScheduleEntry[],
  options: { query?: string; status?: DeliveryStatusFilter; date?: string },
): DeliveryScheduleEntry[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? ''
  return entries.filter((entry) => {
    if (options.status === 'unassigned'
      && (entry.rider !== null || ['delivered', 'cancelled'].includes(entry.deliveryStatus))) return false
    if (options.status && options.status !== 'all' && options.status !== 'unassigned'
      && entry.deliveryStatus !== options.status) return false
    if (options.date && parsedDate(entry.createdAt)?.toLocaleDateString('en-CA') !== options.date) return false
    if (!query) return true
    const searchable = [
      entry.reference,
      String(entry.orderNumber),
      entry.customerName,
      entry.contactNumber,
      entry.rider?.name,
      entry.assignedDeliveryTo,
      entry.deliveryAddress,
      entry.deliveryArea,
      entry.deliveryLandmark,
    ].join(' ').toLocaleLowerCase()
    return searchable.includes(query)
  })
}

export function deliveryDelayMinutes(entry: DeliveryScheduleEntry, now: Date | number): number {
  if (!entry.promisedDeliveryAt || ['delivered', 'cancelled'].includes(entry.deliveryStatus)) return 0
  const promised = parsedDate(entry.promisedDeliveryAt)?.getTime()
  const nowTime = typeof now === 'number' ? now : now.getTime()
  return promised ? Math.max(0, Math.floor((nowTime - promised) / 60_000)) : 0
}
