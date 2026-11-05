import { useState, type FormEvent } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import './security.css'

type Props = {
  onClose: () => void
  onAuthorize: (pin: string) => Promise<void>
  canReset: boolean
  onReset: (input: { ownerPassword: string; pin: string }) => Promise<void>
}

export function ManagementPinDialog({ onClose, onAuthorize, canReset, onReset }: Props) {
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [resetMode, setResetMode] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!/^\d{4,12}$/.test(pin)) {
      setError('Enter a PIN with 4 to 12 digits.')
      return
    }
    if (resetMode && pin !== confirmPin) {
      setError('The new PIN entries do not match.')
      return
    }
    if (resetMode && !ownerPassword) {
      setError('Enter your owner account password.')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (resetMode) await onReset({ ownerPassword, pin })
      else await onAuthorize(pin)
    } catch (cause) {
      setPin('')
      setConfirmPin('')
      setOwnerPassword('')
      setError(cause instanceof Error ? cause.message : 'Could not verify the manager PIN.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="manager-action-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !busy) onClose()
  }}>
    <section className="manager-action-dialog" role="dialog" aria-modal="true" aria-labelledby="management-pin-title">
      <header><span className="manager-action-icon"><ShieldCheck size={20} /></span>
        <button type="button" className="manager-action-close" aria-label="Close" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <h2 id="management-pin-title">{resetMode ? 'Set new manager PIN' : 'Open Management'}</h2>
      <p>{resetMode ? 'Confirm your owner account password, then choose a new numeric PIN.' : 'Enter the manager PIN to continue.'}</p>
      <form onSubmit={event => void submit(event)}>
        {resetMode && <label className="manager-action-field"><span>Owner account password</span>
          <input autoFocus type="password" autoComplete="current-password" value={ownerPassword}
            onChange={event => setOwnerPassword(event.target.value)} maxLength={128} disabled={busy} /></label>}
        <label className="manager-action-field"><span>{resetMode ? 'New manager PIN' : 'Manager PIN'}</span>
          <input autoFocus={!resetMode} type="password" inputMode="numeric" autoComplete="off" maxLength={12} value={pin}
            onChange={event => setPin(event.target.value.replace(/\D/g, ''))} placeholder="4 to 12 digits" disabled={busy} /></label>
        {resetMode && <label className="manager-action-field"><span>Confirm new PIN</span>
          <input type="password" inputMode="numeric" autoComplete="off" maxLength={12} value={confirmPin}
            onChange={event => setConfirmPin(event.target.value.replace(/\D/g, ''))} disabled={busy} /></label>}
        {error && <div className="manager-action-error" role="alert">{error}</div>}
        <footer><button type="button" className="manager-action-cancel" onClick={resetMode ? () => { setResetMode(false); setError(''); setPin(''); setConfirmPin(''); setOwnerPassword('') } : onClose} disabled={busy}>{resetMode ? 'Back' : 'Cancel'}</button>
          <button type="submit" className="manager-action-submit" disabled={busy || !pin}>{busy ? 'Checking…' : resetMode ? 'Save new PIN' : 'Open Management'}</button></footer>
      </form>
      {!resetMode && canReset && <button type="button" className="manager-action-reset" onClick={() => { setResetMode(true); setPin(''); setError('') }}>Forgot PIN? Set a new one</button>}
      <small className="manager-action-security-note">{resetMode ? 'Only the owner can replace the PIN. The old PIN will stop working.' : 'Five incorrect attempts lock the PIN for five minutes.'}</small>
    </section>
  </div>
}
