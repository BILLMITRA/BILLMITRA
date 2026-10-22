import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, Ban, CalendarClock, Check, CircleAlert, History, MapPin, Pencil,
  Phone, Plus, RefreshCw, Search, Truck, UserRound, Users, X,
} from 'lucide-react'
import type {
  DeliveryEvent,
  DeliveryOperation,
  DeliveryRider,
  DeliveryRiderInput,
  DeliveryScheduleEntry,
  RiderAvailability,
} from '../../../shared/domain'
import { deliveryDelayMinutes, filterDeliverySchedule } from '../../../shared/delivery'
import {
  assignDeliveryRider,
  listDeliveryEvents,
  listDeliveryRiders,
  listDeliverySchedule,
  operateDelivery,
  saveDeliveryRider,
  updateDeliverySchedule,
} from '../../services/pos'
import { formatMoney } from '../../../shared/billing'
import './delivery.css'

type ScheduleFilter = 'all' | 'unassigned' | 'assigned' | 'dispatched' | 'delivered' | 'failed' | 'cancelled'
type ConfirmAction = Extract<DeliveryOperation, { kind: 'ready_for_pickup' | 'dispatch' | 'delivered' }>['kind']
type ReasonAction = Extract<DeliveryOperation, { kind: 'failed' | 'cancelled' }>['kind']
type RiderEditor = DeliveryRider | 'new' | null

interface DeliveryScheduleScreenProps {
  canManageRiders: boolean
  canReassign: boolean
  canCancel: boolean
  onClose: () => void
}

function dateValue(value: string | null): Date | null {
  if (!value) return null
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

function localDateTimeValue(value: string | null): string {
  const date = dateValue(value)
  if (!date) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function displayDate(value: string | null): string {
  const date = dateValue(value)
  return date ? date.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
}

function statusLabel(status: DeliveryScheduleEntry['deliveryStatus'], foodStatus: string): string {
  if (status === 'pending' && foodStatus === 'ready') return 'Ready for pickup'
  return ({
    pending: 'Preparing',
    assigned: 'Assigned',
    dispatched: 'Out for delivery',
    delivered: 'Delivered',
    failed: 'Delivery failed',
    cancelled: 'Cancelled',
  })[status]
}

function dateInputToIso(value: string): string | null {
  return value ? new Date(value).toISOString() : null
}

export function DeliveryScheduleScreen({
  canManageRiders,
  canReassign,
  canCancel,
  onClose,
}: DeliveryScheduleScreenProps) {
  const [entries, setEntries] = useState<DeliveryScheduleEntry[]>([])
  const [riders, setRiders] = useState<DeliveryRider[]>([])
  const [events, setEvents] = useState<DeliveryEvent[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ScheduleFilter>('all')
  const [dateFilter, setDateFilter] = useState('')
  const [sort, setSort] = useState<'scheduled' | 'created' | 'delay'>('scheduled')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null)
  const [selectedOrder, setSelectedOrder] = useState<DeliveryScheduleEntry | null>(null)
  const [assignOrder, setAssignOrder] = useState<DeliveryScheduleEntry | null>(null)
  const [selectedRiderId, setSelectedRiderId] = useState('')
  const [assignmentReason, setAssignmentReason] = useState('')
  const [riderSearch, setRiderSearch] = useState('')
  const [riderEditor, setRiderEditor] = useState<RiderEditor>(null)
  const [riderName, setRiderName] = useState('')
  const [employeeCode, setEmployeeCode] = useState('')
  const [riderPhone, setRiderPhone] = useState('')
  const [riderAvailability, setRiderAvailability] = useState<RiderAvailability>('available')
  const [riderCapacity, setRiderCapacity] = useState('1')
  const [riderActive, setRiderActive] = useState(true)
  const [scheduleOrder, setScheduleOrder] = useState<DeliveryScheduleEntry | null>(null)
  const [pickupTime, setPickupTime] = useState('')
  const [promiseTime, setPromiseTime] = useState('')
  const [confirmAction, setConfirmAction] = useState<{ order: DeliveryScheduleEntry; kind: ConfirmAction } | null>(null)
  const [reasonAction, setReasonAction] = useState<{ order: DeliveryScheduleEntry; kind: ReasonAction } | null>(null)
  const [reasonText, setReasonText] = useState('')
  const [now, setNow] = useState(() => new Date())

  async function refresh(showLoading = true): Promise<void> {
    if (showLoading) {
      setLoading(true)
      setError('')
    }
    try {
      const [nextEntries, nextRiders] = await Promise.all([listDeliverySchedule(), listDeliveryRiders()])
      setEntries(nextEntries)
      setRiders(nextRiders)
      setSelectedOrder((current) => current ? nextEntries.find((entry) => entry.id === current.id) ?? null : null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Delivery schedule could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let mounted = true
    Promise.all([listDeliverySchedule(), listDeliveryRiders()])
      .then(([nextEntries, nextRiders]) => {
        if (!mounted) return
        setEntries(nextEntries)
        setRiders(nextRiders)
      })
      .catch((cause: unknown) => {
        if (mounted) setError(cause instanceof Error ? cause.message : 'Delivery schedule could not be loaded.')
      })
      .finally(() => { if (mounted) setLoading(false) })
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [])

  const selectedOrderId = selectedOrder?.id
  useEffect(() => {
    if (!selectedOrderId) return
    let mounted = true
    listDeliveryEvents(selectedOrderId)
      .then((result) => { if (mounted) setEvents(result) })
      .catch((cause: unknown) => {
        if (mounted) setError(cause instanceof Error ? cause.message : 'Delivery history could not be loaded.')
      })
    return () => { mounted = false }
  }, [selectedOrderId])

  const counts = useMemo(() => ({
    all: entries.length,
    unassigned: entries.filter((entry) => entry.rider === null
      && !['delivered', 'cancelled'].includes(entry.deliveryStatus)).length,
    assigned: entries.filter((entry) => entry.deliveryStatus === 'assigned').length,
    dispatched: entries.filter((entry) => entry.deliveryStatus === 'dispatched').length,
    delivered: entries.filter((entry) => entry.deliveryStatus === 'delivered').length,
    failed: entries.filter((entry) => entry.deliveryStatus === 'failed').length,
    cancelled: entries.filter((entry) => entry.deliveryStatus === 'cancelled').length,
  }), [entries])

  const visibleEntries = useMemo(() => {
    const filtered = filterDeliverySchedule(entries, { query: search, status: filter, date: dateFilter })
    return filtered.sort((a, b) => {
      if (sort === 'created') return (dateValue(b.createdAt)?.getTime() ?? 0) - (dateValue(a.createdAt)?.getTime() ?? 0)
      if (sort === 'delay') return deliveryDelayMinutes(b, now) - deliveryDelayMinutes(a, now)
      return (dateValue(a.promisedDeliveryAt)?.getTime() ?? Infinity)
        - (dateValue(b.promisedDeliveryAt)?.getTime() ?? Infinity)
    })
  }, [dateFilter, entries, filter, now, search, sort])

  const eligibleRiders = useMemo(() => {
    const query = riderSearch.trim().toLocaleLowerCase()
    return riders.filter((rider) => {
      const isCurrent = assignOrder?.rider?.id === rider.id
      const canAssign = rider.canAcceptDelivery || isCurrent && assignOrder?.deliveryStatus === 'assigned'
      const isAlreadyAssigned = assignOrder?.rider && !isCurrent && !canReassign
      const matches = `${rider.name} ${rider.employeeCode} ${rider.contactNumber}`.toLocaleLowerCase().includes(query)
      return canAssign && !isAlreadyAssigned && matches
    })
  }, [assignOrder, canReassign, riderSearch, riders])

  async function runOperation(order: DeliveryScheduleEntry, operation: DeliveryOperation): Promise<void> {
    if (busyOrderId) return
    setBusyOrderId(order.id)
    setError('')
    setNotice('')
    try {
      await operateDelivery(operation)
      setNotice(`${order.reference}: ${operation.kind.replaceAll('_', ' ')} saved.`)
      setConfirmAction(null)
      setReasonAction(null)
      setReasonText('')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Delivery update failed. Refresh and retry.')
    } finally {
      setBusyOrderId(null)
    }
  }

  async function saveAssignment(): Promise<void> {
    if (!assignOrder || !selectedRiderId || busyOrderId) return
    setBusyOrderId(assignOrder.id)
    setError('')
    setNotice('')
    try {
      await assignDeliveryRider({
        orderId: assignOrder.id,
        riderId: selectedRiderId,
        reason: assignmentReason.trim() || undefined,
      })
      setNotice(`${assignOrder.reference} assigned to ${riders.find((rider) => rider.id === selectedRiderId)?.name ?? 'rider'}.`)
      setAssignOrder(null)
      setAssignmentReason('')
      setSelectedRiderId('')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Assignment failed. Refresh and retry.')
    } finally {
      setBusyOrderId(null)
    }
  }

  function openRiderEditor(rider: RiderEditor): void {
    setRiderEditor(rider)
    setRiderName(rider === 'new' || rider === null ? '' : rider.name)
    setEmployeeCode(rider === 'new' || rider === null ? '' : rider.employeeCode)
    setRiderPhone(rider === 'new' || rider === null ? '' : rider.contactNumber)
    setRiderAvailability(rider === 'new' || rider === null ? 'available' : rider.availability)
    setRiderCapacity(rider === 'new' || rider === null ? '1' : String(rider.maxActiveDeliveries))
    setRiderActive(rider === 'new' || rider === null || rider.active)
  }

  async function submitRider(): Promise<void> {
    if (!riderName.trim() || busyOrderId) return
    setBusyOrderId('rider')
    setError('')
    try {
      const input: DeliveryRiderInput = {
        ...(riderEditor && riderEditor !== 'new' ? { id: riderEditor.id } : {}),
        name: riderName.trim(),
        employeeCode: employeeCode.trim(),
        contactNumber: riderPhone.trim(),
        active: riderActive,
        availability: riderAvailability,
        maxActiveDeliveries: Number(riderCapacity),
      }
      await saveDeliveryRider(input)
      setNotice('Rider details saved.')
      setRiderEditor(null)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Rider details could not be saved.')
    } finally {
      setBusyOrderId(null)
    }
  }

  async function saveSchedule(): Promise<void> {
    if (!scheduleOrder || busyOrderId) return
    setBusyOrderId(scheduleOrder.id)
    setError('')
    try {
      await updateDeliverySchedule({
        orderId: scheduleOrder.id,
        scheduledPickupAt: dateInputToIso(pickupTime),
        promisedDeliveryAt: dateInputToIso(promiseTime),
      })
      setNotice(`${scheduleOrder.reference} schedule saved.`)
      setScheduleOrder(null)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Schedule could not be saved.')
    } finally {
      setBusyOrderId(null)
    }
  }

  function openSchedule(entry: DeliveryScheduleEntry): void {
    setScheduleOrder(entry)
    setPickupTime(localDateTimeValue(entry.scheduledPickupAt))
    setPromiseTime(localDateTimeValue(entry.promisedDeliveryAt))
  }

  const currentAssigneeId = assignOrder?.rider?.id ?? ''
  const reassigning = Boolean(currentAssigneeId && selectedRiderId && currentAssigneeId !== selectedRiderId)

  return (
    <section className="delivery-schedule-screen" aria-label="Delivery schedule">
      <header className="delivery-schedule-header">
        <div>
          <span className="delivery-schedule-eyebrow">LOCAL DELIVERY OPERATIONS</span>
          <h1><Truck size={22} /> Delivery schedule</h1>
          <p>Orders, rider workload, and delivery history from this device.</p>
        </div>
        <div className="delivery-schedule-header-actions">
          {canManageRiders && <button onClick={() => openRiderEditor('new')}><Plus size={16} /> Add rider</button>}
          <button onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} /> Refresh</button>
          <button className="delivery-schedule-close" onClick={onClose} aria-label="Close delivery schedule"><X size={18} /></button>
        </div>
      </header>

      <div className="delivery-schedule-content">
        <div className="delivery-schedule-rider-strip">
          <div className="delivery-rider-strip-heading"><Users size={16} /><b>Rider availability</b><span>{riders.length} total</span></div>
          {riders.length === 0 && <span className="delivery-no-riders">No riders yet. Add delivery staff to start assigning orders.</span>}
          {riders.map((rider) => (
            <article className="delivery-rider-chip" key={rider.id}>
              <span className={`delivery-rider-dot ${rider.derivedAvailability}`} />
              <span><b>{rider.name}</b><small>{rider.derivedAvailability.replace('_', ' ')} · {rider.activeDeliveryCount}/{rider.maxActiveDeliveries} active · {rider.canAcceptDelivery ? 'can accept' : 'not accepting'} · updated {displayDate(rider.lastStatusUpdate)}</small></span>
              {canManageRiders && <button aria-label={`Edit ${rider.name}`} onClick={() => openRiderEditor(rider)}><Pencil size={14} /></button>}
            </article>
          ))}
        </div>

        <div className="delivery-schedule-tabs" role="tablist" aria-label="Delivery status filter">
          {([
            ['all', 'All deliveries'], ['unassigned', 'New / unassigned'], ['assigned', 'Assigned'],
            ['dispatched', 'Out for delivery'], ['delivered', 'Delivered'], ['failed', 'Failed'],
            ['cancelled', 'Cancelled'],
          ] as const).map(([value, label]) => (
            <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? 'selected' : ''}
              onClick={() => setFilter(value)}>{label}<b>{counts[value]}</b></button>
          ))}
        </div>

        <div className="delivery-schedule-controls">
          <label className="delivery-schedule-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search order, customer, phone, rider, area or address" /></label>
          <label className="delivery-schedule-date">Order date <input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} /></label>
          <label className="delivery-schedule-sort">Sort by
            <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
              <option value="scheduled">Promised time</option><option value="created">Order time</option><option value="delay">Most delayed</option>
            </select>
          </label>
        </div>

        {error && <div className="delivery-schedule-error" role="alert"><CircleAlert size={16} />{error}</div>}
        {notice && <div className="delivery-schedule-notice" role="status"><Check size={16} />{notice}</div>}
        <div className="delivery-schedule-table-wrap">
          <table className="delivery-schedule-table">
            <thead><tr>
              <th>Order / created</th><th>Promised / delay</th><th>Pickup / ready</th><th>Customer / address</th>
              <th>Rider</th><th>Status / total</th><th>Actions</th>
            </tr></thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="delivery-schedule-empty">Loading saved deliveries…</td></tr>}
              {!loading && visibleEntries.length === 0 && <tr><td colSpan={7} className="delivery-schedule-empty">
                {entries.length ? 'No delivery orders match these filters.' : 'No saved delivery orders yet. New home-delivery orders will appear here.'}
              </td></tr>}
              {!loading && visibleEntries.map((entry) => {
                const lateBy = deliveryDelayMinutes(entry, now)
                const canAssign = entry.foodStatus === 'ready' && !['delivered', 'cancelled'].includes(entry.deliveryStatus)
                  && (!entry.rider || entry.deliveryStatus === 'failed' || canReassign)
                return (
                  <tr key={entry.id}>
                    <td><button className="delivery-order-reference" onClick={() => setSelectedOrder(entry)}>{entry.reference}</button><small>{displayDate(entry.createdAt)}</small></td>
                    <td>{displayDate(entry.promisedDeliveryAt)}<small className={lateBy ? 'delivery-late' : ''}>{lateBy ? `${lateBy} min late` : entry.promisedDeliveryAt ? 'On time' : 'No promise set'}</small></td>
                    <td>{displayDate(entry.actualPickupAt)}<small>{entry.readyForPickupAt ? `Ready ${displayDate(entry.readyForPickupAt)}` : entry.scheduledPickupAt ? `Planned ${displayDate(entry.scheduledPickupAt)}` : 'Not scheduled'}</small></td>
                    <td className="delivery-customer-cell"><b>{entry.customerName || 'Customer details pending'}</b><small><Phone size={11} />{entry.contactNumber || 'No phone'}</small><small><MapPin size={11} />{[entry.deliveryArea, entry.deliveryLandmark, entry.deliveryAddress].filter(Boolean).join(' · ') || 'No address'}</small></td>
                    <td>{entry.rider?.name ?? (entry.assignedDeliveryTo ? `Unverified: ${entry.assignedDeliveryTo}` : 'Unassigned')}<small>{entry.rider ? `${entry.rider.activeDeliveryCount}/${entry.rider.maxActiveDeliveries} active` : ''}</small></td>
                    <td><span className={`delivery-status-badge ${entry.deliveryStatus}`}>{statusLabel(entry.deliveryStatus, entry.foodStatus)}</span><small>{formatMoney(entry.totalPaise)} · {entry.paymentStatus}</small></td>
                    <td className="delivery-row-actions">
                      <button title="View order and history" aria-label={`View ${entry.reference}`} onClick={() => setSelectedOrder(entry)}><History size={14} /></button>
                      <button title="Edit schedule" aria-label={`Edit schedule ${entry.reference}`} onClick={() => openSchedule(entry)} disabled={['delivered', 'cancelled'].includes(entry.deliveryStatus)}><CalendarClock size={14} /></button>
                      {entry.foodStatus !== 'ready' && !['delivered', 'cancelled'].includes(entry.deliveryStatus) && (
                        <button title="Mark ready for pickup" onClick={() => setConfirmAction({ order: entry, kind: 'ready_for_pickup' })}>Ready</button>
                      )}
                      {canAssign && <button title={entry.rider ? 'Reassign rider' : 'Assign rider'} onClick={() => {
                        setAssignOrder(entry)
                        setSelectedRiderId(entry.rider?.id ?? '')
                        setAssignmentReason('')
                        setRiderSearch('')
                      }}>{entry.rider ? 'Reassign' : 'Assign'}</button>}
                      {entry.deliveryStatus === 'assigned' && <button title="Mark dispatched" onClick={() => setConfirmAction({ order: entry, kind: 'dispatch' })}>Dispatch</button>}
                      {entry.deliveryStatus === 'dispatched' && <>
                        <button title="Mark delivered" onClick={() => setConfirmAction({ order: entry, kind: 'delivered' })}>Delivered</button>
                        <button title="Record delivery failure" onClick={() => { setReasonAction({ order: entry, kind: 'failed' }); setReasonText('') }}>Failed</button>
                      </>}
                      {canCancel && !['delivered', 'cancelled'].includes(entry.deliveryStatus)
                        && <button title="Cancel delivery" onClick={() => { setReasonAction({ order: entry, kind: 'cancelled' }); setReasonText('') }}><Ban size={14} /></button>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {assignOrder && <div className="delivery-modal-backdrop" role="presentation">
        <section className="delivery-modal" role="dialog" aria-modal="true" aria-labelledby="delivery-assign-title">
          <header><div><span className="delivery-action-icon"><Truck size={19} /></span><h2 id="delivery-assign-title">{assignOrder.rider ? 'Reassign delivery' : 'Assign delivery rider'}</h2></div>
            <button onClick={() => setAssignOrder(null)} aria-label="Close assignment"><X size={18} /></button></header>
          <p>{assignOrder.reference} · {assignOrder.customerName || 'Customer details pending'}</p>
          <label className="delivery-modal-search"><Search size={15} /><input value={riderSearch} onChange={(event) => setRiderSearch(event.target.value)} placeholder="Search eligible riders" /></label>
          <div className="delivery-eligible-riders">
            {eligibleRiders.length === 0 && <div className="delivery-schedule-empty">No eligible riders. Add an active rider or free rider capacity.</div>}
            {eligibleRiders.map((rider) => (
              <label className={`delivery-eligible-rider ${selectedRiderId === rider.id ? 'selected' : ''}`} key={rider.id}>
                <input type="radio" name="delivery-rider" value={rider.id} checked={selectedRiderId === rider.id} onChange={() => setSelectedRiderId(rider.id)} />
                <span className={`delivery-rider-dot ${rider.derivedAvailability}`} />
                <span><b>{rider.name}{rider.employeeCode ? ` · ${rider.employeeCode}` : ''}</b><small>{rider.derivedAvailability} · {rider.activeDeliveryCount}/{rider.maxActiveDeliveries} active · {rider.canAcceptDelivery ? 'can accept another' : 'at capacity or unavailable'} · {rider.completedDeliveryCount} completed · updated {displayDate(rider.lastStatusUpdate)}</small></span>
                <small>{rider.contactNumber}</small>
              </label>
            ))}
          </div>
          {assignOrder.rider && <label className="delivery-modal-field"><span>Reason for reassignment</span><textarea value={assignmentReason} onChange={(event) => setAssignmentReason(event.target.value)} rows={2} maxLength={250} placeholder="Required when changing riders" /></label>}
          <footer><button onClick={() => setAssignOrder(null)}>Cancel</button><button className="primary" onClick={() => void saveAssignment()} disabled={!selectedRiderId || Boolean(busyOrderId) || (reassigning && assignmentReason.trim().length < 3)}>{busyOrderId === assignOrder.id ? 'Saving…' : 'Confirm assignment'}</button></footer>
        </section>
      </div>}

      {scheduleOrder && <div className="delivery-modal-backdrop" role="presentation">
        <section className="delivery-modal delivery-schedule-edit" role="dialog" aria-modal="true" aria-labelledby="delivery-time-title">
          <header><div><span className="delivery-action-icon"><CalendarClock size={19} /></span><h2 id="delivery-time-title">Delivery times · {scheduleOrder.reference}</h2></div><button onClick={() => setScheduleOrder(null)} aria-label="Close schedule"><X size={18} /></button></header>
          <label className="delivery-modal-field"><span>Scheduled pickup time</span><input type="datetime-local" value={pickupTime} onChange={(event) => setPickupTime(event.target.value)} /></label>
          <label className="delivery-modal-field"><span>Promised delivery time</span><input type="datetime-local" value={promiseTime} onChange={(event) => setPromiseTime(event.target.value)} /></label>
          <footer><button onClick={() => setScheduleOrder(null)}>Cancel</button><button className="primary" onClick={() => void saveSchedule()} disabled={Boolean(busyOrderId)}>{busyOrderId === scheduleOrder.id ? 'Saving…' : 'Save times'}</button></footer>
        </section>
      </div>}

      {riderEditor && <div className="delivery-modal-backdrop" role="presentation">
        <section className="delivery-modal delivery-rider-editor" role="dialog" aria-modal="true" aria-labelledby="delivery-rider-title">
          <header><div><span className="delivery-action-icon"><UserRound size={19} /></span><h2 id="delivery-rider-title">{riderEditor === 'new' ? 'Add delivery rider' : 'Edit delivery rider'}</h2></div><button onClick={() => setRiderEditor(null)} aria-label="Close rider form"><X size={18} /></button></header>
          <label className="delivery-modal-field"><span>Full name</span><input value={riderName} onChange={(event) => setRiderName(event.target.value)} maxLength={120} autoFocus /></label>
          <div className="delivery-rider-form-grid"><label className="delivery-modal-field"><span>Employee code</span><input value={employeeCode} onChange={(event) => setEmployeeCode(event.target.value)} maxLength={40} /></label>
            <label className="delivery-modal-field"><span>Contact number</span><input type="tel" value={riderPhone} onChange={(event) => setRiderPhone(event.target.value)} maxLength={30} /></label></div>
          <div className="delivery-rider-form-grid"><label className="delivery-modal-field"><span>Availability</span><select value={riderAvailability} onChange={(event) => setRiderAvailability(event.target.value as RiderAvailability)}><option value="available">Available</option><option value="unavailable">Unavailable</option><option value="off_shift">Off shift</option></select></label>
            <label className="delivery-modal-field"><span>Max active deliveries</span><input type="number" min="1" max="20" value={riderCapacity} onChange={(event) => setRiderCapacity(event.target.value)} /></label></div>
          <label className="delivery-rider-active"><input type="checkbox" checked={riderActive} onChange={(event) => setRiderActive(event.target.checked)} /> Active rider (inactive riders cannot receive assignments)</label>
          <footer><button onClick={() => setRiderEditor(null)}>Cancel</button><button className="primary" onClick={() => void submitRider()} disabled={!riderName.trim() || Boolean(busyOrderId)}>{busyOrderId === 'rider' ? 'Saving…' : 'Save rider'}</button></footer>
        </section>
      </div>}

      {confirmAction && <div className="delivery-modal-backdrop" role="presentation"><section className="delivery-modal delivery-confirm-modal" role="dialog" aria-modal="true">
        <header><div><span className="delivery-action-icon"><CircleAlert size={19} /></span><h2>Confirm delivery update</h2></div><button onClick={() => setConfirmAction(null)} aria-label="Close confirmation"><X size={18} /></button></header>
        <p>{confirmAction.order.reference}: {confirmAction.kind.replaceAll('_', ' ')}?</p>
        {confirmAction.kind === 'delivered' && <p>Delivery completion will not record payment or change the invoice total.</p>}
        <footer><button onClick={() => setConfirmAction(null)}>Go back</button><button className="primary" onClick={() => void runOperation(confirmAction.order, { kind: confirmAction.kind, orderId: confirmAction.order.id })} disabled={Boolean(busyOrderId)}>{busyOrderId === confirmAction.order.id ? 'Saving…' : 'Confirm'}</button></footer>
      </section></div>}

      {reasonAction && <div className="delivery-modal-backdrop" role="presentation"><section className="delivery-modal delivery-confirm-modal" role="dialog" aria-modal="true">
        <header><div><span className="delivery-action-icon"><CircleAlert size={19} /></span><h2>{reasonAction.kind === 'failed' ? 'Record delivery failure' : 'Cancel delivery'}</h2></div><button onClick={() => setReasonAction(null)} aria-label="Close"><X size={18} /></button></header>
        <p>{reasonAction.order.reference} · Reason is required and will be kept in the delivery history.</p>
        <label className="delivery-modal-field"><span>Reason</span><textarea value={reasonText} onChange={(event) => setReasonText(event.target.value)} rows={3} maxLength={250} autoFocus /></label>
        <footer><button onClick={() => setReasonAction(null)}>Go back</button><button className="primary" onClick={() => void runOperation(reasonAction.order, { kind: reasonAction.kind, orderId: reasonAction.order.id, reason: reasonText.trim() })} disabled={reasonText.trim().length < 3 || Boolean(busyOrderId)}>{busyOrderId === reasonAction.order.id ? 'Saving…' : 'Save status'}</button></footer>
      </section></div>}

      {selectedOrder && <div className="delivery-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedOrder(null) }}>
        <section className="delivery-modal delivery-order-details" role="dialog" aria-modal="true" aria-labelledby="delivery-details-title">
          <header><div><span className="delivery-action-icon"><Truck size={19} /></span><h2 id="delivery-details-title">{selectedOrder.reference} details</h2></div><button onClick={() => setSelectedOrder(null)} aria-label="Close details"><X size={18} /></button></header>
          <div className="delivery-detail-grid"><div><small>Customer</small><b>{selectedOrder.customerName || '—'}</b></div><div><small>Phone</small><b>{selectedOrder.contactNumber || '—'}</b></div><div><small>Address</small><b>{selectedOrder.deliveryAddress || '—'}</b></div><div><small>Area / landmark</small><b>{[selectedOrder.deliveryArea, selectedOrder.deliveryLandmark].filter(Boolean).join(' · ') || '—'}</b></div><div><small>Instructions</small><b>{selectedOrder.deliveryInstructions || '—'}</b></div><div><small>Payment</small><b>{selectedOrder.paymentStatus}</b></div><div><small>Invoice total</small><b>{formatMoney(selectedOrder.totalPaise)}</b></div><div><small>Ready for pickup</small><b>{displayDate(selectedOrder.readyForPickupAt)}</b></div><div><small>Actual pickup / dispatch</small><b>{displayDate(selectedOrder.actualPickupAt)} / {displayDate(selectedOrder.dispatchedAt)}</b></div><div><small>Delivered</small><b>{displayDate(selectedOrder.deliveredAt)}</b></div></div>
          <h3>Order items</h3><div className="delivery-detail-items">{selectedOrder.items.map((item) => <div key={item.id}><span>{item.quantity} × {item.productName}<small>{item.note || 'No item notes'}</small></span><b>{formatMoney(item.unitPricePaise * item.quantity)}</b></div>)}</div>
          <h3>Delivery history</h3><div className="delivery-event-list">{events.length ? events.map((event) => <article key={event.id}><span className="delivery-event-marker" /><div><b>{event.eventType.replaceAll('_', ' ')}</b><small>{displayDate(event.createdAt)} · {event.actor}{event.reason ? ` · ${event.reason}` : ''}</small></div></article>) : <small>No delivery events recorded yet.</small>}</div>
          <footer><button onClick={() => setSelectedOrder(null)}>Close</button></footer>
        </section>
      </div>}

      <div className="delivery-schedule-back" onClick={onClose}><ArrowLeft size={14} /> Back to cashier</div>
    </section>
  )
}
