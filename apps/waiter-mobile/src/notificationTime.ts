// SQLite datetime('now') is UTC but omits its timezone marker.
export function notificationTime(value: string): number {
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  return Date.parse(normalized)
}

export function isFreshNotification(value: string, now = Date.now()): boolean {
  const age = now - notificationTime(value)
  return age >= 0 && age < 60_000
}
