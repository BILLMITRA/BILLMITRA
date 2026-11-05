import { describe, expect, it } from 'vitest'
import { defaultOrderShortcuts, shortcutFromEvent, validOrderShortcuts } from './orderShortcuts'

describe('order shortcuts', () => {
  it('recognizes the requested Done and reduce keys', () => {
    expect(shortcutFromEvent({ ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, key: 'd' } as KeyboardEvent)).toBe('Ctrl+D')
    expect(shortcutFromEvent({ ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, key: '-' } as KeyboardEvent)).toBe('Ctrl+-')
  })

  it('uses P to print and R to recall', () => {
    expect(defaultOrderShortcuts.printBill).toBe('P')
    expect(defaultOrderShortcuts.recall).toBe('R')
    expect(shortcutFromEvent({ ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, key: 'p' } as KeyboardEvent)).toBe('P')
    expect(shortcutFromEvent({ ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, key: 'r' } as KeyboardEvent)).toBe('R')
    expect(validOrderShortcuts({ ...defaultOrderShortcuts, recall: 'P' })).toBe(false)
  })

  it('rejects duplicate manager assignments', () => {
    expect(validOrderShortcuts(defaultOrderShortcuts)).toBe(true)
    expect(validOrderShortcuts({ ...defaultOrderShortcuts, reduce: 'Ctrl+D' })).toBe(false)
  })
})
