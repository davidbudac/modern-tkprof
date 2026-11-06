// The formatted view's overview bar ("Where the time went"): its key chips, its time axis and the bracket of the rows in view.
import { LINE_KINDS } from './linecache'
import { lineTim } from './linetime'
import { fmtWall } from './format'

/** A statement's chip: its id and the time it took. */
export interface ChipStmt { id: number; e: number }

/** Statements that took less than this share of the span fold into one `+n under 1 %` chip. */
export const UNDER_SHARE = 0.01

/**
 * The key's chips: the statements of 1 % of the span or more, in the order given, and the rest folded (`folded`, shown on a click of the `+n under 1 %`
 * chip). `keep`: the highlighted statement stays a chip of its own whatever its share, so the outlined chip that carries the count and the × is always there.
 */
export function splitChips<T extends ChipStmt>(stmts: readonly T[], span: number, keep: number | null = null): { shown: T[]; folded: T[] } {
  const shown: T[] = [], folded: T[] = []
  for (const s of stmts) (span > 0 && s.e / span < UNDER_SHARE && s.id !== keep ? folded : shown).push(s)
  return { shown, folded }
}

/** A statement's share of the span, a whole percent as the chips say it (`38 %`); a share under 1 % reads `< 1 %`. */
export function shareText(e: number, span: number): string {
  if (span <= 0) return '–'
  const p = (100 * e) / span
  return p > 0 && p < 1 ? '< 1 %' : `${Math.round(p)} %`
}

/** A time axis tick: where it falls on the bar (0..1) and its label. */
export interface Tick { f: number; label: string }

/** The steps a tick may be apart, µs: from 1 ms, then 2, 5, 10, … up to hours. */
const STEPS = [1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7, 15e6, 3e7, 6e7, 12e7, 3e8, 6e8, 9e8, 18e8, 36e8, 72e8, 144e8, 432e8]

/**
 * The ticks of the bar's time axis over `[from, to]` (tim, µs): about 5 to 8 of them, on round times of the wall clock when the trace has one
 * (`HH:MM:SS`, with milliseconds under a second apart), else on round offsets from the start (`+2 s`). The first and last may fall just inside the ends.
 */
export function axisTicks(from: number, to: number, clock: { wallOffsetUs: number; tzOffsetMin: number } | null, max = 8): Tick[] {
  const span = to - from
  if (!(span > 0)) return []
  const step = STEPS.find((s) => span / s <= max) ?? STEPS[STEPS.length - 1]
  const wall = !!clock && clock.wallOffsetUs !== 0
  // the clock of the zone the trace was written in: round times are multiples of the step on that clock
  const shift = wall ? clock!.wallOffsetUs + clock!.tzOffsetMin * 60e6 : -from
  const out: Tick[] = []
  for (let t = Math.ceil((from + shift) / step) * step - shift; t <= to; t += step) {
    const f = (t - from) / span
    if (f < 0 || f > 1) continue
    out.push({ f, label: wall ? tickWall(t + clock!.wallOffsetUs, clock!.tzOffsetMin, step) : tickOffset(t - from, step) })
  }
  return out
}

const tickWall = (wallUs: number, tz: number, step: number) => {
  const t = fmtWall(wallUs, tz) // HH:MM:SS.mmm
  return step >= 1e6 ? t.slice(0, 8) : t
}
const tickOffset = (us: number, step: number) => (us === 0 ? '0' : step >= 1e6 ? `+${us / 1e6} s` : `+${us / 1e3} ms`)

/**
 * The times of the rows in view `top .. top+rows-1` (1-based lines): the tim of the first line with one and of the last line with one, among the
 * loaded lines; null when none of them has a tim.
 */
export function viewSpan(cache: { line(n: number): { text: string; kind: number } | undefined }, top: number, rows: number): [number, number] | null {
  const end = top + Math.max(1, Math.ceil(rows)) - 1
  const timAt = (n: number) => { const l = cache.line(n); return l ? lineTim(l.text, LINE_KINDS[l.kind] ?? 'unknown') : undefined }
  let a: number | undefined, b: number | undefined
  for (let n = Math.max(1, top); n <= end && a === undefined; n++) a = timAt(n)
  for (let n = end; n >= Math.max(1, top) && b === undefined; n--) b = timAt(n)
  return a === undefined || b === undefined ? null : [Math.min(a, b), Math.max(a, b)]
}

/** The bracket's place on the bar: its start and width as fractions of the span, clamped to the bar; null when it lies outside. */
export function bracketAt(view: readonly [number, number] | null, from: number, to: number): { left: number; width: number } | null {
  if (!view || !(to > from)) return null
  const span = to - from
  const a = Math.max(0, (view[0] - from) / span), b = Math.min(1, (view[1] - from) / span)
  return b < a ? null : { left: a, width: b - a }
}
