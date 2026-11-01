import { fmtDur, fmtInt, fmtSecs, fmtTz, fmtWall } from './format'
import { timOf } from './gaps'
import { LINE_KINDS } from './linecache'
import type { LineKind } from './lines'

/** The `tim=` a line prints: calls, waits, XCTEND and PARSING IN CURSOR; undefined for the lines without one. */
export function lineTim(text: string, kind: LineKind): number | undefined {
  return timOf(text, kind === 'parsing-in-cursor' ? 'call' : kind)
}

/** What the gutter's time columns need of the trace: where its tims start and how they map to the wall clock. */
export interface TimeClock { wallOffsetUs: number; tzOffsetMin: number; span: { firstTim: number } }

/** A line's clock cell: `HH:MM:SS.mmm` in the trace's zone, or `+S.mmm s` from the first tim without a wall clock. */
export function clockCell(tim: number, c: TimeClock): { text: string; title: string } {
  if (c.wallOffsetUs) {
    const wall = tim + c.wallOffsetUs
    return { text: fmtWall(wall, c.tzOffsetMin), title: `${fmtWall(wall, c.tzOffsetMin, { date: true, micros: true })} ${fmtTz(c.tzOffsetMin)}` }
  }
  const off = tim - c.span.firstTim
  return { text: `+${fmtSecs(off)} s`, title: `${fmtInt(off)} µs from the start of the trace (it has no wall clock)` }
}

/** A signed time difference with a unit that fits it: `+412 µs`, `−1.83 ms`, `+1.752 s`. */
export function fmtDelta(us: number): string {
  return (us < 0 ? '−' : '+') + fmtDur(Math.abs(us))
}

/** The time cells of a row; the strings are empty for a line without a tim, `delta` is undefined when the column is off. */
export interface LineTime {
  clock?: string; clockTitle?: string
  delta?: string; deltaTitle?: string
  /** the line the deltas are measured from */
  anchor: boolean
}

/** The viewer's time columns: which are shown, and the cells of a line. */
export interface LineTimes {
  clock: boolean
  delta: boolean
  at(line: number, text: string, kind: number): LineTime
}

/** The deltas' reference: a line and its tim. */
export interface TimeAnchor { line: number; tim: number }

/** The time columns of the rows, or undefined when both are off; without an anchor the delta cells stay empty. */
export function lineTimesOf(c: TimeClock, show: { clock: boolean; delta: boolean }, anchor: TimeAnchor | null): LineTimes | undefined {
  if (!show.clock && !show.delta) return undefined
  return {
    clock: show.clock,
    delta: show.delta,
    at(line, text, kind) {
      const tim = lineTim(text, LINE_KINDS[kind] ?? 'unknown')
      const out: LineTime = { anchor: false }
      if (tim === undefined) return out
      if (show.clock) { const cell = clockCell(tim, c); out.clock = cell.text; out.clockTitle = cell.title }
      if (show.delta && anchor) {
        if (line === anchor.line) {
          out.anchor = true
          out.deltaTitle = 'the other rows show their time from this line (the selected line when it is in view, else the first line in view with a time)'
        } else {
          const us = tim - anchor.tim
          out.delta = fmtDelta(us)
          out.deltaTitle = `${us < 0 ? '−' : '+'}${fmtInt(Math.abs(us))} µs from line ${fmtInt(anchor.line)}`
        }
      }
      return out
    },
  }
}

/**
 * The deltas' anchor for a view of lines `top .. top+rows-1`: the selected line when it is in view and has a tim, else the first
 * line in view with a tim (among the loaded ones); null when none of them has one.
 */
export function anchorOf(cache: { line(n: number): { text: string; kind: number } | undefined }, top: number, rows: number, selected: number): TimeAnchor | null {
  const end = top + Math.max(1, Math.ceil(rows))
  const timAt = (n: number) => { const l = cache.line(n); return l ? lineTim(l.text, LINE_KINDS[l.kind] ?? 'unknown') : undefined }
  if (selected >= top && selected < end) {
    const tim = timAt(selected)
    if (tim !== undefined) return { line: selected, tim }
  }
  for (let n = Math.max(1, top); n < end; n++) {
    const tim = timAt(n)
    if (tim !== undefined) return { line: n, tim }
  }
  return null
}
