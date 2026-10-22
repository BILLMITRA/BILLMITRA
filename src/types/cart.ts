import type { Product } from '../../shared/domain'

export type CartLine = {
  product: Product
  quantity: number
  note: string
}
