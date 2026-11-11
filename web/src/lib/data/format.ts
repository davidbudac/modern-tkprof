// Formatting helpers. Times are microseconds unless stated.

const intFmt = new Intl.NumberFormat('en-US')
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export function fmtInt(n: number): string { return intFmt.format(Math.round(n)) }
export function fmtCompact(n: number): string { return Math.abs(n) < 10000 ? intFmt.format(Math.round(n)) : compactFmt.format(n) }

/** Seconds with a sensible precision: 0.000123 → "0.12 ms", 1.5 → "1.500 s". */
export function fmtDur(us: number): string {
  const a = Math.abs(us)
  if (a < 1000) return `${Math.round(us)} µs`
  if (a < 1_000_000) return `${(us / 1000).toFixed(a < 10_000 ? 2 : a < 100_000 ? 1 : 0)} ms`
  if (a < 60_000_000) return `${(us / 1e6).toFixed(a < 10_000_000 ? 3 : 2)} s`
  if (a < 3_600_000_000) return `${(us / 60e6).toFixed(1)} min`
  return `${(us / 3600e6).toFixed(2)} h`
}

/** Fixed seconds, for columns that must align. */
export function fmtSecs(us: number, digits = 3): string { return (us / 1e6).toFixed(digits) }
export function fmtMs(us: number, digits = 2): string { return (us / 1e3).toFixed(digits) }

export function fmtPct(part: number, total: number, digits = 1): string {
  if (!total) return '–'
  return `${((100 * part) / total).toFixed(digits)}%`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

function pad(n: number, w = 2): string { return String(n).padStart(w, '0') }

/** Wall clock in the trace file's own zone. */
export function fmtWall(wallUs: number, tzOffsetMin: number, opts: { date?: boolean; micros?: boolean } = {}): string {
  if (!wallUs) return '–'
  const ms = Math.floor(wallUs / 1000)
  const d = new Date(ms + tzOffsetMin * 60000)
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
  const micros = opts.micros ? pad(Math.floor(wallUs % 1000), 3) : ''
  const date = opts.date ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` : ''
  return `${date}${time}${micros}`
}

export function fmtTz(tzOffsetMin: number): string {
  const sign = tzOffsetMin < 0 ? '-' : '+'
  const a = Math.abs(tzOffsetMin)
  return `UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

/** One-line preview of SQL text. */
export function preview(text: string, max = 120): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function oraErr(code: number): string { return `ORA-${String(code).padStart(5, '0')}` }

const htmlEsc: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
/** A value as text inside an HTML string (an ECharts tooltip formatter's result is set as innerHTML): a name read from a trace is data, never markup. */
export function escHtml(v: unknown): string { return String(v ?? '').replace(/[&<>"']/g, (c) => htmlEsc[c]) }
