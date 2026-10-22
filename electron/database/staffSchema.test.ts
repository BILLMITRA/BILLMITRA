import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { staffSchemaMigration } from './staffSchema.cjs'

let database: DatabaseSync | null = null

afterEach(() => {
  database?.close()
  database = null
})

describe('staff schema migration', () => {
  it('creates unique local staff accounts with constrained roles', () => {
    database = new DatabaseSync(':memory:')
    database.exec(staffSchemaMigration)
    database.prepare(`
      INSERT INTO staff_users (id, username, display_name, role, password_salt, password_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('1', 'owner', 'Restaurant Owner', 'owner', 'a'.repeat(32), 'b'.repeat(128))
    expect(database.prepare('SELECT role FROM staff_users WHERE username = ?').get('OWNER')).toEqual({ role: 'owner' })
    expect(() => database!.prepare(`
      INSERT INTO staff_users (id, username, display_name, role, password_salt, password_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('2', 'OWNER', 'Duplicate', 'cashier', 'a'.repeat(32), 'b'.repeat(128))).toThrow()
    expect(() => database!.prepare(`
      INSERT INTO staff_users (id, username, display_name, role, password_salt, password_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('3', 'bad-role', 'Invalid', 'superuser', 'a'.repeat(32), 'b'.repeat(128))).toThrow()
  })
})
