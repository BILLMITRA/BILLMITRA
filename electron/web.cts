import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPosBackend } from './backend.cjs'
import { createWebServer } from './webServer.cjs'
import { z } from 'zod'

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
const setupToken = process.env.BILLMITRA_SETUP_TOKEN
if (origin && new URL(origin).origin !== origin) throw new Error('BILLMITRA_WEB_ORIGIN must contain only the scheme and host, without a trailing slash.')
if (host !== '127.0.0.1' && (!origin?.startsWith('https://') || !setupToken || setupToken.length < 32)) throw new Error('Network hosting requires an HTTPS BILLMITRA_WEB_ORIGIN and a BILLMITRA_SETUP_TOKEN of at least 32 characters.')
const branches: Array<{ id: string; name: string; backend: ReturnType<typeof createPosBackend> }> = []
try {
  for (const branch of branchConfig) branches.push({ ...branch, backend: createPosBackend(resolve(directory, branch.id === 'main' ? 'billmitra-web.sqlite' : `branch-${branch.id}.sqlite`)) })
} catch (error) { for (const branch of branches) branch.backend.close(); throw error }
const server = createWebServer({ backend: branches[0].backend, branches, origin, setupToken, assetsDirectory: resolve(__dirname, '../../dist') })
server.listen(port, host, () => {
  console.log(`BillMitra web: ${origin ?? `http://127.0.0.1:${port}`}`)
  console.log(`Database: ${directory}`)
})
server.on('error', error => {
  console.error(error.message)
  for (const branch of branches) branch.backend.close()
  process.exitCode = 1
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => { for (const branch of branches) branch.backend.close() }))
}
