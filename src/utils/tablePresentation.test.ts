import { describe, expect, it } from 'vitest'
import { elapsedClockLabel, tableOrderTimer } from './tablePresentation'

describe('delivery elapsed clock label', () => {
  it('shows elapsed hours, minutes and seconds', () => {
    expect(elapsedClockLabel('2026-10-14 10:00:00', Date.parse('2026-10-14T13:59:38Z')))
      .toBe('3:59:38')
  })

  it('pads minutes and seconds and clamps future start times to zero', () => {
    expect(elapsedClockLabel('2026-10-14 10:00:00', Date.parse('2026-10-14T10:00:09Z')))
      .toBe('0:00:09')
    expect(elapsedClockLabel('2026-10-14 10:01:00', Date.parse('2026-10-14T10:00:00Z')))
      .toBe('0:00:00')
  })

  it('returns no timer for a missing or invalid timestamp', () => {
    expect(elapsedClockLabel(null, 0)).toBe('')
    expect(elapsedClockLabel('not-a-timestamp', 0)).toBe('')
  })
})

describe('desktop occupied table timer', () => {
  const start = Date.parse('2026-10-23T12:00:00Z')
  const table = { orderId: 'saved-order', startedAt: '2026-10-23 12:00:00' }
  it('changes from blue/open to red/overdue at exactly one hour', () => {
    expect(tableOrderTimer(table, start + 3599999)).toEqual({ state: 'open', label: '00:59:59' })
    expect(tableOrderTimer(table, start + 3600000)).toEqual({ state: 'overdue', label: '01:00:00' })
  })
  it('uses UTC and the original timestamp across refreshes', () => {
    expect(tableOrderTimer({ ...table, startedAt: '2026-10-23T17:30:00+05:30' }, start + 7322000)).toEqual({ state: 'overdue', label: '02:02:02' })
    expect(tableOrderTimer({ ...table, startedAt: '2026-10-23T12:00:00' }, start + 2000).label).toBe('00:00:02')
  })
  it('clears the timer for an available table and handles missing times or clock skew', () => {
    expect(tableOrderTimer({ ...table, orderId: null }, start)).toEqual({ state: 'available', label: '' })
    expect(tableOrderTimer({ ...table, startedAt: 'invalid' }, start)).toEqual({ state: 'open', label: 'Time unavailable' })
    expect(tableOrderTimer(table, start - 1000).label).toBe('00:00:00')
  })
})
