import { describe, expect, it } from 'vitest'
import type { DeliveryScheduleEntry } from './domain'
import { riderSettlementSummary } from './deliverySettlement'

const rider = { id: 'rider-1' } as DeliveryScheduleEntry['rider']
function bill(id: string, status: DeliveryScheduleEntry['deliveryStatus'], paymentStatus: DeliveryScheduleEntry['paymentStatus'], amount: number): DeliveryScheduleEntry {
  return { id, rider, assignedAt: '2026-10-24 08:30:00', deliveryStatus: status, paymentStatus,
    totalPaise: amount, collectedPaise: paymentStatus === 'paid' ? amount : 0,
    balancePaise: paymentStatus === 'unpaid' ? amount : 0 } as DeliveryScheduleEntry
}

describe('rider settlement totals', () => {
  it('lists the rider bills and separates paid invoices from delivered unpaid value', () => {
    const entries = [bill('hd-1', 'delivered', 'unpaid', 12000), bill('hd-5', 'dispatched', 'paid', 8000),
      { ...bill('other', 'delivered', 'unpaid', 5000), rider: { id: 'other' } as DeliveryScheduleEntry['rider'] }]
    const summary = riderSettlementSummary(entries, 'rider-1')
    expect(summary.bills.map(entry => entry.id)).toEqual(['hd-1', 'hd-5'])
    expect(summary).toMatchObject({ assignedCount: 2, deliveredCount: 1, outForDeliveryCount: 1,
      invoicePaise: 20000, collectedPaise: 8000, balancePaise: 12000, deliveredBalancePaise: 12000 })
  })
})
