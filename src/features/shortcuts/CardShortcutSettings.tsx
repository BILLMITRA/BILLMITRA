import { useState } from 'react'
import { cardActions, cardShortcutFromEvent, defaultCardShortcuts, saveCardShortcuts, type CardAction, type CardShortcuts } from './cardShortcuts'
import { loadOrderShortcuts } from './orderShortcuts'

export function CardShortcutSettings({ shortcuts, onSave }: { shortcuts: CardShortcuts; onSave: (shortcuts: CardShortcuts) => void }) {
  const [draft, setDraft] = useState(shortcuts)
  const [recording, setRecording] = useState<CardAction | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  function capture(event: React.KeyboardEvent<HTMLButtonElement>, action: CardAction) {
    event.preventDefault(); event.stopPropagation()
    if (event.key === 'Escape') { setRecording(null); return }
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return
    const shortcut = cardShortcutFromEvent(event)
    if (!shortcut) { setError('Press Shift, Ctrl or Alt with a letter.'); return }
    if (Object.entries(draft).some(([id, value]) => id !== action && value === shortcut) || Object.values(loadOrderShortcuts()).includes(shortcut)) {
      setError(`${shortcut} is already assigned. Choose another shortcut.`); return
    }
    setDraft(value => ({ ...value, [action]: shortcut })); setRecording(null); setError(''); setNotice('')
  }
  function save() {
    try {
      if (Object.values(draft).some(key => Object.values(loadOrderShortcuts()).includes(key))) throw new Error('A shortcut is already used by an order action.')
      saveCardShortcuts(draft); onSave(draft); setNotice('Shortcuts saved on this device.'); setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save shortcuts.') }
  }
  return <section className="management-card appearance-settings"><h2>Card shortcuts</h2>
    <p>Choose a key combination for each available card. Shortcuts are saved on this device and work on the card screen.</p>
    <div className="shortcut-list">{cardActions.map(action => <div className="shortcut-row" key={action.id}><span>{action.label}</span>
      <button type="button" onClick={() => { setRecording(action.id); setError('') }} onKeyDown={event => recording === action.id && capture(event, action.id)} aria-label={`Change ${action.label}`}>
        {recording === action.id ? 'Press a shortcut…' : draft[action.id]}</button></div>)}</div>
    {error && <p className="management-error" role="alert">{error}</p>}{notice && <p className="management-notice" role="status">{notice}</p>}
    <div className="appearance-options"><button type="button" onClick={() => { setDraft(defaultCardShortcuts); setRecording(null); setError(''); setNotice('') }}>Reset defaults</button><button type="button" onClick={save} aria-pressed="true">Save shortcuts</button></div>
  </section>
}
