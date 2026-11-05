export const cardActions = [
  { id: 'parcel', label: 'First available parcel card', defaultKey: 'Shift+P' },
  { id: 'delivery', label: 'First available delivery card', defaultKey: 'Shift+H' },
  { id: 'ground', label: 'First available ground-floor table', defaultKey: 'Shift+G' },
  { id: 'first', label: 'First available first-floor table', defaultKey: 'Shift+F' },
] as const

export type CardAction = typeof cardActions[number]['id']
export type CardShortcuts = Record<CardAction, string>
export const defaultCardShortcuts = Object.fromEntries(cardActions.map(action => [action.id, action.defaultKey])) as CardShortcuts
const storageKey = 'billmitra.cardShortcuts.v1'

export function cardShortcutFromEvent(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): string | null {
  if (event.metaKey || (!event.shiftKey && !event.ctrlKey && !event.altKey)) return null
  const key = event.key.toUpperCase()
  if (!/^[A-Z]$/.test(key)) return null
  return `${event.ctrlKey ? 'Ctrl+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${key}`
}

export function validCardShortcuts(value: unknown): value is CardShortcuts {
  if (!value || typeof value !== 'object') return false
  const keys = cardActions.map(action => (value as Record<string, unknown>)[action.id])
  return keys.every(key => typeof key === 'string' && /^(?=.+\+)(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?[A-Z]$/.test(key)) && new Set(keys).size === keys.length
}

export function loadCardShortcuts(): CardShortcuts {
  try { const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); return validCardShortcuts(saved) ? saved : defaultCardShortcuts }
  catch { return defaultCardShortcuts }
}

export function saveCardShortcuts(value: CardShortcuts): void {
  if (!validCardShortcuts(value)) throw new Error('Choose a different shortcut for each card.')
  localStorage.setItem(storageKey, JSON.stringify(value))
}
