const { randomBytes } = require('node:crypto')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { createPosBackend } = require('../electron-dist/electron/backend.cjs')

const directory = resolve(__dirname, '../web-data/mobile-test')
const databasePath = join(directory, 'billmitra-web.sqlite')
const credentialsPath = join(directory, 'credentials.json')

if (existsSync(databasePath) || existsSync(credentialsPath)) {
  throw new Error('The mobile test database or credentials already exist. Existing accounts were left unchanged.')
}

mkdirSync(directory, { recursive: true })
const credentials = {
  branchId: 'main',
  owner: { username: 'owner', password: randomBytes(24).toString('base64url') },
  waiter: { username: 'waiter', password: randomBytes(24).toString('base64url') },
  setupToken: randomBytes(32).toString('hex'),
}

const backend = createPosBackend(databasePath)
try {
  backend.invoke('staff:setup-owner', 1, { ...credentials.owner, displayName: 'BillMitra Owner' })
  backend.invoke('staff:create', 1, { ...credentials.waiter, displayName: 'Test Waiter', role: 'waiter' })
  writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(`Mobile test accounts created. Credentials: ${credentialsPath}`)
} finally {
  backend.close()
}
