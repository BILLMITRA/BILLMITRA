import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

export const shortcutActions = [
  { id: 'done', label: 'Done · save bill', defaultKey: 'Ctrl+D' },
  { id: 'reduce', label: 'Reduce selected draft item', defaultKey: 'Ctrl+-' },
  { id: 'search', label: 'Search menu', defaultKey: 'Ctrl+K' },
  { id: 'discount', label: 'Choose discount', defaultKey: 'Ctrl+Shift+D' },
  { id: 'printBill', label: 'Print bill', defaultKey: 'P' },
  { id: 'recall', label: 'Recall bill', defaultKey: 'R' },
  { id: 'voidItem', label: 'Void saved item (manager PIN)', defaultKey: 'Ctrl+Shift+V' },
] as const

export type ShortcutAction = typeof shortcutActions[number]['id']
export type OrderShortcuts = Record<ShortcutAction, string>
export const defaultOrderShortcuts = Object.fromEntries(shortcutActions.map(action => [action.id, action.defaultKey])) as OrderShortcuts
const storageKey = 'billmitra.orderShortcuts.v1'

export function shortcutFromEvent(event: KeyboardEvent | ReactKeyboardEvent): string | null {
  if (event.altKey || event.metaKey || (event.shiftKey && !event.ctrlKey)) return null
  const key = event.key.toLowerCase()
  if (['control', 'shift', 'alt', 'meta'].includes(key)) return null
  const name = key === '-' || key === 'subtract' ? '-' : key === '+' || key === 'add' ? '+' : key.length === 1 && /[a-z0-9]/.test(key) ? key.toUpperCase() : null
  return name ? `${event.ctrlKey ? `Ctrl+${event.shiftKey ? 'Shift+' : ''}` : ''}${name}` : null
}

export function validOrderShortcuts(value: unknown): value is OrderShortcuts {
  if (!value || typeof value !== 'object') return false
  const keys = shortcutActions.map(action => (value as Record<string, unknown>)[action.id])
  return keys.every(key => typeof key === 'string' && /^(?:(?:Ctrl\+(?:Shift\+)?)?[A-Z0-9]|Ctrl\+(?:Shift\+)?[+-])$/.test(key))
    && new Set(keys).size === keys.length
}

export function loadOrderShortcuts(): OrderShortcuts {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (!saved || typeof saved !== 'object') return defaultOrderShortcuts
    const merged = { ...defaultOrderShortcuts, ...saved }
    if (merged.recall === 'Ctrl+Shift+R') merged.recall = 'R'
    return validOrderShortcuts(merged) ? merged : defaultOrderShortcuts
  } catch { return defaultOrderShortcuts }
}

export function saveOrderShortcuts(shortcuts: OrderShortcuts): void {
  if (!validOrderShortcuts(shortcuts)) throw new Error('Each action needs a different shortcut.')
  localStorage.setItem(storageKey, JSON.stringify(shortcuts))
}

