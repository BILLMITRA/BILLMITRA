const { readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { createPasswordHash } = require('../electron-dist/shared/staffSecurity.js')

const account = process.argv[2]
const password = process.argv[3]
if (!['owner', 'waiter'].includes(account) || !password) throw new Error('Usage: node scripts/change-mobile-test-password.cjs <owner|waiter> <new-password>')
const { salt, hash } = createPasswordHash(password)
const directory = resolve(__dirname, '../web-data/mobile-test')
const credentialsPath = resolve(directory, 'credentials.json')
const loginPath = resolve(directory, `${account}-login.txt`)
const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'))
const database = new DatabaseSync(resolve(directory, 'billmitra-web.sqlite'))

try {
  const result = database.prepare(`
    UPDATE staff_users SET password_salt = ?, password_hash = ?, failed_login_attempts = 0, locked_until = NULL
    WHERE username = ? AND role = ? AND active = 1
  `).run(salt, hash, credentials[account].username, account)
  if (result.changes !== 1) throw new Error(`Expected one active ${account} account; password was not changed.`)
  credentials[account].password = password
  writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
  const login = readFileSync(loginPath, 'utf8').replace(/^Password: .*$/m, `Password: ${password}`)
  writeFileSync(loginPath, login, { mode: 0o600 })
  console.log(`Mobile test ${account} password changed and local login file updated.`)
} finally {
  database.close()
}
