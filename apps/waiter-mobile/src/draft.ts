import type { Line } from './api'

export const productQuantity = (lines: Line[], productId: string) =>
  lines.reduce((total, line) => total + (line.productId === productId ? line.quantity : 0), 0)

export function adjustProduct(lines: Line[], productId: string, delta: 1 | -1): Line[] {
  const quantity = productQuantity(lines, productId)
  if ((delta === -1 && quantity === 0) || (delta === 1 && quantity >= 99)) return lines
  const index = delta === 1
    ? lines.findIndex(line => line.productId === productId && !line.note)
    : lines.findLastIndex(line => line.productId === productId)
  if (index === -1) return [...lines, { productId, quantity: 1, note: '' }]
  return lines.flatMap((line, i) => i !== index ? [line]
    : line.quantity + delta > 0 ? [{ ...line, quantity: line.quantity + delta }] : [])
}

export function tableFloors(tables: { floor: string }[]): string[] {
  return [...new Set(tables.map(table => table.floor))].sort((a, b) => {
    if (a.toLowerCase() === 'ground floor') return -1
    if (b.toLowerCase() === 'ground floor') return 1
    return a.localeCompare(b, undefined, { numeric: true })
  })
}
