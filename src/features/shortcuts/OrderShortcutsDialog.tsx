import { useState } from 'react'
import { defaultOrderShortcuts, saveOrderShortcuts, shortcutActions, shortcutFromEvent, type OrderShortcuts, type ShortcutAction } from './orderShortcuts'
import { loadCardShortcuts } from './cardShortcuts'
import './orderShortcuts.css'

export function OrderShortcutsDialog({ shortcuts, onClose, onSave }: { shortcuts: OrderShortcuts; onClose: () => void; onSave: (value: OrderShortcuts) => void }) {
  const [draft, setDraft] = useState(shortcuts)
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [error, setError] = useState('')

  function capture(event: React.KeyboardEvent, action: ShortcutAction): void {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') { setRecording(null); return }
    const shortcut = shortcutFromEvent(event)
    if (!shortcut) { setError('Press a letter or number, or Ctrl with a letter, number, + or minus.'); return }
    if (Object.entries(draft).some(([id, key]) => id !== action && key === shortcut) || Object.values(loadCardShortcuts()).includes(shortcut)) {
      setError(`${shortcut} is already assigned. Choose another key.`)
      return
    }
    setDraft(current => ({ ...current, [action]: shortcut }))
    setRecording(null)
    setError('')
  }

  return <div className="shortcut-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-dialog-title">
      <h2 id="shortcut-dialog-title">Order shortcuts</h2>
      <p>Manager settings for this device. Click a key, then press the new combination.</p>
      <div className="shortcut-list">{shortcutActions.map(action => <div className="shortcut-row" key={action.id}>
        <span>{action.label}</span>
        <button type="button" onClick={() => { setRecording(action.id); setError('') }} onKeyDown={event => recording === action.id && capture(event, action.id)} aria-label={`Change ${action.label} shortcut`}>
          {recording === action.id ? 'Press a key…' : draft[action.id]}
        </button>
      </div>)}</div>
      {error && <p className="shortcut-error" role="alert">{error}</p>}
      <div className="shortcut-dialog-actions">
        <button type="button" onClick={() => { setDraft(defaultOrderShortcuts); setRecording(null); setError('') }}>Reset defaults</button>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" onClick={() => { try { if (Object.values(draft).some(key => Object.values(loadCardShortcuts()).includes(key))) throw new Error('A shortcut is already used by a card action.'); saveOrderShortcuts(draft); onSave(draft) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save shortcuts.') } }}>Save shortcuts</button>
      </div>
    </section>
  </div>
}
