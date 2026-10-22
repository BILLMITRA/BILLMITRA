import { useState, type FormEvent } from 'react'
import { LockKeyhole, UtensilsCrossed, UserRound } from 'lucide-react'
import type { StaffIdentity } from '../../../shared/domain'
import { loginStaff, setupOwner } from '../../services/pos'
import './staff.css'

type StaffAccessScreenProps = {
  needsOwnerSetup: boolean
  onAuthenticated: (staff: StaffIdentity) => void
}

export function StaffAccessScreen({ needsOwnerSetup, onAuthenticated }: StaffAccessScreenProps) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [setupToken, setSetupToken] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError('')
    if (needsOwnerSetup && password !== confirmPassword) {
      setError('The passwords do not match.')
      return
    }
    setSubmitting(true)
    try {
      const staff = needsOwnerSetup
        ? await setupOwner({ username, displayName, password, ...(setupToken ? { setupToken } : {}) })
        : await loginStaff({ username, password })
      onAuthenticated(staff)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Staff access could not be verified.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="staff-access-shell">
      <section className="staff-access-card" aria-labelledby="staff-access-title">
        <div className="staff-access-brand">
          <span className="staff-access-mark"><UtensilsCrossed size={20} /></span>
          <span><b>BillMitra</b><small>RESTAURANT POS</small></span>
        </div>
        <span className="staff-access-icon">{needsOwnerSetup ? <LockKeyhole size={20} /> : <UserRound size={20} />}</span>
        <h1 id="staff-access-title">{needsOwnerSetup ? 'Set up your owner account' : 'Staff sign in'}</h1>
        <p>{needsOwnerSetup
          ? 'Create the first local owner account. Use it to add staff and manage access on this device.'
          : 'Sign in with your restaurant account to continue to the cashier.'}</p>
        <form onSubmit={(event) => void submit(event)}>
          {needsOwnerSetup && !window.pos && <label><span>Server setup token (if configured)</span><input type="password" value={setupToken} onChange={event => setSetupToken(event.target.value)} autoComplete="off" /></label>}
          {needsOwnerSetup && (
            <label>
              <span>Owner display name</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} autoComplete="name" required />
            </label>
          )}
          <label>
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
              minLength={3}
              maxLength={40}
              pattern="[a-zA-Z0-9._-]{3,40}"
              autoCapitalize="none"
              autoComplete="username"
              required
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={needsOwnerSetup ? 12 : 1}
              maxLength={128}
              autoComplete={needsOwnerSetup ? 'new-password' : 'current-password'}
              required
            />
          </label>
          {needsOwnerSetup && (
            <label>
              <span>Confirm password</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                required
              />
            </label>
          )}
          {needsOwnerSetup && <small className="staff-access-hint">Use at least 12 characters. Passwords are hashed locally and cannot be retrieved.</small>}
          {error && <div className="staff-access-error" role="alert">{error}</div>}
          <button type="submit" disabled={submitting}>
            {submitting ? 'Please wait…' : needsOwnerSetup ? 'Create owner account' : 'Sign in'}
          </button>
        </form>
        <footer>Local staff access · This device only</footer>
      </section>
    </main>
  )
}
