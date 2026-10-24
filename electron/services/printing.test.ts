import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPosBackend } from '../backend.cjs'
import { DesktopPrintWorker, PrintOutcomeUnknown, type PrintAttempt } from './desktopPrintWorker.cjs'
import { printDocument } from './printDocument.cjs'
import type { MenuData, SavedOrder } from '../../shared/domain'
import type { ClaimedPrintJob, PrintDocument, PrintJobSummary } from '../../shared/printing'

let backend: ReturnType<typeof createPosBackend>
let directory: string
let order: SavedOrder
let productId: string
const deviceId = randomUUID()
const owner = { username: 'owner', displayName: 'Owner', password: 'printer-owner-123' }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'billmitra-print-'))
  backend = createPosBackend(join(directory, 'pos.sqlite'))
  backend.invoke('staff:setup-owner', 1, owner)
  for (const [id, role] of [[2, 'waiter'], [3, 'kitchen'], [4, 'cashier']] as const) {
    backend.invoke('staff:create', 1, { username: role, displayName: role, role, password: 'printer-staff-123' })
    backend.invoke('staff:login', id, { username: role, password: 'printer-staff-123' })
  }
  const menu = backend.invoke('pos:load-menu', 1) as MenuData
  productId = menu.products[0].id
  order = backend.invoke('pos:create-order', 2, { requestId: randomUUID(), type: 'dine_in', tableId: menu.tables[0].id, customerName: '', deliveryAddress: '', discount: null, items: [{ productId, quantity: 1, note: '<script>unsafe</script>' }] }) as SavedOrder
})
afterEach(() => { vi.restoreAllMocks(); backend.close(); rmSync(directory, { recursive: true, force: true }) })
const request = (kind = 'bill', ticketId?: string) => backend.invoke('print:request', 2, { requestId: randomUUID(), orderId: order.id, kind, ...(ticketId ? { ticketId } : {}) }) as PrintJobSummary
const claim = (sender = 4, kinds = ['bill', 'kot'], device = deviceId) => backend.invoke('print:claim', sender, { deviceId: device, kinds }) as ClaimedPrintJob | null
const tickets = () => (backend.invoke('waiter:menu', 2) as { activeOrders: { kitchenTickets: { id: string }[] }[] }).activeOrders[0].kitchenTickets

it('deduplicates phone retries, rejects changed payloads, and allows only desktop roles to claim', () => {
  const input = { requestId: randomUUID(), orderId: order.id, kind: 'bill' }
  const job = backend.invoke('print:request', 2, input)
  expect(backend.invoke('print:request', 2, input)).toEqual(job)
  expect(() => backend.invoke('print:request', 2, { ...input, kind: 'kot', ticketId: tickets()[0].id })).toThrow('different details')
  expect(() => claim(2)).toThrow('role')
  expect(() => claim(3, ['bill'])).toThrow('role')
  const claimed = claim()!
  expect(claimed.id).toBe(input.requestId)
  expect(claim()).toBeNull()
  expect(() => backend.invoke('print:finish', 4, { id: claimed.id, deviceId: randomUUID(), claimToken: claimed.claimToken, status: 'submitted' })).toThrow('claim')
  const result = { id: claimed.id, deviceId, claimToken: claimed.claimToken, status: 'submitted' }
  backend.invoke('print:finish', 4, result); backend.invoke('print:finish', 4, result)
  expect((backend.invoke('print:list', 4) as PrintJobSummary[])[0].status).toBe('submitted')
  expect(request().copy).toBe(true)
})
it('lets a cashier request table printing without granting waiter access or payment changes', () => {
  expect(() => backend.invoke('waiter:menu', 4)).toThrow('permission')
  const details = backend.invoke('print:details', 4, order.id) as { kitchenTickets: { id: string }[] }
  expect(details.kitchenTickets).toHaveLength(1)
  for (const kind of ['bill', 'kot']) {
    const input = { requestId: randomUUID(), orderId: order.id, kind, ...(kind === 'kot' ? { ticketId: details.kitchenTickets[0].id } : {}) }
    expect(() => backend.invoke('print:request-pos', 2, input)).toThrow('permission')
    const job = backend.invoke('print:request-pos', 4, input) as PrintJobSummary
    expect(job.kind).toBe(kind)
    expect(job.status).toBe('queued')
    expect(backend.invoke('print:request-pos', 4, input)).toEqual(job)
  }
  expect((backend.invoke('pos:get-order', 4, order.id) as SavedOrder).status).not.toBe('paid')
})
it('queues separate HD bills for one delivery run with the saved customer and rider details', () => {
  const deliveries = [1, 5].map(deliveryNumber => backend.invoke('pos:create-order', 4, {
    requestId: randomUUID(), type: 'delivery', deliveryNumber, tableId: null,
    customerName: `Customer ${deliveryNumber}`, contactNumber: '9876543210',
    deliveryAddress: '<Main Street>', deliveryArea: 'Vengara', deliveryLandmark: 'Market',
    discount: null, items: [{ productId, quantity: 1, note: '' }],
  }) as SavedOrder)
  for (const delivery of deliveries) {
    expect(backend.invoke('print:details', 4, delivery.id)).toMatchObject({ order: { id: delivery.id } })
    expect(backend.invoke('print:request-pos', 4, { requestId: randomUUID(), orderId: delivery.id, kind: 'bill' }))
      .toMatchObject({ status: 'queued' })
  }
  const jobs = [claim(4, ['bill']), claim(4, ['bill'])]
  expect(jobs.map(job => job?.orderId)).toEqual(deliveries.map(delivery => delivery.id))
  const html = printDocument('bill', jobs[0]!.document, { bill: '', kot: '', restaurant: 'BillMitra', branch: 'Vengara' })
  expect(html).toContain('HD-1')
  expect(html).toContain('&lt;Main Street&gt;')
  expect(html).toContain('9876543210')
  expect(() => backend.invoke('print:request-pos', 4, { requestId: randomUUID(), orderId: deliveries[0].id, kind: 'kot', ticketId: randomUUID() })).toThrow('kitchen workflow')
})
it('prints the selected immutable KOT batch, with notes and without prices', () => {
  backend.invoke('pos:create-order', 2, { requestId: randomUUID(), orderId: order.id, type: 'dine_in', tableId: order.tableId, customerName: '', deliveryAddress: '', discount: null, items: [{ productId, quantity: 2, note: 'Extra hot' }] })
  const batches = tickets()
  expect(batches).toHaveLength(2)
  request('kot', batches[1].id)
  const job = claim(3, ['kot'])!
  expect(job.document.order.items).toHaveLength(1)
  expect(job.document.order.items[0].quantity).toBe(2)
  const html = printDocument('kot', job.document, { bill: '', kot: '', restaurant: 'Chick <Buck>', branch: 'Vengara' })
  expect(html).toContain('Extra hot'); expect(html).toContain('Chick &lt;Buck&gt;')
  expect(html).not.toContain('Rs '); expect(html).not.toContain('Total:')
  expect(() => request('kot', randomUUID())).toThrow('batch')
})
it('rejects stale queued bills and does not change payment when requesting a print', () => {
  request()
  backend.invoke('pos:create-order', 2, { requestId: randomUUID(), orderId: order.id, type: 'dine_in', tableId: order.tableId, customerName: '', deliveryAddress: '', discount: null, items: [{ productId, quantity: 1, note: '' }] })
  expect(claim()).toBeNull()
  expect((backend.invoke('print:list', 4) as PrintJobSummary[])[0].status).toBe('failed')
  expect((backend.invoke('pos:get-order', 1, order.id) as SavedOrder).status).not.toBe('paid')
  const next = request(); expect(next.status).toBe('queued')
  backend.invoke('pos:record-payment', 1, { requestId: randomUUID(), orderId: order.id, method: 'cash' })
  expect(claim()).toBeNull()
  expect(() => request()).toThrow('open saved order')
})
it('marks an interrupted claim unknown, never requeues it, and accepts a late spooler acknowledgement', () => {
  request(); const job = claim()!
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121000)
  expect(claim(4, ['bill'], randomUUID())).toBeNull()
  expect((backend.invoke('print:list', 4) as PrintJobSummary[])[0].status).toBe('unknown')
  backend.invoke('print:finish', 4, { id: job.id, deviceId, claimToken: job.claimToken, status: 'submitted' })
  expect((backend.invoke('print:list', 4) as PrintJobSummary[])[0].status).toBe('submitted')
})
it('renders unpaid bill totals and escapes restaurant, product and note text', () => {
  request(); const job = claim()!
  const document: PrintDocument = { ...job.document, copy: true }
  const html = printDocument('bill', document, { bill: '', kot: '', restaurant: '<img src=x>', branch: 'Vengara' })
  expect(html).toContain('UNPAID BILL · COPY'); expect(html).toContain('Total: Rs ')
  expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;'); expect(html).not.toContain('<img src=x>')
})
it('retries only the acknowledgement after a connection failure, including after desktop restart', async () => {
  request()
  let pending: PrintAttempt | null = null
  let failedAck = true
  const spool = vi.fn(async () => {})
  const deps = { deviceId, kinds: (): ('bill')[] => ['bill'], load: () => pending, save: (value: PrintAttempt | null) => { pending = value }, spool,
    invoke: async (channel: string, input?: unknown) => { if (channel === 'print:finish' && failedAck) { failedAck = false; throw new Error('offline') } return backend.invoke(channel, 4, input) } }
  const worker = new DesktopPrintWorker(deps)
  await worker.tick(); expect((pending as PrintAttempt | null)?.status).toBe('submitted'); expect(spool).toHaveBeenCalledTimes(1)
  await new DesktopPrintWorker(deps).tick(); expect(pending).toBeNull(); expect(spool).toHaveBeenCalledTimes(1)
})
it('does not resubmit an OS print interrupted by desktop restart', async () => {
  request(); const job = claim()!
  let pending: PrintAttempt | null = { id: job.id, claimToken: job.claimToken, status: 'attempting', error: '' }
  const spool = vi.fn(async () => {})
  const worker = new DesktopPrintWorker({ deviceId, kinds: () => ['bill'], load: () => pending, save: value => { pending = value }, spool, invoke: async (channel, input) => backend.invoke(channel, 4, input) })
  await worker.tick(); expect(spool).not.toHaveBeenCalled(); expect(pending).toBeNull()
  expect((backend.invoke('print:list', 4) as PrintJobSummary[])[0].status).toBe('unknown')
})
it('reports a missing printer as failed and a spooler timeout as unknown without repeating either job', async () => {
  for (const cause of [new Error('Printer offline'), new PrintOutcomeUnknown('Spooler timed out')]) {
    const job = request()
    let pending: PrintAttempt | null = null
    const spool = vi.fn(async () => { throw cause })
    const worker = new DesktopPrintWorker({ deviceId, kinds: () => ['bill'], load: () => pending, save: value => { pending = value }, spool, invoke: async (channel, input) => backend.invoke(channel, 4, input) })
    await worker.tick(); await worker.tick()
    expect(spool).toHaveBeenCalledTimes(1)
    expect((backend.invoke('print:list', 4) as PrintJobSummary[]).find(row => row.id === job.id)?.status).toBe(cause instanceof PrintOutcomeUnknown ? 'unknown' : 'failed')
  }
})
it('keeps queued jobs persistent across a server restart and leaves unconfigured printer kinds queued', async () => {
  const job = request()
  backend.close(); backend = createPosBackend(join(directory, 'pos.sqlite'))
  backend.invoke('staff:login', 4, { username: 'cashier', password: 'printer-staff-123' })
  const invoke = vi.fn(async (channel: string, input?: unknown) => backend.invoke(channel, 4, input))
  const worker = new DesktopPrintWorker({ deviceId, kinds: () => [], load: () => null, save: () => {}, spool: vi.fn(), invoke })
  await worker.tick(); expect(invoke).not.toHaveBeenCalled()
  expect(claim()?.id).toBe(job.id)
})
