import { describe, expect, it } from 'vitest'
import type { DeliveryScheduleEntry } from './domain'
import { deliveryDelayMinutes, filterDeliverySchedule } from './delivery'

function entry(overrides: Partial<DeliveryScheduleEntry> = {}): DeliveryScheduleEntry {
  return {
    id: 'order-1',
    reference: 'HD-1',
    orderNumber: 1,
    createdAt: '2026-10-14 10:00:00',
    scheduledPickupAt: null,
    promisedDeliveryAt: '2026-10-14T10:30:00.000Z',
    actualPickupAt: null,
    dispatchedAt: null,
    deliveredAt: null,
    deliveryStatus: 'pending',
    foodStatus: 'ready',
    paymentStatus: 'unpaid',
    customerName: 'Maya Rao',
    contactNumber: '9876543210',
    deliveryAddress: '18 Market Road',
    deliveryArea: 'Central',
    deliveryLandmark: 'Clock Tower',
    deliveryInstructions: '',
    assignedDeliveryTo: '',
    rider: null,
    totalPaise: 15000,
    items: [],
    ...overrides,
  }
}

describe('delivery schedule helpers', () => {
  it('searches persisted order references, customer names, phones, riders, areas and addresses', () => {
    const entries = [entry(), entry({
      id: 'order-2',
      reference: 'HD-12',
      deliveryStatus: 'assigned',
      deliveryArea: 'North Park',
      rider: {
        id: 'rider-1', name: 'Arun Kumar', employeeCode: '', contactNumber: '',
        active: true, availability: 'available', maxActiveDeliveries: 1,
        activeDeliveryCount: 1, completedDeliveryCount: 0, lastStatusUpdate: '2026-10-14T10:00:00Z', canAcceptDelivery: false,
        derivedAvailability: 'busy',
      },
    })]
    expect(filterDeliverySchedule(entries, { query: 'hd-12' })).toHaveLength(1)
    expect(filterDeliverySchedule(entries, { query: '9876543210' })).toHaveLength(2)
    expect(filterDeliverySchedule(entries, { query: 'arun' })[0].id).toBe('order-2')
    expect(filterDeliverySchedule(entries, { query: 'north park' })).toHaveLength(1)
    expect(filterDeliverySchedule(entries, { status: 'unassigned' })).toHaveLength(1)
    expect(filterDeliverySchedule(entries, { status: 'assigned' })).toHaveLength(1)
  })

  it('calculates late minutes and excludes completed or cancelled deliveries', () => {
    const now = new Date('2026-10-14T10:45:59.000Z')
    expect(deliveryDelayMinutes(entry(), now)).toBe(15)
    expect(deliveryDelayMinutes(entry({ deliveryStatus: 'delivered' }), now)).toBe(0)
    expect(deliveryDelayMinutes(entry({ deliveryStatus: 'cancelled' }), now)).toBe(0)
    expect(deliveryDelayMinutes(entry({ deliveryStatus: 'failed' }), now)).toBe(15)
    expect(deliveryDelayMinutes(entry({ promisedDeliveryAt: null }), now)).toBe(0)
  })
})
