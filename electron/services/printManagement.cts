import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { SavedOrder, StaffIdentity } from '../../shared/domain.js'
import type { ClaimedPrintJob, PrintDocument, PrintJobSummary, PrintKind } from '../../shared/printing.js'
import { staffHasPermission } from '../../shared/staffPermissions.js'

const requestSchema = z.object({ requestId: z.string().uuid(), orderId: z.string().uuid(), kind: z.enum(['bill', 'kot']), ticketId: z.string().uuid().optional(), copy: z.boolean().optional() }).strict()
const claimSchema = z.object({ deviceId: z.string().uuid(), kinds: z.array(z.enum(['bill', 'kot'])).min(1).max(2) }).strict()
const finishSchema = z.object({ id: z.string().uuid(), deviceId: z.string().uuid(), claimToken: z.string().uuid(), status: z.enum(['submitted', 'failed', 'unknown']), error: z.string().max(500).default('') }).strict()
type Row = PrintJobSummary & { documentJson: string; fingerprint: string; actorId: string; deviceId: string | null; claimToken: string | null }
const columns = `id,order_id AS orderId,kind,ticket_id AS ticketId,status,created_at AS createdAt,error,copy,
  document_json AS documentJson,fingerprint,actor_id AS actorId,device_id AS deviceId,claim_token AS claimToken`
const summary = (row: Row): PrintJobSummary => ({ id: row.id, orderId: row.orderId, kind: row.kind, ticketId: row.ticketId, status: row.status, createdAt: row.createdAt, error: row.error, copy: Boolean(row.copy) })

export class PrintManagementService {
  constructor(private db: DatabaseSync, private transaction: <T>(fn: () => T) => T, private order: (id: string) => SavedOrder | null) {}
  migrate() {
    this.transaction(() => {
      if (this.db.prepare('SELECT version FROM schema_migrations WHERE version=16').get()) return
      this.db.exec(`CREATE TABLE print_jobs (
        id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),kind TEXT NOT NULL CHECK(kind IN ('bill','kot')),
        ticket_id TEXT REFERENCES kitchen_tickets(id),actor_id TEXT NOT NULL,fingerprint TEXT NOT NULL,document_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','printing','submitted','failed','unknown')),copy INTEGER NOT NULL,
        error TEXT NOT NULL DEFAULT '',device_id TEXT,claim_token TEXT,claimed_at INTEGER,
        created_at TEXT NOT NULL DEFAULT(datetime('now')));
        CREATE INDEX print_jobs_queue ON print_jobs(status,created_at);
        CREATE INDEX print_jobs_order ON print_jobs(order_id);
        INSERT INTO schema_migrations(version) VALUES(16);`)
    })
  }
  private expire() {
    // An interrupted print may already have reached the spooler. Never automatically print it again.
    this.db.prepare("UPDATE print_jobs SET status='unknown',error='Desktop disconnected during printing. Check the printer before requesting a copy.' WHERE status='printing' AND claimed_at < ?").run(Date.now() - 120_000)
  }
  private row(id: string) { return this.db.prepare(`SELECT ${columns} FROM print_jobs WHERE id=?`).get(id) as Row | undefined }
  tickets(orderId: string) {
    return this.db.prepare('SELECT id,created_at AS createdAt FROM kitchen_tickets WHERE order_id=? ORDER BY rowid').all(orderId)
  }
  list(orderIds?: string[]): PrintJobSummary[] {
    this.expire()
    const rows = this.db.prepare(`SELECT ${columns} FROM print_jobs ORDER BY rowid DESC LIMIT 200`).all() as unknown as Row[]
    return rows.filter(row => !orderIds || orderIds.includes(row.orderId)).map(summary)
  }
  request(actor: StaffIdentity, raw: unknown): PrintJobSummary {
    const input = requestSchema.parse(raw)
    if ((input.kind === 'kot') !== Boolean(input.ticketId)) throw new Error('Choose a kitchen batch for KOT printing.')
    const fingerprint = JSON.stringify({ ...input, actorId: actor.id })
    return this.transaction(() => {
      const prior = this.row(input.requestId)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('This print request ID was already used for different details.')
        return summary(prior)
      }
      const order = this.order(input.orderId)
      if (!order || order.type !== 'dine_in' || ['paid', 'voided'].includes(order.status)) throw new Error('Refresh tables and select an open saved order.')
      const table = this.db.prepare('SELECT name,floor FROM restaurant_tables WHERE id=?').get(order.tableId!) as { name: string; floor: string }
      let ticketCreatedAt: string | null = null
      if (input.ticketId) {
        const ticket = this.db.prepare('SELECT items_json AS itemsJson,created_at AS createdAt FROM kitchen_tickets WHERE id=? AND order_id=?').get(input.ticketId, order.id) as { itemsJson: string; createdAt: string } | undefined
        if (!ticket) throw new Error('Kitchen batch not found. Refresh the table.')
        order.items = JSON.parse(ticket.itemsJson) as SavedOrder['items']
        ticketCreatedAt = ticket.createdAt
      }
      const copy = input.copy === true || Boolean(this.db.prepare("SELECT id FROM print_jobs WHERE order_id=? AND kind=? AND ticket_id IS ? AND status <> 'failed' LIMIT 1").get(order.id, input.kind, input.ticketId ?? null))
      const document: PrintDocument = { order, tableName: table.name, floor: table.floor, requestedBy: actor.displayName, ticketId: input.ticketId ?? null, ticketCreatedAt, copy }
      this.db.prepare("INSERT INTO print_jobs(id,order_id,kind,ticket_id,actor_id,fingerprint,document_json,status,copy) VALUES(?,?,?,?,?,?,?,'queued',?)").run(input.requestId, order.id, input.kind, input.ticketId ?? null, actor.id, fingerprint, JSON.stringify(document), Number(copy))
      this.db.prepare("INSERT INTO audit_log(id,action,entity_type,entity_id,actor,reason,details_json) VALUES(?,'print.requested','order',?,?,'waiter_request',?)").run(randomUUID(), order.id, actor.username, JSON.stringify({ jobId: input.requestId, kind: input.kind, ticketId: input.ticketId, copy }))
      return summary(this.row(input.requestId)!)
    })
  }
  claim(actor: StaffIdentity, raw: unknown): ClaimedPrintJob | null {
    const input = claimSchema.parse(raw)
    const allowed: PrintKind[] = staffHasPermission(actor.role, 'pos:access') ? ['bill', 'kot'] : staffHasPermission(actor.role, 'kitchen:operate') ? ['kot'] : []
    if (input.kinds.some(kind => !allowed.includes(kind))) throw new Error('This staff role cannot operate these printers.')
    return this.transaction(() => {
      this.expire()
      const rows = this.db.prepare(`SELECT ${columns} FROM print_jobs WHERE status='queued' ORDER BY rowid`).all() as unknown as Row[]
      for (const row of rows) {
        if (!input.kinds.includes(row.kind)) continue
        const document = JSON.parse(row.documentJson) as PrintDocument
        const order = this.order(row.orderId)
        const staleBill = row.kind === 'bill' && order && (order.status === 'paid' || order.totalPaise !== document.order.totalPaise || JSON.stringify(order.items) !== JSON.stringify(document.order.items))
        if (!order || order.status === 'voided' || staleBill) {
          this.db.prepare("UPDATE print_jobs SET status='failed',error='Order changed or closed. Request an updated print.' WHERE id=?").run(row.id)
          continue
        }
        const claimToken = randomUUID()
        this.db.prepare("UPDATE print_jobs SET status='printing',device_id=?,claim_token=?,claimed_at=? WHERE id=? AND status='queued'").run(input.deviceId, claimToken, Date.now(), row.id)
        return { ...summary(this.row(row.id)!), claimToken, document }
      }
      return null
    })
  }
  finish(actor: StaffIdentity, raw: unknown) {
    const input = finishSchema.parse(raw)
    return this.transaction(() => {
      const row = this.row(input.id)
      if (!row || row.deviceId !== input.deviceId || row.claimToken !== input.claimToken) throw new Error('Print claim does not match this desktop.')
      if (!staffHasPermission(actor.role, 'pos:access') && !(row.kind === 'kot' && staffHasPermission(actor.role, 'kitchen:operate'))) throw new Error('This staff role cannot operate this printer.')
      if (row.status === input.status) return
      if (row.status !== 'printing' && row.status !== 'unknown') throw new Error('Print result is already recorded.')
      this.db.prepare('UPDATE print_jobs SET status=?,error=? WHERE id=?').run(input.status, input.error, row.id)
      this.db.prepare("INSERT INTO audit_log(id,action,entity_type,entity_id,actor,reason,details_json) VALUES(?,'print.result','order',?,?,'desktop_spooler',?)").run(randomUUID(), row.orderId, actor.username, JSON.stringify({ jobId: row.id, status: input.status, deviceId: input.deviceId }))
    })
  }
}
