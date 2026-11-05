// Restrict the public owner tunnel to the owner API and health check.
const http = require('node:http')

const port = Number(process.env.BILLMITRA_OWNER_PROXY_PORT || 3020)
const upstream = 'http://127.0.0.1:3017'

http.createServer((request, response) => {
  const path = new URL(request.url || '/', 'http://localhost').pathname
  if (path !== '/api/health' && !/^\/api\/owner\/[a-z-]+$/.test(path)) {
    response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    response.end('Not found')
    return
  }
  const headers = { ...request.headers, host: '127.0.0.1:3017' }
  delete headers['cf-connecting-ip']
  delete headers['x-forwarded-for']
  const upstreamRequest = http.request(new URL(request.url, upstream), { method: request.method, headers, timeout: 25000 }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode || 502, { ...upstreamResponse.headers, 'Cache-Control': 'no-store' })
    upstreamResponse.pipe(response)
  })
  upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('Upstream timeout')))
  upstreamRequest.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    response.end('Restaurant server unavailable')
  })
  request.pipe(upstreamRequest)
}).listen(port, '127.0.0.1', () => console.log(`Owner API proxy listening on 127.0.0.1:${port}`))
