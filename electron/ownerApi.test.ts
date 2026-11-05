import { describe, expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createPasswordHash } from '../shared/staffSecurity'
import { OwnerApi, OwnerApiError, ownerDayBounds } from './ownerApi.cjs'
import type { createPosBackend } from './backend.cjs'

describe('owner API', () => {
  it('uses branch-local day boundaries for reports', () => {
    expect(ownerDayBounds('2026-10-27', 'Asia/Kolkata')).toEqual(['2026-10-26 18:30:00', '2026-10-27 18:30:00'])
    expect(() => ownerDayBounds('2026-02-30', 'Asia/Kolkata')).toThrow()
  })

  it('authenticates only an owner and refuses another branch before querying its data', async () => {
    const hash = createPasswordHash('owner-test-password')
    const queries: string[] = []
    const pool = { execute: async (sql: string) => {
      queries.push(sql)
      if (sql.includes('FROM staff_users WHERE username')) return [[{ id: 'owner-id', restaurantId: 'restaurant-id', username: 'owner', displayName: 'Owner', salt: hash.salt, hash: hash.hash, active: 1, lockedUntil: null }]]
      if (sql.includes('FROM branches b JOIN staff_branch_access')) return [[{ id: 'main', name: 'Vengara', timezone: 'Asia/Kolkata', currencyCode: 'INR' }]]
      throw new Error('Unexpected data query')
    } } as unknown as Pool
    const api = new OwnerApi(pool)
    await expect(api.login({ username: 'owner', password: 'wrong' })).rejects.toMatchObject({ status: 401 })
    const session = await api.login({ username: 'owner', password: 'owner-test-password' })
    expect(session.branches.map(branch => branch.id)).toEqual(['main'])
    const before = queries.length
    await expect(api.invoke(session.token, 'products', { branchId: 'another-restaurant' })).rejects.toMatchObject({ status: 403 })
    expect(queries.length).toBe(before + 1) // authorization lookup only
    await expect(api.invoke('invalid', 'me', null)).rejects.toBeInstanceOf(OwnerApiError)
  })

  it('keeps paid sales separate from collections and refunds', async () => {
    const hash = createPasswordHash('owner-test-password')
    const pool = { execute: async (sql: string) => {
      if (sql.includes('FROM staff_users WHERE username')) return [[{ id: 'owner-id', restaurantId: 'restaurant-id', username: 'owner', displayName: 'Owner', salt: hash.salt, hash: hash.hash, active: 1, lockedUntil: null }]]
      if (sql.includes('FROM branches b JOIN staff_branch_access')) return [[{ id: 'main', name: 'Vengara', timezone: 'Asia/Kolkata', currencyCode: 'INR' }]]
      if (sql.includes('paidBills')) return [[{ paidBills: '2', paidSalesPaise: '30000', discountPaise: '2000', taxPaise: '1000' }]]
      if (sql.includes('AS collectedPaise')) return [[{ collectedPaise: '25000' }]]
      if (sql.includes('AS refundedPaise')) return [[{ refundedPaise: '3000' }]]
      if (sql.includes('GROUP BY status')) return [[{ status: 'paid', count: '2' }]]
      if (sql.includes('AS total FROM orders')) return [[{ total: '10000' }]]
      if (sql.includes('GROUP BY t.method')) return [[{ method: 'cash', amountPaise: '25000' }]]
      if (sql.includes('GROUP BY i.item_name')) return [[{ name: 'Tea', quantity: '3' }]]
      if (sql.includes('AS orderNumber')) return [[{ id: 'paid-order', orderNumber: 42, paidAt: new Date('2026-10-27T04:30:00Z'), totalPaise: '30000' }]]
      if (sql.includes('paid_at AS paidAt')) return [[{ paidAt: new Date('2026-10-27T04:30:00Z'), totalPaise: '30000' }]]
      throw new Error('Unexpected query')
    } } as unknown as Pool
    const api = new OwnerApi(pool)
    const session = await api.login({ username: 'owner', password: 'owner-test-password' })
    const summary = await api.invoke(session.token, 'summary', { date: '2026-10-27' }) as { totals: Record<string, number>; branches: { hours: { hourLocal: number; amountPaise: number }[]; recentSales: { orderNumber: number; totalPaise: number }[] }[] }
    expect(summary.totals).toMatchObject({ paidBills: 2, paidSalesPaise: 30000, collectedPaise: 25000, refundedPaise: 3000, netCollectionsPaise: 22000 })
    expect(summary.branches[0].hours[10].amountPaise).toBe(30000)
    expect(summary.branches[0].recentSales).toEqual([{ id: 'paid-order', orderNumber: 42, paidAt: new Date('2026-10-27T04:30:00Z'), totalPaise: 30000 }])
    const average = await api.invoke(session.token, 'ask', { date: '2026-10-27', question: 'What is the average bill?' }) as { answer: string }
    expect(average.answer).toContain('₹150.00')
    const products = await api.invoke(session.token, 'ask', { date: '2026-10-27', question: 'Top products?' }) as { answer: string }
    expect(products.answer).toContain('Vengara: Tea (3 sold)')
  })

  it('routes product changes through the existing owner POS validation and MySQL sync', async () => {
    const hash = createPasswordHash('owner-test-password')
    const invoked: string[] = []
    const pool = { execute: async (sql: string) => {
      if (sql.includes('FROM staff_users WHERE username')) return [[{ id: 'owner-id', restaurantId: 'restaurant-id', username: 'owner', displayName: 'Owner', salt: hash.salt, hash: hash.hash, active: 1, lockedUntil: null }]]
      if (sql.includes('FROM branches b JOIN staff_branch_access')) return [[{ id: 'main', name: 'Vengara', timezone: 'Asia/Kolkata', currencyCode: 'INR' }]]
      throw new Error('Unexpected query')
    } } as unknown as Pool
    const backend = { invoke: (channel: string) => { invoked.push(channel); return channel === 'staff:login' ? { role: 'owner' } : { id: 'item' } }, logout: () => {} } as unknown as ReturnType<typeof createPosBackend>
    const api = new OwnerApi(pool, new Map([['main', backend]]), async () => { invoked.push('mysql-before') }, async () => { invoked.push('mysql-after') })
    const session = await api.login({ username: 'owner', password: 'owner-test-password' })
    expect(session.writableBranchIds).toEqual(['main'])
    await expect(api.invoke(session.token, 'save-product', { branchId: 'elsewhere', categoryId: '00000000-0000-4000-8000-000000000001', name: 'Tea', description: '', pricePaise: 1000, taxRateBps: 0, available: true })).rejects.toMatchObject({ status: 403 })
    await api.invoke(session.token, 'save-product', { branchId: 'main', categoryId: '00000000-0000-4000-8000-000000000001', name: 'Tea', description: '', pricePaise: 1000, taxRateBps: 0, available: true })
    expect(invoked.slice(-3)).toEqual(['mysql-before', 'menu:save-product', 'mysql-after'])
  })

  it('paginates only orders from the owner branch and selected business day', async () => {
    const hash = createPasswordHash('owner-test-password')
    const orderQueries: { sql: string; values: unknown[] }[] = []
    const pool = { execute: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('FROM staff_users WHERE username')) return [[{ id: 'owner-id', restaurantId: 'restaurant-id', username: 'owner', displayName: 'Owner', salt: hash.salt, hash: hash.hash, active: 1, lockedUntil: null }]]
      if (sql.includes('FROM branches b JOIN staff_branch_access')) return [[{ id: 'main', name: 'Vengara', timezone: 'Asia/Kolkata', currencyCode: 'INR' }]]
      orderQueries.push({ sql, values })
      if (sql.includes('COUNT(*) AS count')) return [[{ count: '51' }]]
      if (sql.includes('LIMIT 50 OFFSET ?')) return [[{ id: 'order-id', totalPaise: '1299' }]]
      throw new Error('Unexpected query')
    } } as unknown as Pool
    const api = new OwnerApi(pool)
    const session = await api.login({ username: 'owner', password: 'owner-test-password' })
    const page = await api.invoke(session.token, 'orders', { branchId: 'main', date: '2026-10-27', status: 'paid', search: 'Shan', offset: 0 }) as { orders: { totalPaise: number }[]; total: number; nextOffset: number }
    expect(page).toMatchObject({ total: 51, nextOffset: 50, orders: [{ totalPaise: 1299 }] })
    expect(orderQueries).toHaveLength(2)
    expect(orderQueries[0].values.slice(0, 3)).toEqual(['main', '2026-10-26 18:30:00', '2026-10-27 18:30:00'])
    expect(orderQueries[1].sql).toContain('LIMIT 50 OFFSET ?')
  })
})
