// ---- formatting helpers: the app's own (web/src/lib/data/format.ts, linetime.ts), so NOW prints what the app prints ----------
const intFmt = new Intl.NumberFormat('en-US')
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const fmtInt = (n) => intFmt.format(Math.round(n))
const fmtCompact = (n) => (Math.abs(n) < 10000 ? intFmt.format(Math.round(n)) : compactFmt.format(n))

/** A duration, 3 significant digits as the app: 9 µs, 1.49 ms, 637 ms, 2.448 s. */
function fmtDur(us) {
  const a = Math.abs(us)
  if (a < 1000) return `${Math.round(us)} µs`
  if (a < 1e6) return `${(us / 1000).toFixed(a < 10000 ? 2 : a < 100000 ? 1 : 0)} ms`
  if (a < 60e6) return `${(us / 1e6).toFixed(a < 10e6 ? 3 : 2)} s`
  if (a < 3600e6) return `${(us / 60e6).toFixed(1)} min`
  return `${(us / 3600e6).toFixed(2)} h`
}
/** [number, unit] of fmtDur. */
function durParts(us) { const s = fmtDur(us); const i = s.lastIndexOf(' '); return [s.slice(0, i), s.slice(i + 1)] }
/** A signed time difference: +412 µs, −1.83 ms. */
const fmtDelta = (us) => (us < 0 ? '−' : '+') + fmtDur(Math.abs(us))
const fmtPct0 = (part, total) => `${((100 * part) / total).toFixed(0)}%`

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** The magnitude class of a duration: µs, ms, s (section 3's ramp). */
const magOf = (us) => (us < 1000 ? 'us' : us < 1e6 ? 'ms' : 's')

/** µs of the day of 'HH:MM:SS.uuuuuu'. */
const clockToUs = (c) => { const m = /^(\d+):(\d+):(\d+)\.(\d+)$/.exec(c); return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1e6 + +m[4].padEnd(6, '0') }
/** 'HH:MM:SS.uuuuuu' of µs of the day. */
const usToClock = (us) => { const s = Math.floor(us / 1e6); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.round(us % 1e6)).padStart(6, '0')}` }
