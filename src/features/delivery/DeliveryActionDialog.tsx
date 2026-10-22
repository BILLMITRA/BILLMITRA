import { useState } from 'react'
import { CalendarClock, X } from 'lucide-react'
import './delivery.css'

type DeliveryDetails = {
  scheduledDeliveryAt: string | null
}

type DeliveryActionDialogProps = {
  reference: string
  scheduledDeliveryAt: string | null
  onClose: () => void
  onSave: (details: DeliveryDetails) => Promise<void>
}

function toLocalDateTimeInput(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function DeliveryActionDialog({
  reference,
  scheduledDeliveryAt,
  onClose,
  onSave,
}: DeliveryActionDialogProps) {
  const [schedule, setSchedule] = useState(() => toLocalDateTimeInput(scheduledDeliveryAt))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function save(): Promise<void> {
    setError('')
    if (schedule && Number.isNaN(new Date(schedule).getTime())) {
      setError('Choose a valid delivery date and time.')
      return
    }
    setSaving(true)
    try {
      await onSave({
        scheduledDeliveryAt: schedule ? new Date(schedule).toISOString() : null,
      })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Delivery details could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="delivery-action-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose()
    }}>
      <section className="delivery-action-dialog" role="dialog" aria-modal="true" aria-labelledby="delivery-action-title">
        <header>
          <span className="delivery-action-icon"><CalendarClock size={20} /></span>
          <button className="delivery-action-close" aria-label="Close" onClick={onClose} disabled={saving}><X size={18} /></button>
        </header>
        <h2 id="delivery-action-title">Promised delivery time</h2>
        <p>{reference} · Choose when this order should be delivered.</p>
        <label className="delivery-action-field">
          <span>Promised date and time</span>
          <input type="datetime-local" value={schedule} onChange={(event) => setSchedule(event.target.value)} disabled={saving} />
        </label>
        {error && <div className="delivery-action-error" role="alert">{error}</div>}
        <footer>
          <button className="delivery-action-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="delivery-action-submit" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save schedule'}
          </button>
        </footer>
        {schedule && <button className="delivery-action-clear" onClick={() => setSchedule('')} disabled={saving}>Clear schedule</button>}
      </section>
    </div>
  )
}
