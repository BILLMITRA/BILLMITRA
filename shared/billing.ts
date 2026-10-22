export interface BillLine {
  unitPricePaise: number
  quantity: number
  taxRateBps: number
}

export type BillDiscount =
  | { kind: 'percentage'; valueBps: number }
  | { kind: 'fixed'; valuePaise: number }

export interface BillTotals {
  subtotalPaise: number
  discountPaise: number
  taxPaise: number
  totalPaise: number
}

function assertWholeNumber(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`)
  }
}

export function calculateTotals(lines: readonly BillLine[], discount: BillDiscount | null = null): BillTotals {
  for (const line of lines) {
    assertWholeNumber(line.unitPricePaise, 'Unit price')
    assertWholeNumber(line.quantity, 'Quantity')
    assertWholeNumber(line.taxRateBps, 'Tax rate')
    if (line.taxRateBps > 10_000) throw new RangeError('Tax rate cannot exceed 100%.')
  }

  const subtotalPaise = lines.reduce(
    (subtotal, line) => subtotal + line.unitPricePaise * line.quantity,
    0,
  )
  assertWholeNumber(subtotalPaise, 'Subtotal')

  let discountPaise = 0
  if (discount?.kind === 'percentage') {
    assertWholeNumber(discount.valueBps, 'Discount percentage')
    if (discount.valueBps > 10_000) throw new RangeError('Discount percentage cannot exceed 100%.')
    discountPaise = Number((BigInt(subtotalPaise) * BigInt(discount.valueBps) + 5_000n) / 10_000n)
  } else if (discount?.kind === 'fixed') {
    assertWholeNumber(discount.valuePaise, 'Fixed discount')
    if (discount.valuePaise > subtotalPaise) throw new RangeError('Discount cannot exceed the subtotal.')
    discountPaise = discount.valuePaise
  }

  const grossLines = lines.map((line) => line.unitPricePaise * line.quantity)
  const discountAllocations = grossLines.map((gross) => (
    subtotalPaise === 0 ? 0 : Number((BigInt(gross) * BigInt(discountPaise)) / BigInt(subtotalPaise))
  ))
  let unallocatedDiscount = discountPaise - discountAllocations.reduce((sum, amount) => sum + amount, 0)
  const allocationOrder = grossLines
    .map((gross, index) => ({
      index,
      remainder: subtotalPaise === 0 ? 0n : (BigInt(gross) * BigInt(discountPaise)) % BigInt(subtotalPaise),
    }))
    .sort((left, right) => {
      if (left.remainder > right.remainder) return -1
      if (left.remainder < right.remainder) return 1
      return left.index - right.index
    })
  for (const { index } of allocationOrder) {
    if (unallocatedDiscount === 0) break
    if (discountAllocations[index] < grossLines[index]) {
      discountAllocations[index] += 1
      unallocatedDiscount -= 1
    }
  }

  const taxPaise = lines.reduce((tax, line, index) => {
    const taxablePaise = grossLines[index] - discountAllocations[index]
    const lineTaxPaise = Number((BigInt(taxablePaise) * BigInt(line.taxRateBps) + 5_000n) / 10_000n)
    return tax + lineTaxPaise
  }, 0)

  return { subtotalPaise, discountPaise, taxPaise, totalPaise: subtotalPaise - discountPaise + taxPaise }
}

export function formatMoney(amountPaise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(amountPaise / 100)
}
