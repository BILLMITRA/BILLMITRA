import { describe, expect, it } from 'vitest'
import { cardShortcutFromEvent, defaultCardShortcuts, validCardShortcuts } from './cardShortcuts'

describe('card shortcuts', () => {
  it('detects Shift shortcuts and ignores unmodified typing', () => {
    const event = { key: 'P', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }
    expect(cardShortcutFromEvent(event)).toBe('Shift+P')
    expect(cardShortcutFromEvent({ ...event, shiftKey: false })).toBeNull()
    expect(cardShortcutFromEvent({ ...event, metaKey: true })).toBeNull()
  })
  it('accepts distinct shortcuts and rejects duplicates', () => {
    expect(validCardShortcuts(defaultCardShortcuts)).toBe(true)
    expect(validCardShortcuts({ ...defaultCardShortcuts, delivery: 'Shift+P' })).toBe(false)
    expect(validCardShortcuts({ ...defaultCardShortcuts, parcel: 'P' })).toBe(false)
  })
})
