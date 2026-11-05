import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPosBackend } from './backend.cjs'
import { createWebServer } from './webServer.cjs'
import { connectMySql, loadMySqlSettings } from './mysqlConnection.cjs'
import { OwnerApi } from './ownerApi.cjs'
import { z } from 'zod'
import type { Pool } from 'mysql2/promise'

const { syncBranch } = require('../../database/mysql/import-branch.cjs') as {
  syncBranch: (options: { source: string; branchId: string; branchName: string; pool: Pool; commit: boolean }) => Promise<unknown>
}

const port = Number(process.env.BILLMITRA_WEB_PORT ?? 3000)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BILLMITRA_WEB_PORT.')
const directory = resolve(process.env.BILLMITRA_WEB_DATA_DIR ?? 'web-data')
mkdirSync(directory, { recursive: true })
const configurationFile = resolve(__dirname, '../../branches.json')
const branchConfig = z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), name: z.string().trim().min(1).max(120) })).min(1).max(100)
  .refine(branches => new Set(branches.map(branch => branch.id)).size === branches.length, 'Branch IDs must be unique.')
  .parse(JSON.parse(process.env.BILLMITRA_BRANCHES ?? (existsSync(configurationFile) ? readFileSync(configurationFile, 'utf8') : '[{"id":"main","name":"Main branch"}]')))
const host = process.env.BILLMITRA_WEB_HOST ?? '127.0.0.1'
const origin = process.env.BILLMITRA_WEB_ORIGIN
const ownerPublicOrigin = process.env.BILLMITRA_OWNER_PUBLIC_ORIGIN
const ownerTestOrigin = process.env.BILLMITRA_OWNER_TEST_ORIGIN
const ownerPort = Number(process.env.BILLMITRA_OWNER_PORT ?? 3018)
const setupToken = process.env.BILLMITRA_SETUP_TOKEN
if (origin && new URL(origin).origin !== origin) throw new Error('BILLMITRA_WEB_ORIGIN must contain only the scheme and host, without a trailing slash.')
if (host !== '127.0.0.1' && (!origin?.startsWith('https://') || !setupToken || setupToken.length < 32)) throw new Error('Network hosting requires an HTTPS BILLMITRA_WEB_ORIGIN and a BILLMITRA_SETUP_TOKEN of at least 32 characters.')
if (ownerPublicOrigin && (!ownerPublicOrigin.startsWith('https://') || new URL(ownerPublicOrigin).origin !== ownerPublicOrigin)) throw new Error('BILLMITRA_OWNER_PUBLIC_ORIGIN must be an HTTPS origin without a path or trailing slash.')
if (ownerPublicOrigin && ownerTestOrigin) throw new Error('Choose either permanent HTTPS owner access or local phone testing.')
const testUrl = ownerTestOrigin ? new URL(ownerTestOrigin) : null
const testAddress = testUrl?.hostname.split('.').map(Number) ?? []
const privateTestAddress = testAddress.length === 4 && testAddress.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
  && (testAddress[0] === 10 || (testAddress[0] === 192 && testAddress[1] === 168)
    || (testAddress[0] === 172 && testAddress[1] >= 16 && testAddress[1] <= 31))
if (ownerTestOrigin && (testUrl?.origin !== ownerTestOrigin || testUrl.protocol !== 'http:' || !privateTestAddress || Number(testUrl.port) !== ownerPort)) throw new Error('BILLMITRA_OWNER_TEST_ORIGIN must be an HTTP private Wi-Fi IPv4 address with BILLMITRA_OWNER_PORT.')
if ((ownerPublicOrigin || ownerTestOrigin) && (!Number.isInteger(ownerPort) || ownerPort < 1 || ownerPort > 65535 || ownerPort === port)) throw new Error('BILLMITRA_OWNER_PORT must be a separate valid port.')
const branches: Array<{ id: string; name: string; source: string; backend: ReturnType<typeof createPosBackend> }> = []
try {
  for (const branch of branchConfig) {
    const source = resolve(directory, branch.id === 'main' ? 'billmitra-web.sqlite' : `branch-${branch.id}.sqlite`)
    branches.push({ ...branch, source, backend: createPosBackend(source) })
  }
} catch (error) { for (const branch of branches) branch.backend.close(); throw error }

async function start() {
  let pool: Pool | undefined
  try {
    const mysqlSettings = loadMySqlSettings()
    if (!mysqlSettings) throw new Error('The MySQL connection file is missing. Configure .env.mysql.local before starting the restaurant server.')
    pool = await connectMySql(mysqlSettings)
    for (const branch of branches) await syncBranch({ source: branch.source, branchId: branch.id, branchName: branch.name, pool, commit: true })
    const syncQueues = new Map<string, Promise<void>>()
    const beforeWrite = async () => { await pool!.query('SELECT 1') }
    const afterWrite = async (branchId: string) => {
      const branch = branches.find(item => item.id === branchId)!
      const prior = syncQueues.get(branchId) ?? Promise.resolve()
      const next = prior.catch(() => undefined).then(async () => {
        await syncBranch({ source: branch.source, branchId, branchName: branch.name, pool: pool!, commit: true })
      })
      syncQueues.set(branchId, next)
      try { await next } finally { if (syncQueues.get(branchId) === next) syncQueues.delete(branchId) }
    }
    const ownerApi = new OwnerApi(pool, new Map(branches.map(branch => [branch.id, branch.backend])), beforeWrite, afterWrite)
    const server = createWebServer({
      backend: branches[0].backend, branches, origin, setupToken, assetsDirectory: resolve(__dirname, '../../dist'),
      ownerApi,
      beforeOrderWrite: beforeWrite, afterOrderWrite: afterWrite,
    })
    server.listen(port, host, () => {
      console.log(`BillMitra web: ${origin ?? `http://127.0.0.1:${port}`}`)
      console.log(`MySQL connected; order writes require MySQL confirmation.`)
    })
    server.on('error', error => { console.error(error.message); process.exitCode = 1 })
    const listeners = [server]
    const ownerOrigin = ownerPublicOrigin ?? ownerTestOrigin
    if (ownerOrigin) {
      const ownerServer = createWebServer({ backend: branches[0].backend, branches, origin: ownerOrigin,
        assetsDirectory: resolve(__dirname, '../../dist'), ownerApi, ownerOnly: true })
      ownerServer.listen(ownerPort, ownerTestOrigin ? testUrl!.hostname : '127.0.0.1', () => console.log(`BillMitra owner API: ${ownerOrigin}`))
      ownerServer.on('error', error => { console.error('Owner API listener failed:', error.message); process.exitCode = 1 })
      listeners.push(ownerServer)
    }
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        let remaining = listeners.length
        for (const listener of listeners) listener.close(() => {
          if (--remaining === 0) { for (const branch of branches) branch.backend.close(); void pool!.end() }
        })
      })
    }
  } catch (error) {
    console.error('BillMitra server could not start:', error instanceof Error ? error.message : 'unknown error')
    for (const branch of branches) branch.backend.close()
    if (pool) await pool.end()
    process.exitCode = 1
  }
}
void start()
