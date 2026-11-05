import { useEffect, useState, type FormEvent } from 'react'
import { ShieldCheck, UserPlus, X } from 'lucide-react'
import { STAFF_ROLES, type CreateStaffInput, type StaffIdentity, type StaffRole } from '../../../shared/domain'
import { STAFF_PASSWORD_MIN_LENGTH } from '../../../shared/staffPermissions'
import { createStaff, getStaffAccessState, listStaff, resetManagerPassword } from '../../services/pos'
import './staff.css'

type StaffManagementDialogProps = {
  onClose: () => void
}

const availableRoles = STAFF_ROLES.filter((role): role is Exclude<StaffRole, 'owner'> => role !== 'owner')
const roleDescriptions: Record<Exclude<StaffRole, 'owner'>, string> = {
  manager: 'POS, discounts, payments, bill voids, reports, inventory and kitchen access',
  cashier: 'POS orders, payments and bill reprints; no discounts or void approvals',
  waiter: 'Dedicated table ordering; no payments, discounts, refunds or voids',
  kitchen: 'Kitchen preparation queue and order status updates',
  inventory: 'Inventory items, stock adjustments and movement history',
  accountant: 'Sales reports and CSV export',
}

export function StaffManagementDialog({ onClose }: StaffManagementDialogProps) {
  const [staffList, setStaffList] = useState<StaffIdentity[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<Exclude<StaffRole, 'owner'>>('cashier')
  const [password, setPassword] = useState('')
  const [isOwner, setIsOwner] = useState(false)
  const [resetId, setResetId] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [notice, setNotice] = useState('')

  async function refreshStaff(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      setStaffList(await listStaff())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Staff accounts could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let mounted = true
    void getStaffAccessState().then((access) => { if (mounted) setIsOwner(access.staff?.role === 'owner') })
    listStaff()
      .then((accounts) => { if (mounted) setStaffList(accounts) })
      .catch((cause: unknown) => {
        if (mounted) setError(cause instanceof Error ? cause.message : 'Staff accounts could not be loaded.')
      })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [])

  async function submitReset(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (newPassword !== confirmPassword) { setError('The new passwords do not match.'); return }
    setSaving(true); setError(''); setNotice('')
    try {
      await resetManagerPassword({ staffId: resetId, password: newPassword })
      setResetId(''); setNewPassword(''); setConfirmPassword('')
      setNotice('Manager password reset. Ask the manager to sign in with the new password.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Manager password could not be reset.') }
    finally { setSaving(false) }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
      setError('Username must be 3 to 40 characters with no spaces. Try 2ndscreen.'); return
    }
    setSaving(true)
    setError('')
    try {
      const input: CreateStaffInput = { username, displayName, password, role }
      await createStaff(input)
      setUsername('')
      setDisplayName('')
      setPassword('')
      await refreshStaff()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Staff account could not be created.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="staff-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose()
    }}>
      <section className="staff-dialog" role="dialog" aria-modal="true" aria-labelledby="staff-dialog-title">
        <header className="staff-dialog-heading">
          <span className="staff-access-icon"><ShieldCheck size={20} /></span>
          <div><h2 id="staff-dialog-title">Staff and permissions</h2><p>Local accounts and fixed role permission sets</p></div>
          <button type="button" className="staff-dialog-close" aria-label="Close staff management" onClick={onClose} disabled={saving}><X size={17} /></button>
        </header>
        <div className="staff-dialog-content">
          <section className="staff-list" aria-label="Staff accounts">
            <h3>Accounts</h3>
            {loading ? <p className="staff-empty">Loading staff…</p> : staffList.length === 0 ? <p className="staff-empty">No staff accounts found.</p> : (
              <ul>
                {staffList.map((staff) => (
                  <li key={staff.id}>
                    <span className="staff-list-avatar">{staff.displayName.slice(0, 1).toUpperCase()}</span>
                    <span className="staff-list-copy"><b>{staff.displayName}</b><small>@{staff.username}</small></span>
                    <span className={`staff-role-badge ${staff.role}`}>{staff.role}</span>
                    {isOwner && staff.role === 'manager' && <button type="button" className="staff-reset-button" onClick={() => { setResetId(staff.id); setError(''); setNotice('') }}>Reset password</button>}
                  </li>
                ))}
              </ul>
            )}
            {resetId && <form className="staff-reset-form" onSubmit={(event) => void submitReset(event)}>
              <h3>Reset {staffList.find(staff => staff.id === resetId)?.displayName}'s password</h3>
              <label><span>New password</span><input type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} minLength={STAFF_PASSWORD_MIN_LENGTH} maxLength={128} autoComplete="new-password" required /></label>
              <label><span>Confirm new password</span><input type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} minLength={STAFF_PASSWORD_MIN_LENGTH} maxLength={128} autoComplete="new-password" required /></label>
              <div><button type="submit" disabled={saving}>Save new password</button><button type="button" onClick={() => { setResetId(''); setNewPassword(''); setConfirmPassword('') }} disabled={saving}>Cancel</button></div>
            </form>}
            {notice && <p role="status" className="staff-access-hint">{notice}</p>}
          </section>
          <form className="staff-create-form" onSubmit={(event) => void submit(event)}>
            <h3><UserPlus size={16} /> Add staff account</h3>
            <label><span>Display name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} autoComplete="name" required /></label>
            <label><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} minLength={3} maxLength={40} pattern="[a-zA-Z0-9._-]{3,40}" title="Use letters, numbers, dots, underscores or hyphens, with no spaces" autoCapitalize="none" autoComplete="off" required /></label>
            <label><span>Role</span>
              <select value={role} onChange={(event) => setRole(event.target.value as Exclude<StaffRole, 'owner'>)}>
                {availableRoles.map((availableRole) => <option value={availableRole} key={availableRole}>{availableRole}</option>)}
              </select>
            </label>
            <small className="staff-role-description">{roleDescriptions[role]}</small>
            <label><span>Temporary password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={STAFF_PASSWORD_MIN_LENGTH} maxLength={128} placeholder="4 or more letters or digits" autoComplete="new-password" required /></label>
            {error && <div className="staff-access-error" role="alert">{error}</div>}
            <button type="submit" disabled={saving || loading}>{saving ? 'Creating…' : 'Create staff account'}</button>
          </form>
        </div>
        <footer className="staff-dialog-footer">Role permissions are enforced in the Electron main process. Staff login is local to this Windows account.</footer>
      </section>
    </div>
  )
}
