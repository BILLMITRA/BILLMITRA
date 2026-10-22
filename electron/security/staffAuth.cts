import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DatabaseSync } from 'node:sqlite'
import type {
  CreateStaffInput,
  OwnerSetupInput,
  StaffAccessState,
  StaffIdentity,
  StaffLoginInput,
  StaffPermission,
  StaffRole,
} from '../../shared/domain.js'
import { STAFF_ROLES } from '../../shared/domain.js'
import { createPasswordHash, verifyPasswordHash } from '../../shared/staffSecurity.js'
import { staffHasPermission } from '../../shared/staffPermissions.js'

type TransactionRunner = <T>(action: () => T) => T

const usernameSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9._-]{3,40}$/, 'Username must be 3 to 40 letters, digits, dots, underscores, or hyphens.')
const passwordSchema = z.string().min(12).max(128)
const staffLoginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
})
const ownerSetupSchema = staffLoginSchema.extend({
  displayName: z.string().trim().min(1).max(120),
  password: passwordSchema,
})
const createStaffSchema = staffLoginSchema.extend({
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(['manager', 'cashier', 'waiter', 'kitchen', 'inventory', 'accountant']),
  password: passwordSchema,
})
const dummyPasswordCredential = createPasswordHash('BillMitraInvalidLoginDummyPassword')

function isStaffRole(value: string): value is StaffRole {
  return STAFF_ROLES.some((role) => role === value)
}

export class StaffAuthService {
  private readonly sessions = new Map<number, StaffIdentity>()

  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: TransactionRunner,
  ) {}

  getAccessState(senderId: number): StaffAccessState {
    const session = this.sessions.get(senderId)
    if (session) {
      const row = this.database.prepare(`
        SELECT id, username, display_name AS displayName, role
        FROM staff_users WHERE id = ? AND active = 1
      `).get(session.id) as { id: string; username: string; displayName: string; role: string } | undefined
      if (row) {
        const staff = this.identityFromRow(row)
        this.sessions.set(senderId, staff)
        return { needsOwnerSetup: false, staff }
      }
      this.sessions.delete(senderId)
    }
    const count = (this.database.prepare('SELECT COUNT(*) AS count FROM staff_users').get() as { count: number }).count
    return { needsOwnerSetup: count === 0, staff: null }
  }

  setupOwner(senderId: number, rawInput: unknown): StaffIdentity {
    const input: OwnerSetupInput = ownerSetupSchema.parse(rawInput)
    const credential = createPasswordHash(input.password)
    const staff = this.transaction(() => {
      const count = (this.database.prepare('SELECT COUNT(*) AS count FROM staff_users').get() as { count: number }).count
      if (count !== 0) throw new Error('Owner setup is already complete. Sign in with an existing staff account.')
      const identity: StaffIdentity = {
        id: randomUUID(),
        username: input.username,
        displayName: input.displayName,
        role: 'owner',
      }
      this.database.prepare(`
        INSERT INTO staff_users (id, username, display_name, role, password_salt, password_hash)
        VALUES (?, ?, ?, 'owner', ?, ?)
      `).run(identity.id, identity.username, identity.displayName, credential.salt, credential.hash)
      this.audit('staff.owner_setup', identity.id, identity.username, 'first_run_setup', { role: identity.role })
      return identity
    })
    this.sessions.set(senderId, staff)
    return staff
  }

  login(senderId: number, rawInput: unknown): StaffIdentity {
    const input: StaffLoginInput = staffLoginSchema.parse(rawInput)
    const outcome = this.transaction(() => {
      const row = this.database.prepare(`
        SELECT id, username, display_name AS displayName, role, password_salt AS salt,
          password_hash AS hash, failed_login_attempts AS failedAttempts, locked_until AS lockedUntil
        FROM staff_users WHERE username = ? COLLATE NOCASE AND active = 1
      `).get(input.username) as {
        id: string; username: string; displayName: string; role: string; salt: string; hash: string
        failedAttempts: number; lockedUntil: string | null
      } | undefined
      const credential = row ?? dummyPasswordCredential
      const passwordMatches = verifyPasswordHash(input.password, credential.salt, credential.hash)
      const locked = Boolean(row?.lockedUntil
        && new Date(`${row.lockedUntil.replace(' ', 'T')}Z`).getTime() > Date.now())
      if (!row || locked || !passwordMatches) {
        if (row && !locked) {
          const attempts = row.failedAttempts + 1
          const lockedUntil = attempts >= 5
            ? new Date(Date.now() + 5 * 60_000).toISOString().replace('T', ' ').slice(0, 19)
            : null
          this.database.prepare(`
            UPDATE staff_users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?
          `).run(lockedUntil ? 0 : attempts, lockedUntil, row.id)
        }
        return { error: locked ? 'This account is temporarily locked. Try again in five minutes.' : 'Invalid username or password.' } as const
      }
      const staff = this.identityFromRow(row)
      this.database.prepare('UPDATE staff_users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(staff.id)
      this.audit('staff.login', staff.id, staff.username, 'password_login', { role: staff.role })
      return { staff } as const
    })
    if ('error' in outcome) throw new Error(outcome.error)
    this.sessions.set(senderId, outcome.staff)
    return outcome.staff
  }

  logout(senderId: number): void {
    this.sessions.delete(senderId)
  }

  requirePermission(senderId: number, permission: StaffPermission): StaffIdentity {
    const session = this.sessions.get(senderId)
    if (!session) throw new Error('Sign in with a staff account to continue.')
    const row = this.database.prepare(`
      SELECT id, username, display_name AS displayName, role
      FROM staff_users WHERE id = ? AND active = 1
    `).get(session.id) as { id: string; username: string; displayName: string; role: string } | undefined
    if (!row) {
      this.sessions.delete(senderId)
      throw new Error('This staff account is no longer active. Sign in again.')
    }
    const staff = this.identityFromRow(row)
    if (!staffHasPermission(staff.role, permission)) {
      throw new Error(`Your ${staff.role} role does not have permission for this action.`)
    }
    this.sessions.set(senderId, staff)
    return staff
  }

  listStaff(senderId: number): StaffIdentity[] {
    this.requirePermission(senderId, 'staff:manage')
    return (this.database.prepare(`
      SELECT id, username, display_name AS displayName, role
      FROM staff_users ORDER BY created_at, username
    `).all() as Array<{ id: string; username: string; displayName: string; role: string }>)
      .map((row) => this.identityFromRow(row))
  }

  createStaff(senderId: number, rawInput: unknown): StaffIdentity {
    const actor = this.requirePermission(senderId, 'staff:manage')
    const input: CreateStaffInput = createStaffSchema.parse(rawInput)
    const credential = createPasswordHash(input.password)
    const staff: StaffIdentity = {
      id: randomUUID(),
      username: input.username,
      displayName: input.displayName,
      role: input.role,
    }
    try {
      this.transaction(() => {
        this.database.prepare(`
          INSERT INTO staff_users (id, username, display_name, role, password_salt, password_hash)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(staff.id, staff.username, staff.displayName, staff.role, credential.salt, credential.hash)
        this.audit('staff.created', staff.id, actor.username, 'owner_created_account', {
          username: staff.username,
          role: staff.role,
        })
      })
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('staff_users.username')) {
        throw new Error('That username is already in use.')
      }
      throw cause
    }
    return staff
  }

  private identityFromRow(row: { id: string; username: string; displayName: string; role: string }): StaffIdentity {
    if (!isStaffRole(row.role)) {
      throw new Error('Staff account has an unsupported role.')
    }
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
    }
  }

  private audit(action: string, entityId: string, actor: string, reason: string, details: object): void {
    this.database.prepare(`
      INSERT INTO audit_log (id, action, entity_type, entity_id, actor, reason, details_json)
      VALUES (?, ?, 'staff_user', ?, ?, ?, ?)
    `).run(randomUUID(), action, entityId, actor, reason, JSON.stringify(details))
  }
}
