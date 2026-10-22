import { describe, expect, it } from 'vitest'
import { DELIVERY_SLOT_COUNT, PARCEL_SLOT_COUNT, formatOrderReference, isValidDeliveryNumber, isValidParcelNumber } from './domain'
import type { SavedOrder } from './domain'

function orderReference(type: SavedOrder['type'], orderNumber: number, deliveryNumber: number | null, parcelNumber: number | null = null) {
  return formatOrderReference({ type, orderNumber, deliveryNumber, parcelNumber })
}

describe('formatOrderReference', () => {
  it('uses sequential HD references for delivery orders', () => {
    expect(orderReference('delivery', 19, 4)).toBe('HD-4')
  })

  describe('delivery slots', () => {
    it('defines one hundred delivery slots', () => {
      expect(Array.from({ length: DELIVERY_SLOT_COUNT }, (_, index) => index + 1)).toEqual(
        Array.from({ length: 100 }, (_, index) => index + 1),
      )
    })

    it('accepts only whole slot numbers from 1 through 100', () => {
      expect(isValidDeliveryNumber(1)).toBe(true)
      expect(isValidDeliveryNumber(100)).toBe(true)
      expect(isValidDeliveryNumber(0)).toBe(false)
      expect(isValidDeliveryNumber(101)).toBe(false)
      expect(isValidDeliveryNumber(1.5)).toBe(false)
    })
  })

  it('keeps dine-in and legacy unnumbered takeaway references unchanged', () => {
    expect(orderReference('dine_in', 19, null)).toBe('#19')
    expect(orderReference('parcel', 20, null)).toBe('#20')
  })

  it('formats numbered takeaway references', () => {
    expect(orderReference('parcel', 20, null, 7)).toBe('P-7')
  })
})

describe('takeaway slots', () => {
  it('defines one hundred takeaway slots', () => {
    expect(Array.from({ length: PARCEL_SLOT_COUNT }, (_, index) => index + 1)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    )
  })

  it('accepts only whole takeaway slot numbers from 1 through 100', () => {
    expect(isValidParcelNumber(1)).toBe(true)
    expect(isValidParcelNumber(100)).toBe(true)
    expect(isValidParcelNumber(0)).toBe(false)
    expect(isValidParcelNumber(101)).toBe(false)
    expect(isValidParcelNumber(1.5)).toBe(false)
  })
})
