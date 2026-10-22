import { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { formatOrderReference, type BillHistoryEntry } from '../../../shared/domain'
import { formatMoney } from '../../../shared/billing'
import './payments.css'

interface BillHistoryDialogProps {
  entries: BillHistoryEntry[]
  loading: boolean
  error: string
  onClose: () => void
  onSelect: (entry: BillHistoryEntry) => void
}

export function BillHistoryDialog({ entries, loading, error, onClose, onSelect }: BillHistoryDialogProps) {
  const [search, setSearch] = useState('')
  const visibleEntries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return entries
    return entries.filter(({ order, payment }) => (
    `#${order.orderNumber} ${formatOrderReference(order)} ${order.customerName} ${order.type} ${order.tableId ?? ''} ${payment?.method ?? ''} ${order.status}`
        .toLocaleLowerCase()
        .includes(query)
    ))
  }, [entries, search])

  return (
    <div className="history-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <header className="history-heading">
          <div><span className="eyebrow">LOCAL DEVICE</span><h2 id="history-title">Bill history</h2><p>Saved bills and recorded payments</p></div>
          <button className="history-close" aria-label="Close bill history" onClick={onClose}><X size={18} /></button>
        </header>
        <label className="history-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search bill, customer, table, or method" /></label>
        {error && <div className="history-error" role="alert">{error}</div>}
        <div className="history-list">
          {loading && <div className="history-empty">Loading saved bills…</div>}
          {!loading && visibleEntries.length === 0 && <div className="history-empty">No bills match your search.</div>}
          {!loading && visibleEntries.map((entry) => (
            <article className="history-row" key={entry.order.id}>
              <div className="history-row-main">
                <div className="history-row-title">
                  <strong>Bill {formatOrderReference(entry.order)}</strong>
                  <span className={`history-status ${entry.order.status === 'voided' ? 'voided' : entry.payment ? 'paid' : 'unpaid'}`}>{entry.order.status === 'voided' ? 'Voided' : entry.payment ? 'Paid' : 'Unpaid'}</span>
                </div>
                <span>{entry.order.customerName || (entry.order.tableId ? 'Dine-in table' : entry.order.type.replace('_', ' '))}</span>
                <small>{new Date(`${(entry.payment?.paidAt ?? entry.order.createdAt).replace(' ', 'T')}Z`).toLocaleString('en-IN')} · {entry.order.type.replace('_', ' ')}</small>
              </div>
              <div className="history-row-end">
                <strong>{formatMoney(entry.order.totalPaise)}</strong>
                <small>{entry.order.status === 'voided' ? 'Voided' : entry.payment ? entry.payment.method.toUpperCase() : 'Payment due'}</small>
                <button onClick={() => onSelect(entry)}>Open bill</button>
              </div>
            </article>
          ))}
        </div>
        <footer className="history-footer">Bills are stored locally. Voids and duplicate kitchen-ticket requests are recorded in the local audit log; no card details are stored.</footer>
      </section>
    </div>
  )
}
