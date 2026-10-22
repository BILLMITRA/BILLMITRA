import { describe, expect, it } from 'vitest'
import { calculateTotals, formatMoney } from './billing'

describe('calculateTotals', () => {
  it('calculates subtotal and per-line GST in integer paise', () => {
    expect(calculateTotals([
      { unitPricePaise: 28_900, quantity: 2, taxRateBps: 500 },
      { unitPricePaise: 8_900, quantity: 1, taxRateBps: 1_200 },
    ])).toEqual({
      subtotalPaise: 66_700,
      discountPaise: 0,
      taxPaise: 3_958,
      totalPaise: 70_658,
    })
  })

  it('rounds tax to a paise for each line', () => {
    expect(calculateTotals([
      { unitPricePaise: 1, quantity: 1, taxRateBps: 5_000 },
      { unitPricePaise: 1, quantity: 1, taxRateBps: 5_000 },
    ])).toEqual({ subtotalPaise: 2, discountPaise: 0, taxPaise: 2, totalPaise: 4 })
  })

  it('returns zero for an empty bill and formats rupees', () => {
    expect(calculateTotals([])).toEqual({ subtotalPaise: 0, discountPaise: 0, taxPaise: 0, totalPaise: 0 })
    expect(formatMoney(28_900)).toContain('289')
  })

  it('applies percentage discounts before calculating GST', () => {
    expect(calculateTotals(
      [{ unitPricePaise: 10_000, quantity: 1, taxRateBps: 500 }],
      { kind: 'percentage', valueBps: 1_000 },
    )).toEqual({ subtotalPaise: 10_000, discountPaise: 1_000, taxPaise: 450, totalPaise: 9_450 })
  })

  it('allocates a fixed discount proportionally across different tax rates', () => {
    expect(calculateTotals([
      { unitPricePaise: 10_000, quantity: 1, taxRateBps: 500 },
      { unitPricePaise: 10_000, quantity: 1, taxRateBps: 1_200 },
    ], { kind: 'fixed', valuePaise: 1_001 })).toEqual({
      subtotalPaise: 20_000,
      discountPaise: 1_001,
      taxPaise: 1_615,
      totalPaise: 20_614,
    })
  })

  it('rejects discounts greater than the subtotal', () => {
    expect(() => calculateTotals(
      [{ unitPricePaise: 100, quantity: 1, taxRateBps: 0 }],
      { kind: 'fixed', valuePaise: 101 },
    )).toThrow('Discount cannot exceed the subtotal.')
  })
})
