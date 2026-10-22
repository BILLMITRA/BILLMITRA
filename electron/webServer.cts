import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import { ZodError } from 'zod'
import { posChannels } from '../shared/posChannels.js'
import type { createPosBackend } from './backend.cjs'

type Backend = ReturnType<typeof createPosBackend>
type Branch = { id: string; name: string; backend: Backend }
type Options = { backend: Backend; branches?: Branch[]; assetsDirectory: string; origin?: string; setupToken?: string; sessionLifetimeMs?: number }
type Session = { id: number; expiresAt: number; branchId: string; backend: Backend }
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.jpg': 'image/jpeg',
}

export function createWebServer(options: Options) {
  const branches = options.branches ?? [{ id: 'main', name: 'Main branch', backend: options.backend }]
  if (!branches.length || branches.some(branch => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(branch.id) || !branch.name.trim()) || new Set(branches.map(branch => branch.id)).size !== branches.length) throw new Error('Branch IDs must be unique lowercase slugs and branch names are required.')
  if (options.origin && new URL(options.origin).origin !== options.origin) throw new Error('Configure an origin without a path or trailing slash.')
  const sessions = new Map<string, Session>()
  let nextId = 0
  const lifetime = options.sessionLifetimeMs ?? 8 * 60 * 60 * 1000

  function discard(token: string, session: Session) {
    session.backend.logout(session.id)
    sessions.delete(token)
  }
  const sweep = setInterval(() => {
    for (const [token, session] of sessions) if (session.expiresAt <= Date.now()) discard(token, session)
  }, 60_000)
  sweep.unref()

  function json(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(value))
  }

  async function body(request: IncomingMessage): Promise<{ input?: unknown }> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 128 * 1024) throw new Error('Request too large.')
      chunks.push(Buffer.from(chunk))
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request.')
    return parsed
  }

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'same-origin')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    const address = server.address()
    const origin = options.origin ?? `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const expected = new URL(origin)
    if (request.headers.host !== expected.host) {
      json(response, 403, { error: 'Unrecognized server address.' })
      return
    }
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/api/branches' && request.method === 'GET') {
      json(response, 200, { branches: branches.map(({ id, name }) => ({ id, name })) })
      return
    }
    if (path.startsWith('/api/')) {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST')
        json(response, 405, { error: 'Use POST for restaurant operations.' })
        return
      }
      if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
        json(response, 403, { error: 'Requests must originate from this restaurant application.' })
        return
      }
      if (!request.headers['content-type']?.startsWith('application/json')) {
        json(response, 415, { error: 'JSON is required.' })
        return
      }
      const method = path.slice('/api/pos/'.length)
      if (!path.startsWith('/api/pos/') || !Object.hasOwn(posChannels, method)) {
        json(response, 404, { error: 'Unknown operation.' })
        return
      }
      let input: unknown
      try {
        input = (await body(request)).input
      } catch (error) {
        json(response, error instanceof Error && error.message === 'Request too large.' ? 413 : 400,
          { error: 'Invalid or oversized JSON request.' })
        return
      }
      const branchId = request.headers['x-billmitra-branch'] ?? branches[0].id
      const branch = branches.find(item => item.id === branchId)
      if (!branch) { json(response, 403, { error: 'Select a configured restaurant branch.' }); return }
      if (method === 'setupOwner' && options.setupToken) {
        const provided = typeof input === 'object' && input !== null && 'setupToken' in input && typeof input.setupToken === 'string' ? input.setupToken : ''
        const digest = (value: string) => createHash('sha256').update(value).digest()
        if (!timingSafeEqual(digest(provided), digest(options.setupToken))) { json(response, 403, { error: 'A valid server setup token is required to create a branch owner.' }); return }
      }
      const cookieName = `billmitra_session_${branch.id}=`
      let token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName))?.slice(cookieName.length) ?? ''
      let session = sessions.get(token)
      if (session && session.branchId !== branch.id) { json(response, 403, { error: 'This session belongs to a different branch.' }); return }
      if (session && session.expiresAt <= Date.now()) {
        discard(token, session)
        session = undefined
      }
      if (!session) {
        if (sessions.size >= 1000) {
          json(response, 503, { error: 'Too many active sessions. Try again later.' })
          return
        }
        session = { id: ++nextId, expiresAt: Date.now() + lifetime, branchId: branch.id, backend: branch.backend }
        token = randomBytes(32).toString('hex')
        sessions.set(token, session)
      }
      const cookie = (value: string, maxAge: number) => `${cookieName}${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${expected.protocol === 'https:' ? '; Secure' : ''}`
      session.expiresAt = Date.now() + lifetime
      response.setHeader('Set-Cookie', cookie(token, Math.floor(lifetime / 1000)))
      try {
        const result = branch.backend.invoke(posChannels[method as keyof typeof posChannels], session.id, input)
        if (method === 'loginStaff' || method === 'setupOwner') {
          sessions.delete(token)
          token = randomBytes(32).toString('hex')
          sessions.set(token, session)
          response.setHeader('Set-Cookie', cookie(token, Math.floor(lifetime / 1000)))
        } else if (method === 'logoutStaff') {
          discard(token, session)
          response.setHeader('Set-Cookie', cookie('', 0))
        }
        json(response, 200, { result: result ?? null })
      } catch (error) {
        if (error instanceof ZodError) {
          json(response, 400, { error: error.issues.map(issue => issue.message).join(' ') })
        } else {
          const message = error instanceof Error ? error.message : ''
          // Internal SQLite errors should never expose schema details to a browser.
          const internal = /SQLITE|no such (table|column)|constraint failed|syntax error/i.test(message)
          json(response, internal ? 500 : 400, { error: internal ? 'The operation could not be saved.' : message || 'The operation failed.' })
        }
      }
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    try {
      const root = await realpath(options.assetsDirectory)
      const filename = await realpath(join(root, decodeURIComponent(path === '/' ? '/index.html' : path)))
      const rel = relative(root, filename)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid asset path.')
      const contents = await readFile(filename)
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(filename)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
      response.end(request.method === 'HEAD' ? undefined : contents)
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Page not found.')
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.on('close', () => {
    clearInterval(sweep)
    for (const [token, session] of sessions) discard(token, session)
  })
  return server
}
