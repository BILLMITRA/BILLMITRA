import { describe, expect, it } from 'vitest'
import { createPasswordHash, verifyPasswordHash } from './staffSecurity'
import { staffHasPermission, staffPermissionsForRole } from './staffPermissions'

describe('staff authentication security', () => {
  it('hashes passwords and verifies them without storing plaintext', () => {
    const { salt, hash } = createPasswordHash('correct horse battery staple')
    expect(hash).not.toBe('correct horse battery staple')
    expect(verifyPasswordHash('correct horse battery staple', salt, hash)).toBe(true)
    expect(verifyPasswordHash('incorrect password', salt, hash)).toBe(false)
  })

  it('rejects passwords outside the accepted length', () => {
    expect(() => createPasswordHash('short')).toThrow(/12 to 128 characters/)
    expect(() => createPasswordHash('x'.repeat(129))).toThrow(/12 to 128 characters/)
  })

  it('applies explicit role permissions without granting POS access to operational roles', () => {
    expect(staffHasPermission('owner', 'staff:manage')).toBe(true)
    expect(staffHasPermission('cashier', 'payments:record')).toBe(true)
    expect(staffHasPermission('cashier', 'discount:apply')).toBe(false)
    expect(staffHasPermission('kitchen', 'pos:access')).toBe(false)
    expect(staffPermissionsForRole('accountant')).toContain('reports:view')
  })
})
