// SQLite datetime('now') is UTC even though its text has no timezone suffix.
export function orderTimer(startedAt: string | null | undefined, now: number) {
  const value = startedAt?.trim() ?? ''
  const normalized = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value
  const start = Date.parse(normalized)
  if (!Number.isFinite(start)) return { label: 'Time unavailable', overdue: false }
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  return { label: `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`, overdue: now - start >= 3600000 }
}
