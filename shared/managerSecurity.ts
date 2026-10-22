import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export const managerPinPattern = /^\d{4,12}$/

export function createManagerPinHash(pin: string, salt = randomBytes(16).toString('hex')): { salt: string; hash: string } {
  if (!managerPinPattern.test(pin)) throw new Error('Manager PIN must be 4 to 12 digits.')
  return { salt, hash: scryptSync(pin, Buffer.from(salt, 'hex'), 64).toString('hex') }
}

export function verifyManagerPin(pin: string, salt: string, expectedHash: string): boolean {
  if (!managerPinPattern.test(pin) || !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(expectedHash)) {
    return false
  }
  const actualHash = scryptSync(pin, Buffer.from(salt, 'hex'), 64)
  return timingSafeEqual(actualHash, Buffer.from(expectedHash, 'hex'))
}
