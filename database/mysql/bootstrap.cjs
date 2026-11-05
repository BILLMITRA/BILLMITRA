const { randomBytes } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const projectRoot = resolve(__dirname, '../..')
const configPath = join(projectRoot, '.env.mysql.local')
const schemaPath = join(__dirname, '001_initial.sql')
const mysql = 'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysql.exe'
const loginEditor = 'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysql_config_editor.exe'
const base = ['--login-path=billmitra-setup', '--protocol=tcp', '--port=3306', '--batch', '--skip-column-names']

function execute(sql, database) {
  const args = [...base, ...(database ? ['--database=' + database] : []), '--execute', sql]
  const result = spawnSync(mysql, args, { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('MySQL could not complete a setup query. Check the local login path and service.')
  return result.stdout.trim()
}

function importSchema() {
  const sql = readFileSync(schemaPath, 'utf8')
  const result = spawnSync(mysql, [...base, '--database=billmitra'], { input: sql, encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) {
    const line = /at line (\d+)/i.exec(result.stderr)?.[1]
    throw new Error('MySQL schema import failed' + (line ? ' at line ' + line : '') + '. Inspect the database before retrying.')
  }
}

function main() {
  if (!existsSync(mysql) || !existsSync(loginEditor)) throw new Error('MySQL 8.4 client is not installed at the expected path.')
  if (existsSync(configPath)) throw new Error('The BillMitra MySQL configuration already exists. Do not overwrite it.')
  const version = execute('SELECT VERSION()')
  if (!version.startsWith('8.4.')) throw new Error('This setup requires MySQL 8.4 LTS.')
  execute('CREATE DATABASE IF NOT EXISTS billmitra CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci')
  const count = Number(execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'billmitra'"))
  if (count === 0) importSchema()
  else if (count !== 25 || execute('SELECT COUNT(*) FROM schema_migrations WHERE version = 1', 'billmitra') !== '1') {
    throw new Error('The billmitra database is partially initialized or has an unexpected schema. No account was created.')
  }
  const existingAccount = execute("SELECT COUNT(*) FROM mysql.user WHERE user = 'billmitra_app' AND host = '127.0.0.1'")
  if (existingAccount !== '0') throw new Error('The billmitra_app account already exists. No password was changed.')
  const password = randomBytes(36).toString('base64url')
  // The generated password never appears in process arguments or logs.
  const grants = "CREATE USER 'billmitra_app'@'127.0.0.1' IDENTIFIED BY '" + password
    + "'; GRANT SELECT, INSERT, UPDATE, DELETE ON billmitra.* TO 'billmitra_app'@'127.0.0.1';"
  const created = spawnSync(mysql, [...base], { input: grants, encoding: 'utf8', windowsHide: true })
  if (created.error || created.status !== 0) throw new Error('The database was created, but application account setup failed.')
  writeFileSync(configPath, [
    'BILLMITRA_MYSQL_HOST=127.0.0.1',
    'BILLMITRA_MYSQL_PORT=3306',
    'BILLMITRA_MYSQL_DATABASE=billmitra',
    'BILLMITRA_MYSQL_USER=billmitra_app',
    'BILLMITRA_MYSQL_PASSWORD=' + password,
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 })
  const removed = spawnSync(loginEditor, ['remove', '--login-path=billmitra-setup'], { encoding: 'utf8', windowsHide: true })
  if (removed.error || removed.status !== 0) throw new Error('Setup succeeded, but the temporary root login path could not be removed.')
  console.log('BillMitra MySQL ' + version + ': schema and dedicated application account ready.')
  console.log('The application configuration is stored locally and ignored by Git.')
}

try { main() }
catch (error) { console.error(error instanceof Error ? error.message : 'MySQL setup failed.'); process.exitCode = 1 }
