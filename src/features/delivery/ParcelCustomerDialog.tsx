import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { DeliveryCustomerRecord, SaveDeliveryCustomerInput } from '../../../shared/domain'
import { listDeliveryCustomers, saveDeliveryCustomer } from '../../services/pos'
import './delivery.css'

type Props = {
  reference: string
  initialNumber: string
  onClose: () => void
  onSelect: (customer: DeliveryCustomerRecord) => Promise<void>
}

export function ParcelCustomerDialog({ reference, initialNumber, onClose, onSelect }: Props) {
  const [query, setQuery] = useState(initialNumber)
  const [results, setResults] = useState<DeliveryCustomerRecord[]>([])
  const [selected, setSelected] = useState<DeliveryCustomerRecord | null>(null)
  const [editing, setEditing] = useState<DeliveryCustomerRecord | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [number, setNumber] = useState('')
  const [place, setPlace] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      void listDeliveryCustomers(query).then(records => {
        if (!active) return
        setResults(records)
        setSelected(current => records.find(record => record.id === current?.id) ?? null)
      }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Customers could not be loaded.') })
    }, 200)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query])

  function openForm(customer?: DeliveryCustomerRecord) {
    setEditing(customer ?? null)
    setName(customer?.customerName ?? '')
    setNumber(customer?.contactNumber ?? (/^\d+$/.test(query.trim()) ? query.trim() : ''))
    setPlace(customer?.deliveryArea ?? '')
    setFormOpen(true)
    setError('')
  }

  async function useCustomer(customer: DeliveryCustomerRecord) {
    setBusy(true)
    setError('')
    try { await onSelect(customer) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Customer could not be added to this order.') }
    finally { setBusy(false) }
  }

  async function save() {
    if (!/^\d{1,30}$/.test(number.trim())) { setError('Enter a number or customer code using up to 30 digits. Three digits are allowed.'); return }
    setBusy(true)
    setError('')
    try {
      const input: SaveDeliveryCustomerInput = {
        ...(editing ? { id: editing.id } : {}), customerName: name.trim(), contactNumber: number.trim(),
        deliveryAddress: editing?.deliveryAddress || place.trim(), deliveryArea: place.trim(),
        deliveryLandmark: editing?.deliveryLandmark ?? '', deliveryInstructions: editing?.deliveryInstructions ?? '',
      }
      const customer = await saveDeliveryCustomer(input)
      await onSelect(customer)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Customer could not be saved.') }
    finally { setBusy(false) }
  }

  return <div className="delivery-action-backdrop delivery-customer-backdrop" role="presentation">
    <section className="delivery-customer-fullscreen" role="dialog" aria-modal="true" aria-labelledby="parcel-customer-title">
      <header className="delivery-customer-header"><div><div><h1 id="parcel-customer-title">Customer for {reference}</h1>
        <p>Optional. Find a saved customer, add a number, or skip this step.</p></div>
        <button className="delivery-customer-close" onClick={onClose} disabled={busy} aria-label="Close customer"><X size={18} /></button>
      </div></header>
      <div className="delivery-customer-layout"><div className="delivery-customer-entry">
        {formOpen ? <>
          <h2>{editing ? 'Edit customer' : 'New customer'}</h2>
          <label className="delivery-action-field"><span>Number or customer code *</span><input autoFocus inputMode="numeric" value={number} onChange={event => setNumber(event.target.value)} maxLength={30} placeholder="For example, 928 or full phone number" disabled={busy} /></label>
          <label className="delivery-action-field"><span>Name (optional)</span><input value={name} onChange={event => setName(event.target.value)} maxLength={120} disabled={busy} /></label>
          <label className="delivery-action-field"><span>Place (optional)</span><input value={place} onChange={event => setPlace(event.target.value)} maxLength={120} disabled={busy} /></label>
          <div className="delivery-customer-actions"><button onClick={() => setFormOpen(false)} disabled={busy}>Back to search</button><button className="primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save customer'}</button></div>
        </> : <>
          <h2>Saved customers</h2>
          <label className="delivery-action-field"><span><Search size={14} /> Search name or number</span><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Full number, last three digits, or name" /></label>
          <div className="delivery-customer-results" role="listbox" aria-label="Saved customers">
            {results.length ? results.map(customer => <button key={customer.id} className={`delivery-customer-result ${selected?.id === customer.id ? 'selected' : ''}`} role="option" aria-selected={selected?.id === customer.id} onClick={() => setSelected(customer)}><span><b>{customer.customerName || customer.contactNumber}</b><small>{customer.contactNumber}{customer.deliveryArea ? ` · ${customer.deliveryArea}` : ''}</small></span></button>) : <p>{query ? 'No matching customer. Choose New customer.' : 'No saved customers yet.'}</p>}
          </div>
          <div className="delivery-customer-actions"><button onClick={() => openForm()} disabled={busy}>New customer</button><button onClick={() => selected && openForm(selected)} disabled={!selected || busy}>Edit selected</button><button className="primary" onClick={() => selected && void useCustomer(selected)} disabled={!selected || busy}>{busy ? 'Saving…' : 'Use selected customer'}</button></div>
        </>}
        {error && <div className="delivery-action-error" role="alert">{error}</div>}
      </div></div>
    </section>
  </div>
}
