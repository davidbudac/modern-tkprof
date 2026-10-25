// Formatting for comparisons: signed deltas and their direction.
import { fmtDur, fmtInt } from './format'

/** "+1.20 s" / "−35 ms" / "0" (time deltas, microseconds). */
export function fmtDurDelta(us: number): string {
  if (us === 0) return '0'
  return (us > 0 ? '+' : '−') + fmtDur(Math.abs(us))
}

export function fmtIntDelta(n: number): string {
  if (n === 0) return '0'
  return (n > 0 ? '+' : '−') + fmtInt(Math.abs(n))
}

/** Relative change in percent; "new" when there is no base, "–" when both are 0. */
export function fmtPctDelta(a: number, b: number): string {
  if (a === 0) return b === 0 ? '–' : 'new'
  const p = (100 * (b - a)) / a
  if (p === 0) return '0%'
  const abs = Math.abs(p)
  return (p > 0 ? '+' : '−') + (abs >= 1000 ? fmtInt(abs) : abs.toFixed(abs < 10 || (abs >= 99 && abs < 100) ? 1 : 0)) + '%'
}

/** CSS class of a delta where larger is worse (time, I/O): 'up' (worse), 'down' (better) or ''. */
export function worse(delta: number): string {
  return delta > 0 ? 'up' : delta < 0 ? 'down' : ''
}
