import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeServer } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('owner phone server address', () => {
  it('accepts private Wi-Fi HTTP only in Expo development', () => {
    vi.stubGlobal('__DEV__', true)
    expect(normalizeServer('http://192.168.220.3:3018')).toBe('http://192.168.220.3:3018')
    expect(() => normalizeServer('http://203.0.113.5:3018')).toThrow()
    vi.stubGlobal('__DEV__', false)
    expect(() => normalizeServer('http://192.168.220.3:3018')).toThrow()
    vi.stubEnv('EXPO_PUBLIC_LAN_PREVIEW', '1')
    expect(normalizeServer('http://192.168.220.3:3018')).toBe('http://192.168.220.3:3018')
    vi.unstubAllEnvs()
    expect(normalizeServer('https://owner.example.com')).toBe('https://owner.example.com')
  })
})
