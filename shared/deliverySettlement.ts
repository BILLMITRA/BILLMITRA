import type { DeliveryScheduleEntry } from './domain.js'

export interface RiderSettlementSummary {
  bills: DeliveryScheduleEntry[]
  assignedCount: number
  deliveredCount: number
  outForDeliveryCount: number
  invoicePaise: number
  collectedPaise: number
  balancePaise: number
  deliveredBalancePaise: number
}

function localDay(value: string): string {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function riderSettlementSummary(
  entries: readonly DeliveryScheduleEntry[], riderId: string, from = '', to = '',
): RiderSettlementSummary {
  const bills = entries.filter(entry => {
    if (entry.rider?.id !== riderId || !entry.assignedAt) return false
    const day = localDay(entry.assignedAt)
    return (!from || day >= from) && (!to || day <= to)
  }).sort((a, b) => (a.assignedAt ?? '').localeCompare(b.assignedAt ?? ''))
  return {
    bills,
    assignedCount: bills.length,
    deliveredCount: bills.filter(entry => entry.deliveryStatus === 'delivered').length,
    outForDeliveryCount: bills.filter(entry => entry.deliveryStatus === 'dispatched').length,
    invoicePaise: bills.filter(entry => entry.paymentStatus !== 'voided').reduce((sum, entry) => sum + entry.totalPaise, 0),
    collectedPaise: bills.reduce((sum, entry) => sum + entry.collectedPaise, 0),
    balancePaise: bills.reduce((sum, entry) => sum + entry.balancePaise, 0),
    deliveredBalancePaise: bills.filter(entry => entry.deliveryStatus === 'delivered').reduce((sum, entry) => sum + entry.balancePaise, 0),
  }
}
