import { afterEach, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, getMenu, login, requestPrint, serverUrl } from '../src/api.ts'

const server = 'https://restaurant.example'
const session = { token: 'f'.repeat(64), staff: { id: 'staff-test', displayName: 'Test', username: 'waiter', role: 'waiter' }, branch: { id: 'main', name: 'Test branch' }, server }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
const signIn = () => login(server, 'main', 'waiter', 'synthetic-test-password')
afterEach(() => { mock.restoreAll(); mock.timers.reset() })

test('login posts to the restaurant endpoint and validates its successful session', async () => {
  mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `${server}/api/mobile/login`)
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Accept, 'application/json')
    assert.equal(JSON.parse(options.body).input.branchId, 'main')
    assert.equal(options.headers.Authorization, undefined)
    return json({ ok: true, result: session, error: null })
  })
  assert.deepEqual(await signIn(), session)
})
test('existing servers with the result envelope remain compatible', async () => {
  mock.method(globalThis, 'fetch', async () => json({ result: session }))
  assert.deepEqual(await signIn(), session)
})
test('invalid credentials and account throttling preserve meaningful HTTP errors', async () => {
  for (const [status, message] of [[401, 'Invalid username or password.'], [429, 'This account is temporarily locked. Try again in five minutes.']]) {
    mock.method(globalThis, 'fetch', async () => json({ ok: false, result: null, error: message }, status))
    await assert.rejects(signIn, error => error instanceof ApiError && error.status === status && error.kind === 'http' && error.message === message)
    mock.restoreAll()
  }
})
test('plain text gateway responses beginning with e reproduce and fix the reported parse failure', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('error code: 1033', { status: 530, headers: { 'Content-Type': 'text/plain' } }))
  await assert.rejects(signIn, error => error instanceof ApiError && error.kind === 'protocol' && error.status === 530 && error.message.includes('Gateway code 1033') && !error.message.includes('JSON Parse'))
})
test('HTML, missing JSON content type, malformed JSON, empty and invalid envelopes are rejected safely', async () => {
  for (const response of [
    new Response('<html>proxy or wrong site</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
    new Response('unexpected text', { status: 200 }),
    new Response('error code: 1033', { headers: { 'Content-Type': 'application/json' } }),
    new Response('', { headers: { 'Content-Type': 'application/json' } }),
    json(null), json([]), json({}), json({ result: null }), json({ result: { ...session, branch: { id: 'other', name: 'Wrong branch' } } }),
  ]) {
    mock.method(globalThis, 'fetch', async () => response)
    await assert.rejects(signIn, error => error instanceof ApiError && error.kind === 'protocol' && !error.message.includes('<html>') && !error.message.includes('unexpected text'))
    mock.restoreAll()
  }
})
test('server errors and response-stream failures do not leak raw body or transport error details', async () => {
  mock.method(globalThis, 'fetch', async () => json({ error: 'synthetic-private-database-details' }, 500))
  await assert.rejects(signIn, error => error.status === 500 && !error.message.includes('synthetic-private'))
  mock.restoreAll()
  mock.method(globalThis, 'fetch', async () => ({ text: async () => { throw new Error('synthetic-private-stream-details') } }))
  await assert.rejects(signIn, error => error.kind === 'network' && !error.message.includes('synthetic-private'))
})
test('network failures and timeouts are distinct and keep the saved-request retry path', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('synthetic-private-transport-details') })
  await assert.rejects(signIn, error => error.kind === 'network' && error.status === 0 && !error.message.includes('synthetic-private'))
  mock.restoreAll()
  mock.timers.enable({ apis: ['setTimeout'] })
  mock.method(globalThis, 'fetch', (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))))
  const pending = signIn()
  mock.timers.tick(20000)
  await assert.rejects(pending, error => error.kind === 'timeout')
})
test('menu and print requests receive the same safe parser and bearer authentication', async () => {
  mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${session.token}`)
    return new Response('error code: 1033', { status: 403 })
  })
  await assert.rejects(() => getMenu(session), error => error.kind === 'protocol')
  await assert.rejects(() => requestPrint(session, { requestId: 'test', orderId: 'test', kind: 'bill' }), error => error.kind === 'protocol')
})
test('a valid JSON envelope with invalid menu data cannot become a successful connected screen', async () => {
  mock.method(globalThis, 'fetch', async () => json({ result: null }))
  await assert.rejects(() => getMenu(session), error => error.kind === 'protocol')
})
test('restaurant URL validation rejects paths, credentials, HTTP and malformed addresses before sending', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => { throw Error('must not send') })
  for (const address of ['not a URL', 'http://restaurant.example', `${server}/api/mobile/login`, 'https://user:pass@restaurant.example', `${server}/?token=test`]) {
    assert.throws(() => serverUrl(address), /HTTPS address only/)
    await assert.rejects(() => login(address, 'main', 'waiter', 'synthetic-test-password'), /HTTPS address only/)
  }
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(serverUrl(` ${server}/ `), server)
})
