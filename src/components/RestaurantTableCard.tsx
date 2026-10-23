import { Armchair, Clock3, Printer, Users } from 'lucide-react'
import { formatMoney } from '../../shared/billing'
import type { RestaurantTable } from '../../shared/domain'
import { tableOrderTimer, tableStatusLabel } from '../utils/tablePresentation'

interface RestaurantTableCardProps {
  table: RestaurantTable
  selected: boolean
  onSelect: (table: RestaurantTable) => void
  now: number
  onPrint?: (table: RestaurantTable, kind: 'bill' | 'kot') => void
}

export function RestaurantTableCard({ table, selected, onSelect, now, onPrint }: RestaurantTableCardProps) {
  const timer = tableOrderTimer(table, now)
  const occupied = timer.state !== 'available'
  return (
    <article className={`table-tile timer-${timer.state}`}>
    <button
      onClick={() => onSelect(table)}
      className={`table-card status-${table.status} timer-${timer.state} ${selected ? 'selected' : ''}`}
      aria-pressed={selected}
      aria-label={`Table ${table.name}, ${table.floor}, ${tableStatusLabel(table)}${occupied ? `, open ${timer.label}${timer.state === 'overdue' ? ', over one hour' : ''}` : ''}`}
    >
      <div className="table-card-top">
        <span className={`table-icon ${table.status}`}><Armchair size={19} /></span>
        <span className={`status-label ${table.status}`}>{tableStatusLabel(table)}</span>
      </div>
      <strong className="table-name">Table {table.name}</strong>
      <span className="table-floor-name">{table.floor}</span>
      <div className="table-meta">
        <span><Users size={13} />{table.capacity} seats</span>
      </div>
      {occupied && <div className="table-elapsed"><Clock3 size={15} /><b>{timer.label}</b>{timer.state === 'overdue' && <span>Over 1 hour</span>}</div>}
      {table.orderNumber && (
        <div className="table-order">
          <span>Order #{table.orderNumber}</span>
          <b>{formatMoney(table.amountPaise ?? 0)}</b>
        </div>
      )}
    </button>
    {occupied && onPrint && <div className="table-print-actions"><button onClick={() => onPrint(table, 'bill')} aria-label={`Print bill for table ${table.name}`}><Printer size={13} />Print Bill</button><button onClick={() => onPrint(table, 'kot')} aria-label={`Print KOT for table ${table.name}`}><Printer size={13} />Print KOT</button></div>}
    </article>
  )
}
