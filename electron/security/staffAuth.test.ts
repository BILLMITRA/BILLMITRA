import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { staffSchemaMigration } from '../database/staffSchema.cjs'
import { StaffAuthService } from './staffAuth.cjs'

let database: DatabaseSync
let auth: StaffAuthService

function withTransaction<T>(action: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

beforeEach(() => {
  database = new DatabaseSync(':memory:')
  database.exec(staffSchemaMigration)
  database.exec(`
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      details_json TEXT NOT NULL
    )
  `)
  auth = new StaffAuthService(database, withTransaction)
})

afterEach(() => {
  database.close()
})

describe('local staff authentication service', () => {
  it('creates the first owner, persists a hashed credential, and allows owner-managed accounts', () => {
    expect(auth.getAccessState(1)).toEqual({ needsOwnerSetup: true, staff: null })
    const owner = auth.setupOwner(1, {
      username: 'owner',
      displayName: 'Restaurant Owner',
      password: 'secure-owner-password',
    })

    expect(auth.getAccessState(1).staff).toEqual(owner)
    const storedCredential = database.prepare('SELECT password_hash FROM staff_users WHERE id = ?').get(owner.id) as {
      password_hash: string
    }
    expect(storedCredential.password_hash).not.toBe('secure-owner-password')
    expect(auth.listStaff(1)).toEqual([owner])

    const cashier = auth.createStaff(1, {
      username: 'cashier1',
      displayName: 'Front Cashier',
      role: 'cashier',
      password: 'secure-cashier-password',
    })
    expect(auth.listStaff(1)).toContainEqual(cashier)
  })

  it('verifies passwords, normalizes usernames, and rejects unauthorized permissions', () => {
    auth.setupOwner(1, {
      username: 'owner',
      displayName: 'Restaurant Owner',
      password: 'secure-owner-password',
    })
    auth.createStaff(1, {
      username: 'cashier1',
      displayName: 'Front Cashier',
      role: 'cashier',
      password: 'secure-cashier-password',
    })

    auth.logout(1)
    const cashier = auth.login(2, { username: 'CASHIER1', password: 'secure-cashier-password' })
    expect(cashier.role).toBe('cashier')
    expect(() => auth.requirePermission(2, 'discount:apply'))
      .toThrow('Your cashier role does not have permission for this action.')
    expect(auth.requirePermission(2, 'payments:record')).toEqual(cashier)
  })

  it('locks the account after five failed password attempts', () => {
    auth.setupOwner(1, {
      username: 'owner',
      displayName: 'Restaurant Owner',
      password: 'secure-owner-password',
    })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => auth.login(2, { username: 'owner', password: 'incorrect-password' }))
        .toThrow('Invalid username or password.')
    }
    expect(() => auth.login(2, { username: 'owner', password: 'incorrect-password' }))
      .toThrow('This account is temporarily locked. Try again in five minutes.')
    expect(() => auth.login(2, { username: 'owner', password: 'secure-owner-password' }))
      .toThrow('This account is temporarily locked. Try again in five minutes.')
  })

  it('does not permit owner setup after an account already exists and clears sessions on logout', () => {
    auth.setupOwner(1, {
      username: 'owner',
      displayName: 'Restaurant Owner',
      password: 'secure-owner-password',
    })
    expect(() => auth.setupOwner(2, {
      username: 'another-owner',
      displayName: 'Another Owner',
      password: 'secure-other-password',
    })).toThrow('Owner setup is already complete.')

    auth.logout(1)
    expect(auth.getAccessState(1)).toEqual({ needsOwnerSetup: false, staff: null })
    expect(() => auth.requirePermission(1, 'pos:access')).toThrow('Sign in with a staff account to continue.')
  })
})
