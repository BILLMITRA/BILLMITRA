import { useEffect, useState } from 'react'
import { MapPin, Phone, ShoppingBag, UserRound } from 'lucide-react'
import { formatMoney } from '../../../shared/billing'
import type { SavedOrder } from '../../../shared/domain'
import { findSavedDeliveryCustomer } from '../../services/pos'
import './delivery.css'

type DeliveryCustomerDetails = {
  customerName: string
  contactNumber: string
  deliveryAddress: string
  deliveryArea: string
  deliveryLandmark: string
  deliveryInstructions: string
}

type DeliveryCustomerDialogProps = {
  reference: string
  order: SavedOrder
  initialValues: DeliveryCustomerDetails
  onSave: (details: DeliveryCustomerDetails) => Promise<void>
}

export function DeliveryCustomerDialog({ reference, order, initialValues, onSave }: DeliveryCustomerDialogProps) {
  const [customerName, setCustomerName] = useState(initialValues.customerName)
  const [contactNumber, setContactNumber] = useState(initialValues.contactNumber)
  const [deliveryAddress, setDeliveryAddress] = useState(initialValues.deliveryAddress)
  const [deliveryArea, setDeliveryArea] = useState(initialValues.deliveryArea)
  const [deliveryLandmark, setDeliveryLandmark] = useState(initialValues.deliveryLandmark)
  const [deliveryInstructions, setDeliveryInstructions] = useState(initialValues.deliveryInstructions)
  const [customerLookupMessage, setCustomerLookupMessage] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const normalizedNumber = contactNumber.replace(/\D/g, '')
    if (normalizedNumber.length < 7) {
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      setCustomerLookupMessage('Checking saved customers…')
      void findSavedDeliveryCustomer(contactNumber)
        .then((saved) => {
          if (!active) return
          if (saved) {
            setCustomerName(saved.customerName)
            setDeliveryAddress(saved.deliveryAddress)
            setDeliveryArea(saved.deliveryArea)
            setDeliveryLandmark(saved.deliveryLandmark)
            setDeliveryInstructions(saved.deliveryInstructions)
            setCustomerLookupMessage('Saved customer details loaded.')
          } else {
            setCustomerLookupMessage('No saved customer details for this number.')
          }
        })
        .catch((cause: unknown) => {
          if (active) {
            setCustomerLookupMessage(cause instanceof Error
              ? `Customer lookup failed: ${cause.message}`
              : 'Customer lookup failed.')
          }
        })
    }, 450)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [contactNumber])

  async function submit(): Promise<void> {
    if (!contactNumber.trim() || !deliveryAddress.trim()) {
      setError('Contact number and delivery address are required to prepare this order.')
      return
    }
    setError('')
    setSaving(true)
    try {
      await onSave({
        customerName: customerName.trim(),
        contactNumber: contactNumber.trim(),
        deliveryAddress: deliveryAddress.trim(),
        deliveryArea: deliveryArea.trim(),
        deliveryLandmark: deliveryLandmark.trim(),
        deliveryInstructions: deliveryInstructions.trim(),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Customer details could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="delivery-action-backdrop delivery-customer-backdrop" role="presentation">
      <section className="delivery-customer-fullscreen" role="dialog" aria-modal="true" aria-labelledby="delivery-customer-title">
        <header className="delivery-customer-header">
          <div><span className="delivery-action-icon"><MapPin size={20} /></span><div><h1 id="delivery-customer-title">Delivery details</h1><p>{reference} · Contact number and delivery address are required; other details are optional.</p></div></div>
        </header>
        <div className="delivery-customer-layout">
          <div className="delivery-customer-entry">
            <h2>Enter recipient details</h2>
            <label className="delivery-action-field">
              <span><UserRound size={14} /> Customer name (optional)</span>
              <input autoFocus value={customerName} onChange={(event) => setCustomerName(event.target.value)} maxLength={120} placeholder="Enter customer name (optional)" disabled={saving} />
            </label>
            <label className="delivery-action-field">
              <span><Phone size={14} /> Contact number <b aria-hidden="true">*</b></span>
              <input type="tel" inputMode="tel" value={contactNumber} onChange={(event) => { setContactNumber(event.target.value); setCustomerLookupMessage('') }} maxLength={30} placeholder="Enter required phone number" autoComplete="tel" required disabled={saving} />
              {customerLookupMessage && <small className="delivery-customer-lookup-message" role="status">{customerLookupMessage}</small>}
            </label>
            <label className="delivery-action-field">
              <span><MapPin size={14} /> Delivery address <b aria-hidden="true">*</b></span>
              <textarea value={deliveryAddress} onChange={(event) => setDeliveryAddress(event.target.value)} rows={3} placeholder="Enter full delivery address" autoComplete="street-address" required disabled={saving} />
            </label>
            <div className="delivery-customer-optional-grid">
              <label className="delivery-action-field">
                <span>Area / neighbourhood (optional)</span>
                <input value={deliveryArea} onChange={(event) => setDeliveryArea(event.target.value)} maxLength={120} placeholder="Area or neighbourhood" disabled={saving} />
              </label>
              <label className="delivery-action-field">
                <span>Building / landmark (optional)</span>
                <input value={deliveryLandmark} onChange={(event) => setDeliveryLandmark(event.target.value)} maxLength={160} placeholder="Building, gate or nearby landmark" disabled={saving} />
              </label>
            </div>
            <label className="delivery-action-field">
              <span>Delivery instructions (optional)</span>
              <textarea value={deliveryInstructions} onChange={(event) => setDeliveryInstructions(event.target.value)} maxLength={300} rows={2} placeholder="Optional instructions for the rider" disabled={saving} />
            </label>
            {error && <div className="delivery-action-error" role="alert">{error}</div>}
          </div>
          <aside className="delivery-customer-summary" aria-label="Order and delivery summary">
            <div className="delivery-customer-summary-heading"><span className="delivery-action-icon"><ShoppingBag size={19} /></span><div><h2>Order summary</h2><p>{reference} · Recipient details not saved yet</p></div></div>
            <div className="delivery-customer-summary-details">
              <div><small>Customer</small><b>{customerName.trim() || 'Not provided'}</b></div>
              <div><small>Contact number</small><b>{contactNumber.trim() || 'Enter required number'}</b></div>
              <div><small>Delivery address</small><b>{deliveryAddress.trim() || 'Enter required address'}</b></div>
              {(deliveryArea.trim() || deliveryLandmark.trim()) && (
                <div><small>Area / landmark</small><b>{[deliveryArea.trim(), deliveryLandmark.trim()].filter(Boolean).join(' · ')}</b></div>
              )}
            </div>
            <h3>Items</h3>
            <div className="delivery-customer-items">
              {order.items.map((item) => (
                <div key={item.id}><span>{item.quantity} × {item.productName}</span><b>{formatMoney(item.unitPricePaise * item.quantity)}</b></div>
              ))}
            </div>
            <div className="delivery-customer-total"><span>Order total</span><b>{formatMoney(order.totalPaise)}</b></div>
            <p className="delivery-customer-save-note">Recipient details are saved with the order when you continue to prepare the kitchen ticket.</p>
            <button className="delivery-customer-save-button" onClick={() => void submit()} disabled={saving}>
              {saving ? 'Saving details and preparing KOT…' : 'Save details & prepare KOT'}
            </button>
          </aside>
        </div>
      </section>
    </div>
  )
}
