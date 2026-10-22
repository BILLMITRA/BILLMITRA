import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { STAFF_PASSWORD_MAX_LENGTH, STAFF_PASSWORD_MIN_LENGTH } from './staffPermissions.js'

export function createPasswordHash(password: string, salt = randomBytes(16).toString('hex')): { salt: string; hash: string } {
  if (password.length < STAFF_PASSWORD_MIN_LENGTH || password.length > STAFF_PASSWORD_MAX_LENGTH) {
    throw new Error(`Password must be ${STAFF_PASSWORD_MIN_LENGTH} to ${STAFF_PASSWORD_MAX_LENGTH} characters.`)
  }
  return { salt, hash: scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex') }
}

export function verifyPasswordHash(password: string, salt: string, expectedHash: string): boolean {
  if (!/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(expectedHash)) return false
  const actualHash = scryptSync(password, Buffer.from(salt, 'hex'), 64)
  return timingSafeEqual(actualHash, Buffer.from(expectedHash, 'hex'))
}
