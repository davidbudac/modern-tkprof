/** "just now", "12 min ago", "3 h ago", "2 d ago" for an ISO time; '' when it does not parse. */
export const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (!Number.isFinite(s)) return ''
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

/** "42 s", "7 min", "3 h 5 min" for an uptime in seconds. */
export function fmtUptime(s: number): string {
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}
