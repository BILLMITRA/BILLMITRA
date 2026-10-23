import * as SQLite from 'expo-sqlite'
import * as SecureStore from 'expo-secure-store'
import type { Line, OrderInput, PrintInput, Session } from './api'

const sessionKey = 'billmitra-waiter-session'
const db = SQLite.openDatabaseAsync('waiter-local.sqlite')
async function ready() {
  const database = await db
  await database.execAsync('CREATE TABLE IF NOT EXISTS drafts (scope TEXT NOT NULL, table_id TEXT NOT NULL, lines TEXT NOT NULL, PRIMARY KEY(scope, table_id)); CREATE TABLE IF NOT EXISTS pending (scope TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pending_print (scope TEXT PRIMARY KEY, payload TEXT NOT NULL);')
  return database
}
export const scopeOf = (session: Session) => `${session.server}|${session.branch.id}|${session.staff.id}`
export async function loadSession(): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(sessionKey)
  if (!raw) return null
  try { return JSON.parse(raw) as Session } catch { return null }
}
export const saveSession = (session: Session) => SecureStore.setItemAsync(sessionKey, JSON.stringify(session))
export const clearSession = () => SecureStore.deleteItemAsync(sessionKey)
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
