import { describe, expect, it } from 'vitest'
import { createManagerPinHash, managerPinPattern, verifyManagerPin } from './managerSecurity'

describe('manager PIN security', () => {
  it('hashes and verifies a PIN without storing its plaintext', () => {
    const { salt, hash } = createManagerPinHash('482916')
    expect(hash).not.toBe('482916')
    expect(verifyManagerPin('482916', salt, hash)).toBe(true)
    expect(verifyManagerPin('482917', salt, hash)).toBe(false)
  })

  it('accepts only 4 to 12 decimal digits', () => {
    expect(managerPinPattern.test('1234')).toBe(true)
    expect(managerPinPattern.test('123456789012')).toBe(true)
    expect(managerPinPattern.test('123')).toBe(false)
    expect(managerPinPattern.test('12a4')).toBe(false)
    expect(() => createManagerPinHash('12a4')).toThrow('Manager PIN must be 4 to 12 digits.')
  })
})
