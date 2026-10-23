const { readFileSync } = require('node:fs')
const { request } = require('node:http')
const { resolve } = require('node:path')

const publicHost = process.argv[2]
if (!publicHost || !/^[a-z0-9.-]+$/.test(publicHost)) throw new Error('Usage: node scripts/check-mobile-test.cjs <public-hostname>')
const account = process.argv[3] ?? 'waiter'
if (!['owner', 'waiter'].includes(account)) throw new Error('Account must be owner or waiter.')
const credentials = JSON.parse(readFileSync(resolve(__dirname, '../web-data/mobile-test/credentials.json'), 'utf8'))
const { branchId } = credentials

async function call(action, input, token) {
  const body = JSON.stringify({ input })
  const { status, payload } = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: 3017, path: `/api/mobile/${action}`, method: 'POST',
      headers: { Host: publicHost, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => {
        try { resolve({ status: response.statusCode, payload: JSON.parse(text) }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
  if (status < 200 || status >= 300) throw new Error(`${action}: HTTP ${status}: ${payload.error ?? 'Unknown error'}`)
  return payload.result
}

;(async () => {
  const session = await call('login', { branchId, ...credentials[account] })
  try {
    const menu = await call('menu', null, session.token)
    if (session.staff.role !== account || session.branch.id !== branchId || !Array.isArray(menu.tables)) {
      throw new Error('Unexpected waiter session or menu response.')
    }
    const available = menu.products.filter(product => product.available)
    console.log(`Local ${account} sign-in works; branch ${session.branch.name}, ${menu.tables.length} tables, ${available.length} available products across ${menu.categories.length} categories.`)
  } finally {
    await call('logout', null, session.token)
  }
})().catch(error => { console.error(error.message); process.exitCode = 1 })
