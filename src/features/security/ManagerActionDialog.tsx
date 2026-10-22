import { useState } from 'react'
import { Ban, ShieldCheck, X } from 'lucide-react'
import './security.css'

type ManagerActionDialogProps = {
  mode: 'setup' | 'void'
  billNumber?: number
  onClose: () => void
  onSetPin: (pin: string) => Promise<void>
  onVoid: (pin: string, reason: string) => Promise<void>
}

export function ManagerActionDialog({ mode, billNumber, onClose, onSetPin, onVoid }: ManagerActionDialogProps) {
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const isSetup = mode === 'setup'

  async function submit(): Promise<void> {
    setError('')
    if (!/^\d{4,12}$/.test(pin)) {
      setError('Enter a manager PIN with 4 to 12 digits.')
      return
    }
    if (isSetup && pin !== confirmPin) {
      setError('The PIN entries do not match.')
      return
    }
    if (!isSetup && reason.trim().length < 3) {
      setError('Enter a reason for voiding this bill.')
      return
    }
    setSaving(true)
    try {
      if (isSetup) await onSetPin(pin)
      else await onVoid(pin, reason.trim())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The manager action could not be completed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="manager-action-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose()
    }}>
      <section className="manager-action-dialog" role="dialog" aria-modal="true" aria-labelledby="manager-action-title">
        <header>
          <span className={`manager-action-icon ${isSetup ? '' : 'void'}`}>{isSetup ? <ShieldCheck size={20} /> : <Ban size={20} />}</span>
          <button className="manager-action-close" aria-label="Close" onClick={onClose} disabled={saving}><X size={18} /></button>
        </header>
        <h2 id="manager-action-title">{isSetup ? 'Set manager PIN' : `Void bill #${billNumber}`}</h2>
        <p>{isSetup
          ? 'Create a device-only PIN. It is securely hashed and cannot be read back.'
          : 'Voiding releases the table and keeps the bill in history. Enter the manager PIN and record a reason.'}</p>
        <label className="manager-action-field">
          <span>{isSetup ? 'New manager PIN' : 'Manager PIN'}</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={12}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
            placeholder="4–12 digits"
            disabled={saving}
          />
        </label>
        {isSetup && (
          <label className="manager-action-field">
            <span>Confirm manager PIN</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={12}
              value={confirmPin}
              onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ''))}
              placeholder="Enter it again"
              disabled={saving}
            />
          </label>
        )}
        {!isSetup && (
          <label className="manager-action-field">
            <span>Reason for void</span>
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={250} rows={3} placeholder="For example, entered on the wrong table" disabled={saving} />
          </label>
        )}
        {error && <div className="manager-action-error" role="alert">{error}</div>}
        <footer>
          <button className="manager-action-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className={`manager-action-submit ${isSetup ? '' : 'void'}`} onClick={() => void submit()} disabled={saving}>
            {saving ? 'Please wait…' : isSetup ? 'Save manager PIN' : 'Authorize and void'}
          </button>
        </footer>
        {!isSetup && <small className="manager-action-security-note">Five incorrect PIN attempts lock voiding for five minutes. This action is recorded in the local audit log.</small>}
      </section>
    </div>
  )
}
