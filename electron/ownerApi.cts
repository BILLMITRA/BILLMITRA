import { randomBytes, createHash } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { z } from 'zod'
import { verifyPasswordHash } from '../shared/staffSecurity.js'
import { posChannels } from '../shared/posChannels.js'
import type { createPosBackend } from './backend.cjs'

type Row = RowDataPacket & Record<string, unknown>
type Branch = { id: string; name: string; timezone: string; currencyCode: string }
type BranchSummary = Branch & { paidBills: number; paidSalesPaise: number; previousPaidSalesPaise: number; discountPaise: number; taxPaise: number; collectedPaise: number; refundedPaise: number; statuses: { status: unknown; count: number }[]; hours: { hourLocal: number; amountPaise: number }[] | null; payments: { method: unknown; amountPaise: number }[]; topProducts: { name: unknown; quantity: number }[]; recentSales: { id: string; orderNumber: number; paidAt: unknown; totalPaise: number }[] }
type Backend = ReturnType<typeof createPosBackend>
type Session = { staffId: string; restaurantId: string; expiresAt: number; backendSessions: Map<string, number> }
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const scopeSchema = z.object({ branchId: z.string().max(64).optional(), date: dateSchema }).strict()
const money = (value: unknown) => Number(value ?? 0)
const sqlTime = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ')

export class OwnerApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

/** Resolve a business date to UTC without requiring MySQL timezone tables. */
export function ownerDayBounds(day: string, timezone: string): [string, string] {
  const parsed = dateSchema.parse(day)
  const start = new Date(`${parsed}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== parsed) throw new Error('Choose a valid date.')
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  const localToUtc = (desired: Date) => {
    let guess = desired.getTime()
    for (let attempt = 0; attempt < 3; attempt++) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(part => [part.type, part.value]))
      const seen = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
      guess += desired.getTime() - seen
    }
    return new Date(guess)
  }
  return [sqlTime(localToUtc(start)), sqlTime(localToUtc(new Date(start.getTime() + 86_400_000)))]
}

export class OwnerApi {
  private readonly sessions = new Map<string, Session>()
  private readonly attempts = new Map<string, { count: number; until: number }>()
  private nextBackendId = 1_000_000_000
  constructor(private readonly pool: Pool, private readonly backends: Map<string, Backend> = new Map(),
    private readonly beforeWrite: (branchId: string) => Promise<void> = async () => {},
    private readonly afterWrite: (branchId: string) => Promise<void> = async () => {}) {
    const timer = setInterval(() => {
      for (const [key, session] of this.sessions) if (session.expiresAt <= Date.now()) this.revoke(key, session)
      for (const [username, attempt] of this.attempts) if (attempt.until <= Date.now()) this.attempts.delete(username)
    }, 60_000)
    timer.unref()
  }

  private async rows(sql: string, parameters: unknown[] = []): Promise<Row[]> {
    const [rows] = await this.pool.execute<Row[]>(sql, parameters)
    return rows
  }

  private async branches(session: Session): Promise<Branch[]> {
    const rows = await this.rows(`SELECT b.id, b.name, b.timezone, b.currency_code AS currencyCode
      FROM branches b JOIN staff_branch_access a ON a.branch_id = b.id
      JOIN staff_users s ON s.id = a.staff_id
      WHERE a.staff_id = ? AND s.restaurant_id = ? AND s.role = 'owner' AND s.active = 1
        AND b.restaurant_id = s.restaurant_id AND b.active = 1 ORDER BY b.name`, [session.staffId, session.restaurantId])
    return rows.map(row => ({ id: String(row.id), name: String(row.name), timezone: String(row.timezone), currencyCode: String(row.currencyCode) }))
  }

  private revoke(key: string, session?: Session) {
    this.sessions.delete(key)
    for (const [branchId, backendId] of session?.backendSessions ?? []) this.backends.get(branchId)?.logout(backendId)
  }

  private async session(token: string): Promise<{ session: Session; branches: Branch[] }> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new OwnerApiError(401, 'Sign in to BillMitra Owner again.')
    const key = createHash('sha256').update(token).digest('hex')
    const session = this.sessions.get(key)
    if (!session || session.expiresAt <= Date.now()) { this.revoke(key, session); throw new OwnerApiError(401, 'Sign in to BillMitra Owner again.') }
    const branches = await this.branches(session)
    if (!branches.length) { this.revoke(key, session); throw new OwnerApiError(403, 'Owner branch access is unavailable.') }
    session.expiresAt = Date.now() + 8 * 60 * 60 * 1000
    return { session, branches }
  }

  async login(raw: unknown) {
    const input = z.object({ username: z.string().trim().toLowerCase().min(3).max(80), password: z.string().min(1).max(128) }).strict().parse(raw)
    const attempts = this.attempts.get(input.username)
    if (attempts && attempts.count >= 5 && attempts.until > Date.now()) throw new OwnerApiError(429, 'Too many attempts. Try again in five minutes.')
    const rows = await this.rows(`SELECT id, restaurant_id AS restaurantId, username, display_name AS displayName,
      password_salt AS salt, password_hash AS hash, active, locked_until AS lockedUntil
      FROM staff_users WHERE username = ? AND role = 'owner' LIMIT 100`, [input.username])
    const matches = rows.filter(row => Number(row.active) === 1 && (!row.lockedUntil || new Date(String(row.lockedUntil)).getTime() <= Date.now())
      && verifyPasswordHash(input.password, String(row.salt), String(row.hash)))
    if (matches.length === 0) {
      this.attempts.set(input.username, { count: (attempts?.until && attempts.until > Date.now() ? attempts.count : 0) + 1, until: Date.now() + 5 * 60_000 })
      throw new OwnerApiError(401, 'Invalid owner username or password.')
    }
    if (matches.length > 1) throw new OwnerApiError(409, 'Multiple owner accounts use these credentials. Give each organization a unique owner username or password.')
    const owner = matches[0]
    this.attempts.delete(input.username)
    if (this.sessions.size >= 1000) throw new OwnerApiError(503, 'Too many owner sessions. Try again later.')
    const token = randomBytes(32).toString('hex')
    const session: Session = { staffId: String(owner.id), restaurantId: String(owner.restaurantId), expiresAt: Date.now() + 8 * 60 * 60 * 1000, backendSessions: new Map() }
    const branches = await this.branches(session)
    if (!branches.length) throw new OwnerApiError(403, 'This owner has no active branch access.')
    for (const branch of branches) {
      const backend = this.backends.get(branch.id)
      if (!backend) continue
      const backendId = ++this.nextBackendId
      try {
        const identity = backend.invoke(posChannels.loginStaff, backendId, input) as { role: string }
        if (identity.role === 'owner') session.backendSessions.set(branch.id, backendId)
        else backend.logout(backendId)
      } catch { backend.logout(backendId) }
    }
    this.sessions.set(createHash('sha256').update(token).digest('hex'), session)
    return { token, owner: { id: owner.id, displayName: owner.displayName, username: owner.username }, branches,
      writableBranchIds: [...session.backendSessions.keys()] }
  }

  async invoke(token: string, action: string, raw: unknown): Promise<unknown> {
    const { session, branches } = await this.session(token)
    if (action === 'logout') {
      this.revoke(createHash('sha256').update(token).digest('hex'), session)
      return null
    }
    if (action === 'me') return { branches }
    if (action === 'summary' || action === 'reports' || action === 'ask') {
      const input = action === 'ask'
        ? z.object({ ...scopeSchema.shape, question: z.string().trim().min(1).max(500) }).strict().parse(raw)
        : scopeSchema.parse(raw)
      const selected = input.branchId ? branches.filter(branch => branch.id === input.branchId) : branches
      if (!selected.length) throw new OwnerApiError(403, 'You do not have access to that branch.')
      const result = await this.summary(selected, input.date)
      if (action === 'ask') return this.answer((input as typeof input & { question: string }).question, result)
      return result
    }
    if (action === 'orders') {
      const input = z.object({ branchId: z.string().max(64).optional(), date: dateSchema, status: z.string().max(30).optional(), search: z.string().trim().max(100).optional(), offset: z.number().int().min(0).max(5000).default(0) }).strict().parse(raw)
      const selected = input.branchId ? branches.filter(branch => branch.id === input.branchId) : branches
      if (!selected.length) throw new OwnerApiError(403, 'You do not have access to that branch.')
      const branchFilters = selected.map(() => '(o.branch_id = ? AND o.created_at >= ? AND o.created_at < ?)').join(' OR ')
      const branchParameters = selected.flatMap(branch => [branch.id, ...ownerDayBounds(input.date, branch.timezone)])
      const where = `(${branchFilters}) AND (? = '' OR o.status = ?) AND (? = '' OR o.customer_name LIKE ? OR CAST(o.display_number AS CHAR) LIKE ?)`
      const parameters = [...branchParameters, input.status ?? '', input.status ?? '', input.search ?? '', `%${input.search ?? ''}%`, `%${input.search ?? ''}%`]
      const total = money((await this.rows(`SELECT COUNT(*) AS count FROM orders o WHERE ${where}`, parameters))[0].count)
      const rows = await this.rows(`SELECT o.id, o.branch_id AS branchId, b.name AS branchName, o.display_number AS orderNumber,
        o.order_type AS orderType, o.status, o.customer_name AS customerName, o.total_paise AS totalPaise,
        o.created_at AS createdAt, o.paid_at AS paidAt, o.voided_at AS voidedAt, t.label AS tableName
        FROM orders o JOIN branches b ON b.id = o.branch_id LEFT JOIN dining_tables t ON t.id = o.table_id
        WHERE ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT 50 OFFSET ?`, [...parameters, input.offset])
      return { orders: rows.map(row => ({ ...row, totalPaise: money(row.totalPaise) })), total, nextOffset: input.offset + 50 < total ? input.offset + 50 : null }
    }
    if (action === 'order') {
      const input = z.object({ id: z.string().uuid() }).strict().parse(raw)
      const ids = branches.map(branch => branch.id)
      const rows = await this.rows(`SELECT o.*, b.name AS branchName, t.label AS tableName FROM orders o
        JOIN branches b ON b.id = o.branch_id LEFT JOIN dining_tables t ON t.id = o.table_id
        WHERE o.id = ? AND o.branch_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`, [input.id, ...ids])
      if (!rows.length) throw new OwnerApiError(404, 'Order not found in your branches.')
      const items = await this.rows('SELECT item_name AS name, quantity, unit_price_paise AS unitPricePaise, tax_rate_bps AS taxRateBps, note FROM order_items WHERE order_id = ? ORDER BY created_at', [input.id])
      const payments = await this.rows('SELECT method, amount_paise AS amountPaise, created_at AS createdAt FROM payment_tenders WHERE order_id = ? ORDER BY created_at', [input.id])
      return { order: rows[0], items, payments }
    }
    if (action === 'products') {
      const input = z.object({ branchId: z.string().max(64).optional() }).strict().parse(raw)
      const selected = input.branchId ? branches.filter(branch => branch.id === input.branchId) : branches
      if (!selected.length) throw new OwnerApiError(403, 'You do not have access to that branch.')
      return { categories: await this.rows('SELECT id, name FROM menu_categories WHERE restaurant_id = ? ORDER BY sort_order, name', [session.restaurantId]),
        products: await this.rows(`SELECT p.id, p.name, p.description, p.tax_rate_bps AS taxRateBps,
        p.active, p.category_id AS categoryId, c.name AS category, bp.branch_id AS branchId, bp.price_paise AS pricePaise, bp.available
        FROM menu_items p JOIN menu_categories c ON c.id = p.category_id
        JOIN branch_menu_prices bp ON bp.item_id = p.id WHERE bp.branch_id IN (${selected.map(() => '?').join(',')})
        ORDER BY c.sort_order, p.name`, selected.map(branch => branch.id)) }
    }
    if (action === 'save-product') {
      const input = z.object({ branchId: z.string().max(64), id: z.string().uuid().optional(), categoryId: z.string().uuid(),
        name: z.string().trim().min(1).max(120), description: z.string().trim().max(500),
        pricePaise: z.number().int().min(0).max(100_000_000), taxRateBps: z.number().int().min(0).max(10000), available: z.boolean() }).strict().parse(raw)
      if (!branches.some(branch => branch.id === input.branchId)) throw new OwnerApiError(403, 'You do not have access to that branch.')
      const backend = this.backends.get(input.branchId)
      const backendId = session.backendSessions.get(input.branchId)
      if (!backend || !backendId) throw new OwnerApiError(403, 'Owner editing is unavailable for this branch. Sign in to its POS account first.')
      try { await this.beforeWrite(input.branchId) } catch { throw new OwnerApiError(503, 'MySQL is unavailable. Product was not changed.') }
      const { branchId: _branchId, ...product } = input
      let result: unknown
      try { result = backend.invoke(posChannels.saveProduct, backendId, product) }
      catch (error) {
        if (error instanceof z.ZodError) throw error
        const message = error instanceof Error ? error.message : ''
        throw new OwnerApiError(/SQLITE|no such table|constraint failed/i.test(message) ? 503 : 400,
          /SQLITE|no such table|constraint failed/i.test(message) ? 'Product could not be saved. Retry after the server is checked.' : message || 'Product could not be saved.')
      }
      try { await this.afterWrite(input.branchId) } catch { throw new OwnerApiError(503, 'The product may have saved locally. Refresh before trying again.') }
      return result
    }
    if (action === 'inventory') {
      const input = z.object({ branchId: z.string().max(64).optional() }).strict().parse(raw)
      const selected = input.branchId ? branches.filter(branch => branch.id === input.branchId) : branches
      if (!selected.length) throw new OwnerApiError(403, 'You do not have access to that branch.')
      return { items: await this.rows(`SELECT id, branch_id AS branchId, name, unit, quantity_milli AS quantityMilli,
        reorder_at_milli AS reorderMilli FROM inventory_items WHERE active = 1
        AND branch_id IN (${selected.map(() => '?').join(',')}) ORDER BY name`, selected.map(branch => branch.id)) }
    }
    if (action === 'adjust-stock') {
      const input = z.object({ branchId: z.string().max(64), requestId: z.string().uuid(), itemId: z.string().uuid(),
        deltaMilli: z.number().int().min(-1_000_000_000).max(1_000_000_000).refine(value => value !== 0),
        reason: z.string().trim().min(3).max(250) }).strict().parse(raw)
      if (!branches.some(branch => branch.id === input.branchId)) throw new OwnerApiError(403, 'You do not have access to that branch.')
      const backend = this.backends.get(input.branchId)
      const backendId = session.backendSessions.get(input.branchId)
      if (!backend || !backendId) throw new OwnerApiError(403, 'Owner stock editing is unavailable for this branch.')
      try { await this.beforeWrite(input.branchId) } catch { throw new OwnerApiError(503, 'MySQL is unavailable. Stock was not changed.') }
      const { branchId: _branchId, ...movement } = input
      let result: unknown
      try { result = backend.invoke(posChannels.moveStock, backendId, movement) }
      catch (error) {
        if (error instanceof z.ZodError) throw error
        const message = error instanceof Error ? error.message : ''
        throw new OwnerApiError(/SQLITE|no such table|constraint failed/i.test(message) ? 503 : 400,
          /SQLITE|no such table|constraint failed/i.test(message) ? 'Stock could not be changed. Retry after the server is checked.' : message || 'Stock could not be changed.')
      }
      try { await this.afterWrite(input.branchId) } catch { throw new OwnerApiError(503, 'Stock may have changed locally. Retry the same adjustment or refresh before making another.') }
      return result
    }
    if (action === 'staff') {
      const input = z.object({ branchId: z.string().max(64).optional() }).strict().parse(raw)
      const selected = input.branchId ? branches.filter(branch => branch.id === input.branchId) : branches
      if (!selected.length) throw new OwnerApiError(403, 'You do not have access to that branch.')
      return { staff: await this.rows(`SELECT DISTINCT s.id, s.display_name AS displayName, s.role, a.branch_id AS branchId
        FROM staff_users s JOIN staff_branch_access a ON a.staff_id = s.id
        WHERE s.active = 1 AND s.restaurant_id = ? AND a.branch_id IN (${selected.map(() => '?').join(',')})
        ORDER BY s.display_name`, [session.restaurantId, ...selected.map(branch => branch.id)]) }
    }
    throw new OwnerApiError(404, 'Unknown owner operation.')
  }

  private async summary(branches: Branch[], date: string) {
    const branchSummaries: BranchSummary[] = []
    for (const branch of branches) {
      const [from, to] = ownerDayBounds(date, branch.timezone)
      const previous = new Date(`${date}T00:00:00Z`)
      previous.setUTCDate(previous.getUTCDate() - 1)
      const [previousFrom, previousTo] = ownerDayBounds(previous.toISOString().slice(0, 10), branch.timezone)
      const paid = (await this.rows(`SELECT COUNT(*) AS paidBills, COALESCE(SUM(total_paise),0) AS paidSalesPaise,
        COALESCE(SUM(discount_paise),0) AS discountPaise, COALESCE(SUM(tax_paise),0) AS taxPaise
        FROM orders WHERE branch_id = ? AND paid_at >= ? AND paid_at < ? AND voided_at IS NULL`, [branch.id, from, to]))[0]
      const tender = (await this.rows(`SELECT COALESCE(SUM(t.amount_paise),0) AS collectedPaise FROM payment_tenders t
        JOIN orders o ON o.id = t.order_id WHERE o.branch_id = ? AND t.created_at >= ? AND t.created_at < ?`, [branch.id, from, to]))[0]
      const refund = (await this.rows(`SELECT COALESCE(SUM(r.amount_paise),0) AS refundedPaise FROM payment_refunds r
        JOIN payment_tenders t ON t.id = r.tender_id JOIN orders o ON o.id = t.order_id
        WHERE o.branch_id = ? AND r.created_at >= ? AND r.created_at < ?`, [branch.id, from, to]))[0]
      const status = await this.rows(`SELECT status, COUNT(*) AS count FROM orders WHERE branch_id = ? AND created_at >= ? AND created_at < ? GROUP BY status`, [branch.id, from, to])
      const priorPaid = (await this.rows(`SELECT COALESCE(SUM(total_paise),0) AS total FROM orders
        WHERE branch_id = ? AND paid_at >= ? AND paid_at < ? AND voided_at IS NULL`, [branch.id, previousFrom, previousTo]))[0]
      const payments = await this.rows(`SELECT t.method, COALESCE(SUM(t.amount_paise),0) AS amountPaise
        FROM payment_tenders t JOIN orders o ON o.id = t.order_id
        WHERE o.branch_id = ? AND t.created_at >= ? AND t.created_at < ? GROUP BY t.method`, [branch.id, from, to])
      const topProducts = await this.rows(`SELECT i.item_name AS name, SUM(i.quantity) AS quantity FROM order_items i
        JOIN orders o ON o.id = i.order_id WHERE o.branch_id = ? AND o.paid_at >= ? AND o.paid_at < ?
        AND o.voided_at IS NULL GROUP BY i.item_name ORDER BY quantity DESC, name LIMIT 5`, [branch.id, from, to])
      const recentSales = await this.rows(`SELECT id, display_number AS orderNumber, paid_at AS paidAt, total_paise AS totalPaise
        FROM orders WHERE branch_id = ? AND paid_at >= ? AND paid_at < ? AND voided_at IS NULL
        ORDER BY paid_at DESC, id DESC LIMIT 10`, [branch.id, from, to])
      const paidRows = await this.rows(`SELECT paid_at AS paidAt, total_paise AS totalPaise FROM orders
        WHERE branch_id = ? AND paid_at >= ? AND paid_at < ? AND voided_at IS NULL ORDER BY paid_at LIMIT 10001`, [branch.id, from, to])
      const hourly = Array.from({ length: 24 }, (_, hourLocal) => ({ hourLocal, amountPaise: 0 }))
      if (paidRows.length <= 10000) {
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone: branch.timezone, hour: '2-digit', hourCycle: 'h23' })
        for (const row of paidRows) {
          const paidAt = row.paidAt instanceof Date ? row.paidAt : new Date(`${String(row.paidAt).replace(' ', 'T')}Z`)
          hourly[Number(formatter.format(paidAt))].amountPaise += money(row.totalPaise)
        }
      }
      branchSummaries.push({ ...branch, paidBills: money(paid.paidBills), paidSalesPaise: money(paid.paidSalesPaise), previousPaidSalesPaise: money(priorPaid.total), discountPaise: money(paid.discountPaise), taxPaise: money(paid.taxPaise), collectedPaise: money(tender.collectedPaise), refundedPaise: money(refund.refundedPaise), statuses: status.map(row => ({ status: row.status, count: money(row.count) })), hours: paidRows.length > 10000 ? null : hourly, payments: payments.map(row => ({ method: row.method, amountPaise: money(row.amountPaise) })), topProducts: topProducts.map(row => ({ name: row.name, quantity: money(row.quantity) })), recentSales: recentSales.map(row => ({ id: String(row.id), orderNumber: money(row.orderNumber), paidAt: row.paidAt, totalPaise: money(row.totalPaise) })) })
    }
    const sum = (key: 'paidBills' | 'paidSalesPaise' | 'previousPaidSalesPaise' | 'discountPaise' | 'taxPaise' | 'collectedPaise' | 'refundedPaise') => branchSummaries.reduce((value, branch) => value + branch[key], 0)
    return { date, updatedAt: new Date().toISOString(), branches: branchSummaries,
      totals: { paidBills: sum('paidBills'), paidSalesPaise: sum('paidSalesPaise'), previousPaidSalesPaise: sum('previousPaidSalesPaise'), discountPaise: sum('discountPaise'), taxPaise: sum('taxPaise'), collectedPaise: sum('collectedPaise'), refundedPaise: sum('refundedPaise'), netCollectionsPaise: sum('collectedPaise') - sum('refundedPaise') } }
  }

  private answer(question: string, summary: Awaited<ReturnType<OwnerApi['summary']>>) {
    const q = question.toLowerCase()
    const amount = (paise: number) => `₹${(paise / 100).toFixed(2)}`
    if (/delay|late/.test(q)) return { answer: 'Delayed-order timing is not available in the current order data. Open Orders to review active bills.', updatedAt: summary.updatedAt }
    if (/best|highest|top/.test(q) && /branch|location/.test(q)) {
      const ranked = [...summary.branches].sort((a, b) => b.paidSalesPaise - a.paidSalesPaise)
      return { answer: ranked.length ? `${ranked[0].name} had the highest paid sales on ${summary.date}: ${amount(ranked[0].paidSalesPaise)}.` : 'No authorized branches are available.', updatedAt: summary.updatedAt }
    }
    if (/product|item/.test(q) && /top|best|popular/.test(q)) {
      const leaders = summary.branches.flatMap(branch => branch.topProducts.map(product => `${branch.name}: ${product.name} (${product.quantity} sold)`))
      return { answer: leaders.length ? `Top products by branch on ${summary.date}:\n${leaders.join('\n')}` : `No paid product sales were recorded on ${summary.date}.`, updatedAt: summary.updatedAt }
    }
    if (/pending|preparing|ready/.test(q)) {
      const active = summary.branches.flatMap(branch => branch.statuses).filter(row => ['ordering', 'preparing', 'ready', 'payment_pending'].includes(String(row.status)))
      return { answer: `${active.reduce((total, row) => total + row.count, 0)} active orders were created on ${summary.date} in the selected branches.`, updatedAt: summary.updatedAt }
    }
    if (/average|avg/.test(q) && /order|bill|sale/.test(q)) {
      const average = summary.totals.paidBills ? Math.round(summary.totals.paidSalesPaise / summary.totals.paidBills) : 0
      return { answer: `Average paid bill on ${summary.date}: ${amount(average)} across ${summary.totals.paidBills} paid bills.`, updatedAt: summary.updatedAt }
    }
    if (/yesterday|previous|compare|change/.test(q)) {
      return { answer: `Paid sales on ${summary.date}: ${amount(summary.totals.paidSalesPaise)}. Previous business day: ${amount(summary.totals.previousPaidSalesPaise)}.`, updatedAt: summary.updatedAt }
    }
    if (/payment|cash|card|upi/.test(q)) {
      const methods = new Map<string, number>()
      for (const branch of summary.branches) for (const payment of branch.payments) methods.set(String(payment.method), (methods.get(String(payment.method)) ?? 0) + payment.amountPaise)
      return { answer: methods.size ? `Tender collections on ${summary.date}: ${[...methods].map(([method, value]) => `${method} ${amount(value)}`).join(', ')}.` : `No tender collections were recorded on ${summary.date}.`, updatedAt: summary.updatedAt }
    }
    if (/branch|location/.test(q)) return { answer: summary.branches.length ? summary.branches.map(branch => `${branch.name}: ${amount(branch.paidSalesPaise)} from ${branch.paidBills} paid bills`).join('\n') : 'No authorized branches are available.', updatedAt: summary.updatedAt }
    if (/refund/.test(q)) return { answer: `Refunds on ${summary.date}: ${amount(summary.totals.refundedPaise)}.`, updatedAt: summary.updatedAt }
    if (/order|bill/.test(q)) return { answer: `${summary.totals.paidBills} paid bills on ${summary.date}. Unpaid bills are excluded.`, updatedAt: summary.updatedAt }
    if (/sales|sell|revenue|collect/.test(q)) return { answer: `Paid sales on ${summary.date}: ${amount(summary.totals.paidSalesPaise)}. Net collections after refunds: ${amount(summary.totals.netCollectionsPaise)}.`, updatedAt: summary.updatedAt }
    return { answer: 'I can answer paid sales, bill counts, branch and product leaders, active orders, average bill, payment methods and refunds for the selected date. Choose a branch or date and ask again.', updatedAt: summary.updatedAt }
  }
}
