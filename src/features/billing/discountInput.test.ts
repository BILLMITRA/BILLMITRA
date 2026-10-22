import { describe, expect, it } from 'vitest'
import { parseDiscountInput } from './discountInput'

describe('parseDiscountInput', () => {
  it('converts percentage and rupee input to integer units', () => {
    expect(parseDiscountInput('percentage', '7.5', 10_000)).toEqual({
      discount: { kind: 'percentage', valueBps: 750 },
      error: '',
    })
    expect(parseDiscountInput('fixed', '12.34', 10_000)).toEqual({
      discount: { kind: 'fixed', valuePaise: 1_234 },
      error: '',
    })
  })

  it('rejects malformed or subtotal-exceeding discounts', () => {
    expect(parseDiscountInput('percentage', '101', 10_000).error).toMatch(/between 0% and 100%/)
    expect(parseDiscountInput('fixed', '10.001', 10_000).error).toMatch(/up to two decimal places/)
    expect(parseDiscountInput('fixed', '100.01', 10_000).error).toMatch(/cannot exceed/)
  })
})
