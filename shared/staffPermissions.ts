import type { StaffPermission, StaffRole } from './domain.js'

const permissions: Record<StaffRole, readonly StaffPermission[]> = {
  owner: [
    'pos:access', 'orders:write', 'discount:apply', 'payments:record', 'bill:void',
    'bill:reprint', 'staff:manage', 'settings:manage', 'reports:view',
    'waiter:operate', 'payments:refund', 'cash:close', 'menu:manage', 'inventory:manage', 'kitchen:operate', 'delivery:view', 'delivery:assign',
    'delivery:reassign', 'delivery:operate', 'delivery:cancel', 'delivery:riders',
  ],
  manager: [
    'pos:access', 'orders:write', 'discount:apply', 'payments:record', 'bill:void',
    'waiter:operate', 'bill:reprint', 'reports:view', 'payments:refund', 'cash:close', 'menu:manage', 'inventory:manage', 'kitchen:operate',
    'delivery:view', 'delivery:assign', 'delivery:reassign', 'delivery:operate',
    'delivery:cancel', 'delivery:riders',
  ],
  cashier: [
    'pos:access', 'orders:write', 'payments:record', 'bill:reprint',
    'delivery:view', 'delivery:assign', 'delivery:operate',
  ],
  kitchen: ['kitchen:operate'],
  waiter: ['waiter:operate', 'orders:write'],
  inventory: ['inventory:manage'],
  accountant: ['reports:view', 'bill:reprint'],
}

export const STAFF_PASSWORD_MIN_LENGTH = 12
export const STAFF_PASSWORD_MAX_LENGTH = 128

export function staffPermissionsForRole(role: StaffRole): readonly StaffPermission[] {
  return permissions[role]
}

export function staffHasPermission(role: StaffRole, permission: StaffPermission): boolean {
  return permissions[role].includes(permission)
}
