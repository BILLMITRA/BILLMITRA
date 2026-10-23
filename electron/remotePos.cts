import { posChannels } from '../shared/posChannels.js'

type Channel = typeof posChannels[keyof typeof posChannels]
const methods = new Map<string, string>(Object.entries(posChannels).map(([method, channel]) => [channel, method]))

export function createRemotePos(rawOrigin: string, branchId: string) {
  const origin = new URL(rawOrigin)
  if (origin.origin !== rawOrigin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1')))
    throw new Error('Desktop server must be an HTTPS origin, or local 127.0.0.1 for development.')
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(branchId)) throw new Error('Invalid connected branch ID.')
  const cookies = new Map<number, string>()
  async function invoke(channel: Channel, senderId: number, input?: unknown): Promise<unknown> {
    const method = methods.get(channel)
    if (!method) throw new Error('Unknown restaurant operation.')
    let response: Response
    try {
      response = await fetch(`${origin.origin}/api/pos/${method}`, {
        method: 'POST', headers: { Origin: origin.origin, 'Content-Type': 'application/json', 'X-Billmitra-Branch': branchId,
          ...(cookies.has(senderId) ? { Cookie: cookies.get(senderId)! } : {}) },
        body: JSON.stringify({ input }),
      })
    } catch { throw new Error('Cannot reach the connected restaurant server. Check the connection and retry.') }
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    if (cookie) cookies.set(senderId, cookie)
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The restaurant server returned an unexpected response.')
    const payload = await response.json() as { result?: unknown; error?: string }
    if (!response.ok) throw new Error(payload.error ?? 'The restaurant request failed.')
    if (method === 'logoutStaff') cookies.delete(senderId)
    return payload.result
  }
  function logout(senderId: number) { cookies.delete(senderId) }
  return { invoke, logout, close: () => cookies.clear() }
}
