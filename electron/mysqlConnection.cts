import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import mysql, { type Pool } from 'mysql2/promise'

type MySqlSettings = {
  host: string
  port: number
  database: string
  user: string
  password: string
}

/** Reads only the local, Git-ignored MySQL connection file. */
export function loadMySqlSettings(): MySqlSettings | null {
  const path = resolve(process.env.BILLMITRA_MYSQL_CONFIG ?? '.env.mysql.local')
  if (!existsSync(path)) return null
  const entries = new Map<string, string>()
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals > 0) entries.set(line.slice(0, equals), line.slice(equals + 1))
  }
  const host = entries.get('BILLMITRA_MYSQL_HOST')
  const port = Number(entries.get('BILLMITRA_MYSQL_PORT'))
  const database = entries.get('BILLMITRA_MYSQL_DATABASE')
  const user = entries.get('BILLMITRA_MYSQL_USER')
  const password = entries.get('BILLMITRA_MYSQL_PASSWORD')
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !database || !user || !password) {
    throw new Error('BillMitra MySQL connection file is incomplete.')
  }
  return { host, port, database, user, password }
}

export async function connectMySql(settings: MySqlSettings): Promise<Pool> {
  const pool = mysql.createPool({
    ...settings,
    connectionLimit: 4,
    waitForConnections: true,
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    timezone: 'Z',
  })
  try {
    const [rows] = await pool.query<Array<{ version: number } & import('mysql2').RowDataPacket>>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    )
    if (rows[0]?.version !== 1) throw new Error('BillMitra MySQL schema version is unsupported.')
    return pool
  } catch (error) {
    await pool.end()
    throw error
  }
}
