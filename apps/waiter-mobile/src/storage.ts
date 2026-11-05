import * as SQLite from 'expo-sqlite'
import * as SecureStore from 'expo-secure-store'
import type { KitchenRequest, Line, OrderInput, PrintInput, SaveBillInput, Session } from './api'

const sessionKey = 'billmitra-waiter-session'
const db = SQLite.openDatabaseAsync('waiter-local.sqlite')
async function ready() {
  const database = await db
  await database.execAsync('CREATE TABLE IF NOT EXISTS drafts (scope TEXT NOT NULL, table_id TEXT NOT NULL, lines TEXT NOT NULL, PRIMARY KEY(scope, table_id)); CREATE TABLE IF NOT EXISTS pending (scope TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pending_print (scope TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pending_save (scope TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pending_kitchen (scope TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS heard_waiting_alerts (scope TEXT NOT NULL, alert_id TEXT NOT NULL, PRIMARY KEY(scope, alert_id)); CREATE TABLE IF NOT EXISTS heard_staff_notifications (scope TEXT NOT NULL, kind TEXT NOT NULL, notification_id TEXT NOT NULL, PRIMARY KEY(scope, kind, notification_id)); CREATE TABLE IF NOT EXISTS staff_message_read (scope TEXT PRIMARY KEY, created_at TEXT NOT NULL, message_id TEXT NOT NULL);')
  return database
}
export const scopeOf = (session: Session) => `${session.server}|${session.branch.id}|${session.staff.id}`
export async function copyLocalWorkToServer(session: Session, newServer: string) {
  const oldScope = scopeOf(session)
  const newScope = `${newServer}|${session.branch.id}|${session.staff.id}`
  if (oldScope === newScope) return
  const database = await ready()
  await database.withExclusiveTransactionAsync(async transaction => {
    await transaction.runAsync('INSERT OR IGNORE INTO drafts(scope,table_id,lines) SELECT ?,table_id,lines FROM drafts WHERE scope = ?', newScope, oldScope)
    for (const table of ['pending', 'pending_print', 'pending_save', 'pending_kitchen']) {
      await transaction.runAsync(`INSERT OR IGNORE INTO ${table}(scope,payload) SELECT ?,payload FROM ${table} WHERE scope = ?`, newScope, oldScope)
    }
  })
  // Keep the old scope as a recovery copy if sign-in at the new address fails.
}
export async function loadSession(): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(sessionKey)
  if (!raw) return null
  try { return JSON.parse(raw) as Session } catch { return null }
}
export const saveSession = (session: Session) => SecureStore.setItemAsync(sessionKey, JSON.stringify(session))
export const clearSession = () => SecureStore.deleteItemAsync(sessionKey)
export async function hasHeardWaitingAlert(scope: string, alertId: string) {
  return !!await (await ready()).getFirstAsync('SELECT 1 FROM heard_waiting_alerts WHERE scope=? AND alert_id=?', scope, alertId)
}
export async function markWaitingAlertHeard(scope: string, alertId: string) {
  await (await ready()).runAsync('INSERT OR IGNORE INTO heard_waiting_alerts(scope,alert_id) VALUES(?,?)', scope, alertId)
}
export async function hasHeardStaffNotification(scope: string, kind: 'voice' | 'kitchen' | 'order', id: string) {
  return !!await (await ready()).getFirstAsync('SELECT 1 FROM heard_staff_notifications WHERE scope=? AND kind=? AND notification_id=?', scope, kind, id)
}
export async function markStaffNotificationHeard(scope: string, kind: 'voice' | 'kitchen' | 'order', id: string) {
  await (await ready()).runAsync('INSERT OR IGNORE INTO heard_staff_notifications(scope,kind,notification_id) VALUES(?,?,?)', scope, kind, id)
}
export async function getStaffMessageRead(scope: string) {
  return (await ready()).getFirstAsync<{ created_at: string; message_id: string }>('SELECT created_at,message_id FROM staff_message_read WHERE scope=?', scope)
}
export async function markStaffMessagesRead(scope: string, createdAt: string, messageId: string) {
  await (await ready()).runAsync('INSERT INTO staff_message_read(scope,created_at,message_id) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET created_at=excluded.created_at,message_id=excluded.message_id WHERE excluded.created_at > staff_message_read.created_at OR (excluded.created_at = staff_message_read.created_at AND excluded.message_id > staff_message_read.message_id)', scope, createdAt, messageId)
}
export async function getDraft(scope: string, tableId: string): Promise<Line[]> {
  const row = await (await ready()).getFirstAsync<{ lines: string }>('SELECT lines FROM drafts WHERE scope = ? AND table_id = ?', scope, tableId)
  return row ? JSON.parse(row.lines) as Line[] : []
}
export async function putDraft(scope: string, tableId: string, lines: Line[]) {
  await (await ready()).runAsync('INSERT INTO drafts(scope,table_id,lines) VALUES(?,?,?) ON CONFLICT(scope,table_id) DO UPDATE SET lines=excluded.lines', scope, tableId, JSON.stringify(lines))
}
export async function getPending(scope: string): Promise<OrderInput | null> {
  const row = await (await ready()).getFirstAsync<{ payload: string }>('SELECT payload FROM pending WHERE scope = ?', scope)
  return row ? JSON.parse(row.payload) as OrderInput : null
}
export async function putPending(scope: string, input: OrderInput) {
  await (await ready()).runAsync('INSERT INTO pending(scope,payload) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload', scope, JSON.stringify(input))
}
export async function clearPending(scope: string) { await (await ready()).runAsync('DELETE FROM pending WHERE scope = ?', scope) }
export async function getPendingPrint(scope: string): Promise<PrintInput | null> {
  const row = await (await ready()).getFirstAsync<{ payload: string }>('SELECT payload FROM pending_print WHERE scope = ?', scope)
  return row ? JSON.parse(row.payload) as PrintInput : null
}
export async function putPendingPrint(scope: string, input: PrintInput) {
  await (await ready()).runAsync('INSERT INTO pending_print(scope,payload) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload', scope, JSON.stringify(input))
}
export async function clearPendingPrint(scope: string) { await (await ready()).runAsync('DELETE FROM pending_print WHERE scope = ?', scope) }
export async function getPendingSave(scope: string): Promise<SaveBillInput | null> {
  const row = await (await ready()).getFirstAsync<{ payload: string }>('SELECT payload FROM pending_save WHERE scope = ?', scope)
  return row ? JSON.parse(row.payload) as SaveBillInput : null
}
export async function putPendingSave(scope: string, input: SaveBillInput) {
  await (await ready()).runAsync('INSERT INTO pending_save(scope,payload) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload', scope, JSON.stringify(input))
}
export async function clearPendingSave(scope: string) { await (await ready()).runAsync('DELETE FROM pending_save WHERE scope = ?', scope) }
export async function getPendingKitchen(scope: string): Promise<KitchenRequest | null> {
  const row = await (await ready()).getFirstAsync<{ payload: string }>('SELECT payload FROM pending_kitchen WHERE scope = ?', scope)
  return row ? JSON.parse(row.payload) as KitchenRequest : null
}
export async function putPendingKitchen(scope: string, input: KitchenRequest) {
  await (await ready()).runAsync('INSERT INTO pending_kitchen(scope,payload) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload', scope, JSON.stringify(input))
}
export async function clearPendingKitchen(scope: string) { await (await ready()).runAsync('DELETE FROM pending_kitchen WHERE scope = ?', scope) }
