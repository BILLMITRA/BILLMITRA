import { Armchair, Clock3, Users } from 'lucide-react'
import { formatMoney } from '../../shared/billing'
import type { RestaurantTable } from '../../shared/domain'
import { elapsedLabel, tableStatusLabel } from '../utils/tablePresentation'

interface RestaurantTableCardProps {
  table: RestaurantTable
  selected: boolean
  onSelect: (table: RestaurantTable) => void
}

export function RestaurantTableCard({ table, selected, onSelect }: RestaurantTableCardProps) {
  return (
    <button
      onClick={() => onSelect(table)}
      className={`table-card status-${table.status} ${selected ? 'selected' : ''}`}
    >
      <div className="table-card-top">
        <span className={`table-icon ${table.status}`}><Armchair size={19} /></span>
        <span className={`status-label ${table.status}`}>{tableStatusLabel(table)}</span>
      </div>
      <strong className="table-name">Table {table.name}</strong>
      <span className="table-floor-name">{table.floor}</span>
      <div className="table-meta">
        <span><Users size={13} />{table.capacity} seats</span>
        {table.startedAt && <span><Clock3 size={13} />{elapsedLabel(table.startedAt)}</span>}
      </div>
      {table.orderNumber && (
        <div className="table-order">
          <span>Order #{table.orderNumber}</span>
          <b>{formatMoney(table.amountPaise ?? 0)}</b>
        </div>
      )}
    </button>
  )
}
