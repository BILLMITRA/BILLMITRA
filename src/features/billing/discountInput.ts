import type { BillDiscount } from '../../../shared/billing'

export type DiscountMode = 'none' | 'percentage' | 'fixed'

export interface ParsedDiscount {
  discount: BillDiscount | null
  error: string
}

export function parseDiscountInput(
  mode: DiscountMode,
  value: string,
  subtotalPaise: number,
): ParsedDiscount {
  if (mode === 'none' || value.trim() === '') return { discount: null, error: '' }

  if (mode === 'percentage') {
    if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value)) {
      return { discount: null, error: 'Enter a percentage with up to two decimal places.' }
    }
    const percent = Number(value)
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return { discount: null, error: 'Discount must be between 0% and 100%.' }
    }
    return { discount: { kind: 'percentage', valueBps: Math.round(percent * 100) }, error: '' }
  }

  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    return { discount: null, error: 'Enter a rupee amount with up to two decimal places.' }
  }
  const [rupees, paise = ''] = value.split('.')
  const amount = BigInt(rupees) * 100n + BigInt(paise.padEnd(2, '0'))
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { discount: null, error: 'The discount amount is too large.' }
  }
  const valuePaise = Number(amount)
  if (valuePaise > subtotalPaise) {
    return { discount: null, error: 'Discount cannot exceed the invoice subtotal.' }
  }
  return { discount: { kind: 'fixed', valuePaise }, error: '' }
}
