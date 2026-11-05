import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export const WAITING_MS = 300_000
type Transaction = <T>(action: () => T) => T
type SessionRow = { id: string; tableId: string; seatedAt: number; status: string }
export type WaitingAlert = { id: string; tableId: string; tableName: string; seatedAt: number; createdAt: number; acknowledgedAt: number | null }

// A confirmed observation is currently supplied by a manager's test control.
// Camera observations can use the same state machine once a camera is configured.
export class CustomerWaitingService {
  private timer: ReturnType<typeof setInterval> | null = null
  private alertListeners = new Set<(alert: WaitingAlert) => void>()
  constructor(private db: DatabaseSync, private transaction: Transaction, private now: () => number = Date.now) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      try { this.list() } catch { /* Billing must keep running if alert evaluation fails. */ }
    }, 5000)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  onAlertCreated(listener: (alert: WaitingAlert) => void): () => void {
    this.alertListeners.add(listener)
    return () => { this.alertListeners.delete(listener) }
  }

  migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS customer_waiting_sessions (
      id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES restaurant_tables(id),
      seated_at_ms INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('waiting','served','ended')),
      ended_at_ms INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_waiting_session_per_table ON customer_waiting_sessions(table_id) WHERE status = 'waiting';
    CREATE TABLE IF NOT EXISTS customer_waiting_alerts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES customer_waiting_sessions(id),
      created_at_ms INTEGER NOT NULL, acknowledged_at_ms INTEGER, resolved_at_ms INTEGER
    );`)
  }

  private active(tableId: string): SessionRow | undefined {
    return this.db.prepare("SELECT id, table_id AS tableId, seated_at_ms AS seatedAt, status FROM customer_waiting_sessions WHERE table_id=? AND status='waiting'")
      .get(tableId) as SessionRow | undefined
  }

  private hasOrder(tableId: string, seatedAt: number): boolean {
    // An already open bill or a bill created during this seating session counts as service.
    return !!this.db.prepare(`SELECT 1 FROM orders WHERE table_id=? AND type='dine_in' AND voided_at IS NULL
      AND ((paid_at IS NULL AND status IN ('ordering','preparing','ready','payment_pending'))
        OR datetime(created_at) >= datetime(? / 1000, 'unixepoch')) LIMIT 1`).get(tableId, seatedAt)
  }

  private resolve(sessionId: string, status: 'served' | 'ended') {
    const at = this.now()
    this.db.prepare('UPDATE customer_waiting_sessions SET status=?, ended_at_ms=? WHERE id=? AND status=?')
      .run(status, at, sessionId, 'waiting')
    this.db.prepare('UPDATE customer_waiting_alerts SET resolved_at_ms=? WHERE session_id=? AND resolved_at_ms IS NULL')
      .run(at, sessionId)
  }

  confirm(tableId: string, occupied: boolean) {
    return this.transaction(() => {
      const table = this.db.prepare('SELECT id FROM restaurant_tables WHERE id=?').get(tableId)
      if (!table) throw new Error('Select an existing table.')
      const current = this.active(tableId)
      if (!occupied) {
        if (current) this.resolve(current.id, 'ended')
        return
      }
      if (current) return
      const at = this.now()
      const id = randomUUID()
      this.db.prepare("INSERT INTO customer_waiting_sessions(id,table_id,seated_at_ms,status) VALUES(?,?,?,'waiting')")
        .run(id, tableId, at)
      if (this.hasOrder(tableId, at)) this.resolve(id, 'served')
    })
  }

  // Called inside the order transaction so an accepted order wins the race with alert generation.
  orderPlaced(tableId: string) {
    const session = this.active(tableId)
    if (session) this.resolve(session.id, 'served')
  }

  list(): { alerts: WaitingAlert[]; seatedTableIds: string[] } {
    const createdIds = new Set<string>()
    const result = this.transaction(() => {
      const sessions = this.db.prepare("SELECT id, table_id AS tableId, seated_at_ms AS seatedAt, status FROM customer_waiting_sessions WHERE status='waiting'")
        .all() as SessionRow[]
      const at = this.now()
      for (const session of sessions) {
        if (this.hasOrder(session.tableId, session.seatedAt)) {
          this.resolve(session.id, 'served')
        } else if (at - session.seatedAt >= WAITING_MS) {
          const alertId = randomUUID()
          const inserted = this.db.prepare('INSERT OR IGNORE INTO customer_waiting_alerts(id,session_id,created_at_ms) VALUES(?,?,?)')
            .run(alertId, session.id, at)
          if (inserted.changes) createdIds.add(alertId)
        }
      }
      const alerts = this.db.prepare(`SELECT a.id, s.table_id AS tableId, t.name AS tableName,
        s.seated_at_ms AS seatedAt, a.created_at_ms AS createdAt, a.acknowledged_at_ms AS acknowledgedAt
        FROM customer_waiting_alerts a JOIN customer_waiting_sessions s ON s.id=a.session_id
        JOIN restaurant_tables t ON t.id=s.table_id
        WHERE a.resolved_at_ms IS NULL ORDER BY a.created_at_ms DESC`).all() as WaitingAlert[]
      return { alerts, seatedTableIds: sessions.filter(session => !!this.active(session.tableId)).map(session => session.tableId) }
    })
    for (const alert of result.alerts) if (createdIds.has(alert.id)) {
      for (const listener of this.alertListeners) {
        try { listener(alert) } catch { /* A notification failure must not interrupt billing. */ }
      }
    }
    return result
  }

  acknowledge(alertId: string) {
    return this.transaction(() => {
      this.db.prepare('UPDATE customer_waiting_alerts SET acknowledged_at_ms=? WHERE id=? AND resolved_at_ms IS NULL AND acknowledged_at_ms IS NULL')
        .run(this.now(), alertId)
    })
  }
}
