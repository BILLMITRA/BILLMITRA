import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, copyFileSync, renameSync, lstatSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import type { BackupInfo } from '../../shared/restaurant.js'

// A lease prevents another current BillMitra process or restore command from opening the same database.
export function acquireDatabaseLease(databasePath: string) {
  if (databasePath === ':memory:') return { release() {} }
  const path = resolve(databasePath) + '.lock'
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    let pid: number
    try { pid = Number(readFileSync(path, 'utf8')); if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error() } catch { throw new Error('Invalid database lock. Stop BillMitra and inspect the lock file before continuing.') }
    let alive = true
    try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
    if (alive) throw new Error('This database is already open in another BillMitra process. Stop it before continuing.')
    unlinkSync(path)
  }
  const handle = openSync(path, 'wx')
  writeFileSync(handle, String(process.pid)); closeSync(handle)
  let released = false
  return { release() { if (!released) { released = true; unlinkSync(path) } } }
}

function verify(path: string, restore = false) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const result = db.prepare('PRAGMA integrity_check').all()
    if (result.length !== 1 || Object.values(result[0])[0] !== 'ok') throw new Error('Backup failed the SQLite integrity check.')
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup has invalid database references.')
    if (restore) {
      const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]
      if (!versions.length || versions.some((row, index) => row.version !== index + 1) || versions.length > 16) throw new Error('Backup schema is unsupported by this version of BillMitra.')
      db.prepare('SELECT id, request_id, total_paise FROM orders LIMIT 1').all()
      db.prepare('SELECT id, product_name, unit_price_paise FROM order_items LIMIT 1').all()
    }
  } finally { db.close() }
}

export class DatabaseBackupService {
  private timer?: ReturnType<typeof setInterval>
  private readonly directory: string
  private readonly prefix: string
  constructor(private readonly db: DatabaseSync, private readonly databasePath: string) {
    this.directory = join(dirname(resolve(databasePath)), 'backups')
    this.prefix = basename(databasePath) + '.backup-'
  }
  start() {
    if (this.databasePath === ':memory:') return
    if (statSync(this.databasePath).size > 0) this.create()
    this.timer = setInterval(() => {
      try { this.create() } catch (error) { console.error('Automatic backup failed:', error instanceof Error ? error.message : 'unknown error') }
    }, 24 * 60 * 60 * 1000)
    this.timer.unref()
  }
  stop() { if (this.timer) clearInterval(this.timer) }
  create(): BackupInfo {
    if (this.databasePath === ':memory:') throw new Error('In-memory databases do not support persistent backups.')
    mkdirSync(this.directory, { recursive: true })
    const name = this.prefix + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID() + '.sqlite'
    const path = join(this.directory, name)
    try { this.db.prepare('VACUUM INTO ?').run(path); verify(path) } catch (error) { if (existsSync(path)) unlinkSync(path); throw error }
    return { name, sizeBytes: statSync(path).size, createdAt: new Date().toISOString() }
  }
  list(): BackupInfo[] {
    if (this.databasePath === ':memory:' || !existsSync(this.directory)) return []
    return readdirSync(this.directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.startsWith(this.prefix) && entry.name.endsWith('.sqlite')).map(entry => {
      const info = statSync(join(this.directory, entry.name))
      return { name: entry.name, sizeBytes: info.size, createdAt: info.mtime.toISOString() }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}

export function restoreDatabase(databasePath: string, backupPath: string): { previousDatabase: string | null } {
  const target = resolve(databasePath)
  const source = resolve(backupPath)
  if (target === source) throw new Error('Choose a separate backup file.')
  if (existsSync(source + '-wal') && statSync(source + '-wal').size > 0) throw new Error('Choose a completed snapshot file, not a database with active WAL data.')
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Cannot restore over a symbolic link.')
  verify(source, true)
  const lease = acquireDatabaseLease(target)
  const staging = target + '.restore-' + randomUUID()
  let previousDatabase: string | null = null
  try {
    copyFileSync(source, staging)
    verify(staging, true)
    if (existsSync(target)) {
      const current = new DatabaseSync(target)
      try {
        const checkpoint = current.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
        if (checkpoint && Number(Object.values(checkpoint)[0]) !== 0) throw new Error('The database is busy. Stop all application processes before restoring.')
      } finally { current.close() }
      previousDatabase = target + '.before-restore-' + randomUUID() + '.sqlite'
      renameSync(target, previousDatabase)
    }
    try { renameSync(staging, target) } catch (error) { if (previousDatabase) renameSync(previousDatabase, target); throw error }
    return { previousDatabase }
  } finally { if (existsSync(staging)) unlinkSync(staging); lease.release() }
}
