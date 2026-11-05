import { useEffect, useState } from 'react'
import { CalendarClock, MapPin, Phone, Search, ShoppingBag, UserRound, X } from 'lucide-react'
import { formatMoney } from '../../../shared/billing'
import type { DeliveryCustomerRecord, SavedOrder, SaveDeliveryCustomerInput } from '../../../shared/domain'
import { listDeliveryCustomers, saveDeliveryCustomer } from '../../services/pos'
import './delivery.css'

export type DeliveryCustomerDetails = {
  customerName: string
  contactNumber: string
  deliveryAddress: string
  deliveryArea: string
  deliveryLandmark: string
  deliveryInstructions: string
  scheduledDeliveryAt: string | null
  whatsappBillOptIn?: boolean
}

type Props = {
  reference: string
  order: SavedOrder
  initialValues: DeliveryCustomerDetails
  onBack: () => void
  onStage: (details: DeliveryCustomerDetails) => Promise<void>
  onDone: (details: DeliveryCustomerDetails) => Promise<void>
}

function localDateTime(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function withoutTime(record: DeliveryCustomerRecord): Omit<DeliveryCustomerDetails, 'scheduledDeliveryAt'> {
  return {
    customerName: record.customerName, contactNumber: record.contactNumber,
    deliveryAddress: record.deliveryAddress, deliveryArea: record.deliveryArea,
    deliveryLandmark: record.deliveryLandmark, deliveryInstructions: record.deliveryInstructions,
  }
}

export function DeliveryCustomerDialog({ reference, order, initialValues, onBack, onStage, onDone }: Props) {
  const [mode, setMode] = useState<'lookup' | 'form'>('lookup')
  const [query, setQuery] = useState(initialValues.contactNumber || initialValues.customerName)
  const [results, setResults] = useState<DeliveryCustomerRecord[]>([])
  const [selected, setSelected] = useState<DeliveryCustomerRecord | null>(null)
  const [phoneConflict, setPhoneConflict] = useState<DeliveryCustomerRecord | null>(null)
  const [formId, setFormId] = useState<string | undefined>()
  const [details, setDetails] = useState<Omit<DeliveryCustomerDetails, 'scheduledDeliveryAt'>>({ ...initialValues })
  const [schedule, setSchedule] = useState(localDateTime(initialValues.scheduledDeliveryAt))
  const [whatsappBillOptIn, setWhatsappBillOptIn] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setLoading(true)
      void listDeliveryCustomers(query)
        .then(records => {
          if (!active) return
          setResults(records)
          setSelected(current => records.find(record => record.id === current?.id)
            ?? records.find(record => Boolean(initialValues.contactNumber)
              && record.contactNumber.replace(/\D/g, '') === initialValues.contactNumber.replace(/\D/g, '')) ?? null)
        })
        .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Customers could not be loaded.') })
        .finally(() => { if (active) setLoading(false) })
    }, 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, initialValues.contactNumber])

  function edit(record: DeliveryCustomerRecord) {
    setFormId(record.id)
    setPhoneConflict(null)
    setDetails(withoutTime(record))
    setMode('form')
    setError('')
  }

  function startNew() {
    setFormId(undefined)
    setPhoneConflict(null)
    setSelected(null)
    setDetails({ customerName: '', contactNumber: /^\d{7,15}$/.test(query.trim()) ? query.trim() : '',
      deliveryAddress: '', deliveryArea: '', deliveryLandmark: '', deliveryInstructions: '' })
    setMode('form')
    setError('')
  }

  async function saveProfile() {
    if (details.contactNumber.replace(/\D/g, '').length < 7 || !details.deliveryAddress.trim()) {
      setError('Enter a contact number and delivery address before saving.')
      return
    }
    if (schedule && Number.isNaN(new Date(schedule).getTime())) {
      setError('Choose a valid delivery date and time.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const input: SaveDeliveryCustomerInput = { ...details, ...(formId ? { id: formId } : {}) }
      const saved = await saveDeliveryCustomer(input)
      setFormId(saved.id)
      await onStage({ ...withoutTime(saved), scheduledDeliveryAt: schedule ? new Date(schedule).toISOString() : null, whatsappBillOptIn })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Customer details could not be saved.'
      if (message.includes('This contact number belongs to another saved customer')) {
        try {
          const phone = details.contactNumber.replace(/\D/g, '')
          const matches = await listDeliveryCustomers(phone)
          const conflict = matches.find(record => record.contactNumber.replace(/\D/g, '') === phone && record.id !== formId)
          setPhoneConflict(conflict ?? null)
          setError(conflict
            ? `This number is already saved for ${conflict.customerName || 'another customer'}. Select that customer to edit their details.`
            : 'This number is already saved for another customer. Search for that number and select the customer.')
        } catch {
          setError('This number is already saved for another customer. Search for that number and select the customer.')
        }
      } else {
        setError(message)
      }
    } finally { setSaving(false) }
  }

  async function done() {
    if (!selected) return
    if (!selected.deliveryAddress) { edit(selected); setError('Add a delivery address before completing this order.'); return }
    setSaving(true)
    setError('')
    try { await onDone({ ...withoutTime(selected), scheduledDeliveryAt: initialValues.scheduledDeliveryAt, whatsappBillOptIn }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The order could not be completed.') }
    finally { setSaving(false) }
  }

  return <div className="delivery-action-backdrop delivery-customer-backdrop" role="presentation">
    <section className="delivery-customer-fullscreen" role="dialog" aria-modal="true" aria-labelledby="delivery-customer-title">
      <header className="delivery-customer-header"><div><span className="delivery-action-icon"><MapPin size={20} /></span><div>
        <h1 id="delivery-customer-title">{mode === 'lookup' ? 'Select delivery customer' : formId ? 'Edit customer' : 'New customer'}</h1>
        <p>{reference} · Search by phone number or customer name, or create a new customer.</p>
      </div><button className="delivery-customer-close" onClick={onBack} disabled={saving} aria-label="Back to order"><X size={18} /></button></div></header>
      <div className="delivery-customer-layout">
        <div className="delivery-customer-entry">
          {mode === 'lookup' ? <>
            <h2>Saved customers</h2>
            <label className="delivery-action-field"><span><Search size={14} /> Phone number or name</span>
              <input autoFocus value={query} onChange={event => { setQuery(event.target.value); setError('') }} placeholder="Search full number, last digits, or name" />
            </label>
            <div className="delivery-customer-results" role="listbox" aria-label="Saved customers">
              {loading ? <p>Searching saved customers…</p> : results.length ? results.map(record =>
                <button key={record.id} className={`delivery-customer-result ${selected?.id === record.id ? 'selected' : ''}`}
                  onClick={() => setSelected(record)} aria-selected={selected?.id === record.id} role="option">
                  <span><b>{record.customerName || 'Customer without name'}</b><small>{record.contactNumber} · {[record.deliveryArea, record.deliveryAddress].filter(Boolean).join(', ') || 'Address needed'}</small>
                    {record.lastOrderAt && <small>Last bill #{record.lastOrderNumber ?? '—'} · {new Date(record.lastOrderAt).toLocaleDateString('en-IN')}</small>}</span>
                </button>) : <p>{query ? 'No saved customer matches. Choose New customer.' : 'No saved customers yet. Choose New customer.'}</p>}
            </div>
            <div className="delivery-customer-actions"><button onClick={startNew} disabled={saving}>New customer</button><button onClick={() => selected && edit(selected)} disabled={!selected || saving}>Edit selected</button></div>
          </> : <>
            <h2>{formId ? 'Update saved customer' : 'Create customer'}</h2>
            <label className="delivery-action-field"><span><UserRound size={14} /> Customer name (optional)</span><input autoFocus value={details.customerName} onChange={event => setDetails({ ...details, customerName: event.target.value })} maxLength={120} placeholder="Customer name" disabled={saving} /></label>
            <label className="delivery-action-field"><span><Phone size={14} /> Contact number *</span><input type="tel" inputMode="tel" value={details.contactNumber} onChange={event => { setDetails({ ...details, contactNumber: event.target.value }); setPhoneConflict(null); setError('') }} maxLength={30} placeholder="Contact number" disabled={saving} /></label>
            <label className="delivery-action-field"><span><MapPin size={14} /> Delivery address *</span><textarea value={details.deliveryAddress} onChange={event => setDetails({ ...details, deliveryAddress: event.target.value })} maxLength={1000} rows={3} placeholder="Full delivery address" disabled={saving} /></label>
            <div className="delivery-customer-optional-grid"><label className="delivery-action-field"><span>Place / area (optional)</span><input value={details.deliveryArea} onChange={event => setDetails({ ...details, deliveryArea: event.target.value })} maxLength={120} placeholder="Area or neighbourhood" disabled={saving} /></label><label className="delivery-action-field"><span>Landmark (optional)</span><input value={details.deliveryLandmark} onChange={event => setDetails({ ...details, deliveryLandmark: event.target.value })} maxLength={160} placeholder="Building or landmark" disabled={saving} /></label></div>
            <label className="delivery-action-field"><span><CalendarClock size={14} /> Promised delivery time (optional)</span><input type="datetime-local" value={schedule} onChange={event => setSchedule(event.target.value)} disabled={saving} /></label>
            <label className="delivery-action-field"><span>Rider note (optional)</span><textarea value={details.deliveryInstructions} onChange={event => setDetails({ ...details, deliveryInstructions: event.target.value })} maxLength={300} rows={2} placeholder="Instructions for the rider" disabled={saving} /></label>
            <label className="delivery-whatsapp-consent"><input type="checkbox" checked={whatsappBillOptIn} onChange={event => setWhatsappBillOptIn(event.target.checked)} disabled={saving} /> Customer agreed to receive this delivery bill on WhatsApp after Done.</label>
            <div className="delivery-customer-actions"><button onClick={() => { setMode('lookup'); setError('') }} disabled={saving}>Back to search</button><button className="primary" onClick={() => void saveProfile()} disabled={saving}>{saving ? 'Saving…' : 'Save customer'}</button></div>
            <p className="delivery-customer-save-note">After saving, you will return to the order. Press Done there to finish.</p>
          </>}
          {error && <div className="delivery-action-error" role="alert">{error}</div>}
          {mode === 'form' && phoneConflict && <button type="button" onClick={() => edit(phoneConflict)} disabled={saving}>Edit {phoneConflict.customerName || phoneConflict.contactNumber} instead</button>}
        </div>
        <aside className="delivery-customer-summary" aria-label="Order and delivery summary">
          <div className="delivery-customer-summary-heading"><span className="delivery-action-icon"><ShoppingBag size={19} /></span><div><h2>Order summary</h2><p>{reference}</p></div></div>
          <div className="delivery-customer-summary-details"><div><small>Customer</small><b>{selected?.customerName || 'Select or create a customer'}</b></div><div><small>Phone</small><b>{selected?.contactNumber || '—'}</b></div><div><small>Address</small><b>{selected?.deliveryAddress || '—'}</b></div></div>
          <h3>Items</h3><div className="delivery-customer-items">{order.items.map(item => <div key={item.id}><span>{item.quantity} × {item.productName}</span><b>{formatMoney(item.unitPricePaise * item.quantity)}</b></div>)}</div>
          <div className="delivery-customer-total"><span>Order total</span><b>{formatMoney(order.totalPaise)}</b></div>
          {mode === 'lookup' && <><label className="delivery-whatsapp-consent"><input type="checkbox" checked={whatsappBillOptIn} onChange={event => setWhatsappBillOptIn(event.target.checked)} disabled={saving} /> Customer agreed to receive this delivery bill on WhatsApp after Done.</label><p className="delivery-customer-save-note">Select a saved customer, then press Done to finish this delivery order.</p><button className="delivery-customer-save-button" onClick={() => void done()} disabled={!selected || saving}>{saving ? 'Saving order…' : 'Done · use selected customer'}</button></>}
        </aside>
      </div>
    </section>
  </div>
}
