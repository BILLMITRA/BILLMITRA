import { describe, expect, it } from 'vitest'
import { elapsedClockLabel } from './tablePresentation'

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
