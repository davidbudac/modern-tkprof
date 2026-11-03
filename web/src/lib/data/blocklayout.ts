// The layout of the Blocks view (views/BlockMap.tsx), kept here so it is unit-tested without a DOM: the panels (one per file),
// the x axis (I/O order with short stretches widened, or time), the y axis (block number), the marks, the colours by event /
// object / statement, the statement brackets, the hit test, and `drawBlockMap`, which paints one panel on a 2-D context with
// colours the component has resolved from the tokens.
import type { Event, ID } from './types'
import { IO, extentsOf, runBlocks, sampleStep, type BlockRun, type IOMap, type IOMapFile } from './iomap'
import { niceStep } from './scale'
import { roleOfClass } from '../components/colors'

// ---- what a wait does -----------------------------------------------------------------

/** A temp segment's I/O (`direct path read temp`, `direct path write temp`): its obj# names the statement's object, not the blocks' owner. */
export const isTempEvent = (ev: Event | undefined): boolean => !!ev && /\btemp\b/i.test(ev.name)
/** The wait writes the blocks (`db file single write`, `direct path write[ temp]`); else it reads them. */
export const isWriteEvent = (ev: Event | undefined): boolean => !!ev && /\bwrites?\b/i.test(ev.name)

/** A colour: a CSS token and its shade (0 = the token, k = k steps towards the surface, `tokenShade`). */
export interface Tone { token: string; shade: number }

/**
 * The colour of each block I/O event in "event" mode: temp reads and writes their own hues (`--bm-temp-r`, `--bm-temp-w`), reads of
 * the User I/O class `--c-userio`, its writes `--bm-write` (darker), concurrency waits `--c-concurrency`, other classes their role;
 * several events on one token get successive shades, in event-id order.
 */
export function eventTones(events: readonly Event[], ids: readonly ID[]): Map<ID, Tone> {
  const out = new Map<ID, Tone>()
  const rank = new Map<string, number>()
  for (const id of [...ids].sort((a, b) => a - b)) {
    const ev = events[id]
    let token: string
    if (!ev) token = '--c-other'
    else if (isTempEvent(ev)) token = isWriteEvent(ev) ? '--bm-temp-w' : '--bm-temp-r'
    else {
      const role = roleOfClass(ev.class, ev.idle)
      token = role === 'userio' ? (isWriteEvent(ev) ? '--bm-write' : '--c-userio') : `--c-${role}`
    }
    const k = rank.get(token) ?? 0
    rank.set(token, k + 1)
    out.set(id, { token, shade: k })
  }
  return out
}

/** The categorical colours of the object and statement modes, in order; after them the same with a shade. */
export const CATEGORICAL = ['--c-cpu', '--c-network', '--c-userio', '--c-other', '--c-sysio', '--c-concurrency', '--c-commit'] as const
/** At most this many objects / statements get a colour of their own; the rest share `--c-idle`. */
export const MAX_CATEGORIES = 14
export const categoryTone = (k: number): Tone => (k < MAX_CATEGORIES ? { token: CATEGORICAL[k % CATEGORICAL.length], shade: Math.floor(k / CATEGORICAL.length) } : REST)
const REST: Tone = { token: '--c-idle', shade: 0 }

export type ColorBy = 'event' | 'object' | 'statement'

/** One entry of the legend: what a colour stands for, and how many of the rows have it. */
export interface LegendEntry {
  tone: Tone
  kind: 'event' | 'object' | 'statement' | 'rest' | 'none'
  /** the event id, obj#, statement id (-1 for `rest` / `none`) */
  key: number
  rows: number
}

export interface Coloring {
  /** the distinct colours, `idx` points into it */
  tones: Tone[]
  /** per row of the answer */
  idx: Uint16Array
  legend: LegendEntry[]
  /** the colour of each object with extents (its object-mode colour, used by the bands in every mode) */
  objectTone: Map<number, Tone>
}

/**
 * The colour of every row in a mode. Objects and statements are ranked by the blocks / rows they have (most first) and take the
 * categorical colours in that order; temp waits keep their event colour in object mode (their obj# does not own the temp blocks);
 * rows without an object are `--c-idle`.
 */
export function colorRows(map: Pick<IOMap, 'rows' | 'events'>, events: readonly Event[], by: ColorBy): Coloring {
  const rows = map.rows
  const tones: Tone[] = []
  const toneIdx = new Map<string, number>()
  const idxOf = (t: Tone) => {
    const k = `${t.token}:${t.shade}`
    let i = toneIdx.get(k)
    if (i === undefined) { i = tones.length; tones.push(t); toneIdx.set(k, i) }
    return i
  }
  const evTones = eventTones(events, map.events.length ? map.events : [...new Set(rows.map((r) => r[IO.event]))])
  // objects by blocks moved (non-temp rows): their colour, for the object mode and the extent bands
  const objBlocks = new Map<number, number>()
  for (const r of rows) if (r[IO.obj] >= 0 && !isTempEvent(events[r[IO.event]])) objBlocks.set(r[IO.obj], (objBlocks.get(r[IO.obj]) ?? 0) + r[IO.blocks])
  const objRank = [...objBlocks.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([o]) => o)
  const objectTone = new Map(objRank.slice(0, MAX_CATEGORIES).map((o, k) => [o, categoryTone(k)]))
  const idx = new Uint16Array(rows.length)
  const legend = new Map<string, LegendEntry>()
  const count = (key: string, e: Omit<LegendEntry, 'rows'>) => { const x = legend.get(key); if (x) x.rows++; else legend.set(key, { ...e, rows: 1 }) }
  const evTone = (ev: number) => evTones.get(ev) ?? { token: '--c-other', shade: 0 }
  if (by === 'event') {
    rows.forEach((r, i) => { const t = evTone(r[IO.event]); idx[i] = idxOf(t); count(`e${r[IO.event]}`, { tone: t, kind: 'event', key: r[IO.event] }) })
  } else if (by === 'object') {
    rows.forEach((r, i) => {
      const ev = r[IO.event], obj = r[IO.obj]
      if (isTempEvent(events[ev])) { const t = evTone(ev); idx[i] = idxOf(t); count(`e${ev}`, { tone: t, kind: 'event', key: ev }); return }
      if (obj < 0) { idx[i] = idxOf(REST); count('none', { tone: REST, kind: 'none', key: -1 }); return }
      const t = objectTone.get(obj)
      if (!t) { idx[i] = idxOf(REST); count('rest', { tone: REST, kind: 'rest', key: -1 }); return }
      idx[i] = idxOf(t); count(`o${obj}`, { tone: t, kind: 'object', key: obj })
    })
  } else {
    const n = new Map<number, number>()
    for (const r of rows) n.set(r[IO.stmt], (n.get(r[IO.stmt]) ?? 0) + 1)
    const rank = new Map([...n.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([s], k) => [s, k]))
    rows.forEach((r, i) => {
      const s = r[IO.stmt], k = rank.get(s)!
      if (s < 0 || k >= MAX_CATEGORIES) { idx[i] = idxOf(REST); count('rest', { tone: REST, kind: 'rest', key: -1 }); return }
      const t = categoryTone(k)
      idx[i] = idxOf(t); count(`s${s}`, { tone: t, kind: 'statement', key: s })
    })
  }
  // objects / statements first (most rows first), then events (in id order: temp waits in object mode), then no object, then the rest
  const kindOrder = { object: 0, statement: 0, event: 1, none: 2, rest: 3 }
  const list = [...legend.values()].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || (a.kind === 'event' ? a.key - b.key : b.rows - a.rows || a.key - b.key))
  return { tones, idx, legend: list, objectTone }
}

// ---- panels and the y axis --------------------------------------------------------------

export const PANEL_MIN = 60
export const PANEL_MAX = 320
/** A file with fewer waits than this gets the smallest panel, whatever its block range (three reads of exp_head$ need no 200 px). */
export const FEW_MARKS = 16

/** A panel's plot height in px: clamp(60, 320, 40 + 40·log10(1 + hi − lo)); 60 for a file of a few marks. */
export function panelHeight(f: Pick<IOMapFile, 'lo' | 'hi' | 'n'>): number {
  if (f.n < FEW_MARKS) return PANEL_MIN
  return Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, 40 + 40 * Math.log10(1 + Math.max(0, f.hi - f.lo)))))
}

export interface Panel extends IOMapFile {
  height: number
  /** every wait of the file is temp I/O: a tempfile */
  temp: boolean
  /** the indices of the answer's rows in this file, ascending */
  rows: Int32Array
}

/** One panel per file with waits, in file order. */
export function panelsOf(map: Pick<IOMap, 'rows' | 'files'>, events: readonly Event[]): Panel[] {
  const byFile = new Map<number, number[]>()
  map.rows.forEach((r, i) => { const l = byFile.get(r[IO.file]); if (l) l.push(i); else byFile.set(r[IO.file], [i]) })
  return map.files.filter((f) => f.n > 0).map((f) => {
    const idx = byFile.get(f.file) ?? []
    return { ...f, height: panelHeight(f), temp: idx.length > 0 && idx.every((i) => isTempEvent(events[map.rows[i][IO.event]])), rows: Int32Array.from(idx) }
  })
}

/** px kept free at the top and bottom of a panel, so the marks at the ends of its block range are not cut by the edge. */
export const PANEL_PAD = 4

/** y in px (0 = top) of a block address in a panel of `height`: the panel's `lo` at the bottom, `hi` at the top (`PANEL_PAD` inside). */
export function yOfBlock(p: Pick<IOMapFile, 'lo' | 'hi'>, height: number, block: number): number {
  const span = Math.max(1, p.hi - p.lo), inner = Math.max(1, height - 2 * PANEL_PAD)
  return height - PANEL_PAD - ((block - p.lo) / span) * inner
}

/** The block number at a y of the panel (inverse of `yOfBlock`). */
export function blockOfY(p: Pick<IOMapFile, 'lo' | 'hi'>, height: number, y: number): number {
  return p.lo + ((height - PANEL_PAD - y) / Math.max(1, height - 2 * PANEL_PAD)) * Math.max(1, p.hi - p.lo)
}

/** Round block numbers for the y axis of a panel: a 1-2-5 step giving about one tick per 36 px, inside [lo, hi]. */
export function blockTicks(p: Pick<IOMapFile, 'lo' | 'hi'>, height: number): { block: number; y: number }[] {
  const span = p.hi - p.lo
  if (span <= 0) return []
  const step = Math.max(1, niceStep(span, Math.max(2, Math.floor(height / 36))))
  const out: { block: number; y: number }[] = []
  for (let b = Math.ceil(p.lo / step) * step; b <= p.hi; b += step) out.push({ block: b, y: yOfBlock(p, height, b) })
  return out
}

// ---- the x axis ----------------------------------------------------------------------------

/** Rows `[i0, i1)` of the answer drawn on px `[x0, x1)`. */
export interface Segment { i0: number; i1: number; x0: number; x1: number }

export interface XScale {
  mode: 'order' | 'time'
  width: number
  /** rows of the answer */
  n: number
  /** order mode: the piecewise-linear map, consecutive, covering [0, n) and [0, width) */
  segs: Segment[]
  /** time mode: tim at x = 0 and x = width */
  t0: number
  t1: number
  /** order mode: the largest factor a stretch was widened by (1 = linear) */
  stretch: number
}

/** A stretch of rows the axis keeps readable: the statement (or phase) runs the brackets mark. */
export interface Run { i0: number; i1: number }

/** A short stretch is widened to at least this many px. */
export const MIN_STRETCH_PX = 64

/**
 * The order axis over `n` rows: linear, except that runs narrower than `minPx` are widened to `minPx` and the others share the
 * rest (repeated until stable), as the mock-up's broken axis did for the full scans before the sort spill. Linear when nothing is
 * short, when there is a single run, or when the short ones would need more than half of the width.
 */
export function orderScale(n: number, width: number, runs: readonly Run[] = [], minPx = MIN_STRETCH_PX): XScale {
  const linear: XScale = { mode: 'order', width, n, segs: n > 0 ? [{ i0: 0, i1: n, x0: 0, x1: width }] : [], t0: 0, t1: 0, stretch: 1 }
  if (n <= 0 || width <= 0 || runs.length < 2) return linear
  let small = new Set<number>()
  let pBig = width / n
  for (let iter = 0; iter < 16; iter++) {
    const next = new Set<number>()
    runs.forEach((r, k) => { if ((r.i1 - r.i0) * pBig < minPx) next.add(k) })
    if (next.size === 0) return linear
    const smallRows = runs.reduce((a, r, k) => a + (next.has(k) ? r.i1 - r.i0 : 0), 0)
    if (next.size * minPx > width / 2 || smallRows >= n) return linear
    pBig = (width - next.size * minPx) / (n - smallRows)
    const stable = next.size === small.size && [...next].every((k) => small.has(k))
    small = next
    if (stable) break
  }
  const segs: Segment[] = []
  let x = 0, stretch = 1
  runs.forEach((r, k) => {
    const w = small.has(k) ? minPx : (r.i1 - r.i0) * pBig
    if (small.has(k)) stretch = Math.max(stretch, minPx / ((r.i1 - r.i0) * (width / n)))
    const last = segs[segs.length - 1]
    // consecutive runs on the same scale are one segment (continuous ticks)
    if (last && !small.has(k) && !small.has(k - 1) && last.i1 === r.i0) { last.i1 = r.i1; last.x1 = x + w }
    else segs.push({ i0: r.i0, i1: r.i1, x0: x, x1: x + w })
    x += w
  })
  segs[segs.length - 1].x1 = width // rounding
  return { ...linear, segs, stretch }
}

/** The time axis: the rows' [tim - ela, tim] extremes over `width`. */
export function timeScale(rows: readonly number[][], width: number): XScale {
  let t0 = Infinity, t1 = -Infinity
  for (const r of rows) { t0 = Math.min(t0, r[IO.tim] - r[IO.ela]); t1 = Math.max(t1, r[IO.tim]) }
  if (!(t1 > t0)) { t0 = Number.isFinite(t0) ? t0 : 0; t1 = t0 + 1 }
  return { mode: 'time', width, n: rows.length, segs: [], t0, t1, stretch: 1 }
}

/** The segment of an order position (clamped). */
function segOf(xs: XScale, i: number): Segment {
  const s = xs.segs
  let lo = 0, hi = s.length - 1
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].i0 <= i) lo = m; else hi = m - 1 }
  return s[lo]
}

/** x in px of an order position (a row index, fractional allowed): the left edge of its slot. */
export function xOfIndex(xs: XScale, i: number): number {
  if (xs.segs.length === 0) return 0
  const s = segOf(xs, i)
  return s.x0 + ((i - s.i0) * (s.x1 - s.x0)) / Math.max(1, s.i1 - s.i0)
}

/** The order position at x px (inverse of `xOfIndex`), clamped to [0, n]. */
export function indexOfX(xs: XScale, x: number): number {
  const s = xs.segs
  if (s.length === 0) return 0
  let k = 0
  while (k < s.length - 1 && x >= s[k].x1) k++
  const g = s[k]
  const i = g.i0 + ((x - g.x0) * (g.i1 - g.i0)) / Math.max(1e-9, g.x1 - g.x0)
  return Math.max(0, Math.min(xs.n, i))
}

/** x in px of a tim (time mode). */
export const xOfTim = (xs: XScale, tim: number): number => ((tim - xs.t0) / (xs.t1 - xs.t0)) * xs.width
/** The tim at x px (time mode). */
export const timOfX = (xs: XScale, x: number): number => xs.t0 + (Math.max(0, Math.min(xs.width, x)) / xs.width) * (xs.t1 - xs.t0)

/** px per row in the segment of row `i` (order mode). */
const pxPerRow = (xs: XScale, i: number) => { const s = segOf(xs, i); return (s.x1 - s.x0) / Math.max(1, s.i1 - s.i0) }

/** A mark's width in px: 1, or 2 at ≤ 2,000 rows; up to 3 where a widened stretch has the room. */
export function markWidth(xs: XScale, i: number): number {
  const base = xs.n <= 2000 ? 2 : 1
  return xs.mode === 'order' ? Math.max(base, Math.min(3, Math.floor(pxPerRow(xs, i)))) : base
}

export interface Rect { x: number; y: number; w: number; h: number }

/** A panel of few marks (`n` < FEW_MARKS) draws them at least this tall (and 3 px wide), so three single-block reads in 14,000 blocks show. */
export const FEW_MARKS_PX = 5
/** Below this many marks a panel draws them at least 2 px tall. */
export const SPARSE_MARKS = 500

/**
 * The mark of row `i` in its panel: as tall as the blocks it moved (at least 1 px; 2 px in a sparse panel, `FEW_MARKS_PX` in a
 * panel of few marks; centred), at its order slot or its time interval.
 */
export function markRect(xs: XScale, rows: readonly number[][], i: number, p: Pick<IOMapFile, 'lo' | 'hi'> & { n?: number }, height: number): Rect {
  const r = rows[i]
  const yTop = yOfBlock(p, height, r[IO.block] + r[IO.blocks]), yBot = yOfBlock(p, height, r[IO.block])
  const minH = p.n === undefined ? 1 : p.n < FEW_MARKS ? FEW_MARKS_PX : p.n < SPARSE_MARKS ? 2 : 1
  let y = yTop, h = yBot - yTop
  if (h < minH) { y = (yTop + yBot) / 2 - minH / 2; h = minH }
  let x: number, w: number
  const minW = minH > 1 ? 3 : 0 // and as wide
  if (xs.mode === 'order') { // centred in its slot (a slot is narrower than a pixel when the rows are dense)
    w = Math.max(minW, markWidth(xs, i))
    const x0 = xOfIndex(xs, i), slot = xOfIndex(xs, i + 1) - x0
    x = Math.floor(x0 + Math.max(0, (slot - w) / 2))
  }
  else { const a = xOfTim(xs, r[IO.tim] - r[IO.ela]), b = xOfTim(xs, r[IO.tim]); w = Math.max(minW, markWidth(xs, i), b - a); x = Math.floor(a) }
  return { x, y, w, h }
}

/** Ticks of the x axis: order positions labelled with the wait's place among all matches (× the sampling step), or tims. */
export function xTicks(xs: XScale, map: Pick<IOMap, 'total' | 'rows'>, opts: { base?: number; minGapPx?: number } = {}): { x: number; value: number }[] {
  const gap = opts.minGapPx ?? 90
  const out: { x: number; value: number }[] = []
  if (xs.mode === 'time') {
    const base = opts.base ?? 0, span = xs.t1 - xs.t0
    const step = niceStep(span, Math.max(2, Math.floor(xs.width / gap)))
    for (let t = Math.ceil((xs.t0 - base) / step) * step; base + t <= xs.t1; t += step) out.push({ x: xOfTim(xs, base + t), value: t })
    return out
  }
  const k = sampleStep(map)
  for (const s of xs.segs) {
    const count = (s.i1 - s.i0) * k, w = s.x1 - s.x0
    const step = Math.max(1, niceStep(count, Math.max(1, Math.floor(w / gap)))) // whole waits
    for (let v = Math.ceil((s.i0 * k) / step) * step; v < s.i1 * k; v += step) {
      const x = xOfIndex(xs, v / k)
      if (out.length && x - out[out.length - 1].x < gap * 0.6) continue // the first tick of a widened stretch next to the previous one
      out.push({ x, value: v })
    }
  }
  return out
}

// ---- brackets: the statements' (or phases') stretches over the order ------------------------

export interface Bracket extends Run {
  kind: 'stmt' | 'phase'
  /** statement id, or the phase's label */
  key: number | string
  /** rows of the answer per event in the stretch (for a statement run: its own rows, not the recursive ones inside it) */
  byEvent: Map<ID, number>
}

/** At most this many statement stretches get brackets; with more the phases (contexts' actions) do. */
export const MAX_STMT_BRACKETS = 12
export const MAX_PHASE_BRACKETS = 40

/**
 * The maximal runs of rows of one statement in order. A wait of a deeper (recursive) statement in the same session context belongs
 * to the run it sits in (the QOSD lookup of exp_head$ between two scans breaks nothing), and a run of such waits right before a
 * shallower statement of the same context to that statement's run (recursive SQL of its parse); otherwise a wait at the same or a
 * shallower depth, or of another context, starts a run of its own.
 */
export function stmtRuns(rows: readonly number[][]): Bracket[] {
  const out: (Bracket & { dep: number; ctx: number })[] = []
  rows.forEach((r, i) => {
    const last = out[out.length - 1]
    if (last && (last.key === r[IO.stmt] || (r[IO.dep] > last.dep && r[IO.ctx] === last.ctx))) {
      last.i1 = i + 1
      if (last.key === r[IO.stmt]) last.byEvent.set(r[IO.event], (last.byEvent.get(r[IO.event]) ?? 0) + 1)
      return
    }
    out.push({ kind: 'stmt', key: r[IO.stmt], i0: i, i1: i + 1, byEvent: new Map([[r[IO.event], 1]]), dep: r[IO.dep], ctx: r[IO.ctx] })
  })
  for (let k = out.length - 2; k >= 0; k--) {
    const a = out[k], b = out[k + 1]
    if (a.dep > b.dep && a.ctx === b.ctx) { b.i0 = a.i0; out.splice(k, 1) } // recursive waits before their statement
  }
  return out.map(({ dep: _dep, ctx: _ctx, ...b }) => b)
}

/**
 * The maximal runs of rows whose context has one phase label (`labelOf(ctx)`, e.g. the context's action; '' = none, joins the run
 * before; leading unnamed rows are a run with key ''). Like `stmtRuns` the runs cover the rows without gaps.
 */
export function phaseRuns(rows: readonly number[][], labelOf: (ctx: number) => string): Bracket[] {
  const out: Bracket[] = []
  rows.forEach((r, i) => {
    const l = labelOf(r[IO.ctx])
    const last = out[out.length - 1]
    if (last && (last.key === l || l === '')) { last.i1 = i + 1; last.byEvent.set(r[IO.event], (last.byEvent.get(r[IO.event]) ?? 0) + 1); return }
    out.push({ kind: 'phase', key: l, i0: i, i1: i + 1, byEvent: new Map([[r[IO.event], 1]]) })
  })
  return out
}

/**
 * The bracket rows over the x axis: the statements' runs when there are at most 12 (with the phases above them when those are
 * few and named), else the phases when there are at most 40, else none. `runs` is what the order axis keeps readable.
 */
export function bracketsOf(rows: readonly number[][], labelOf: (ctx: number) => string): { stmts: Bracket[]; phases: Bracket[]; runs: Run[] } {
  const stmts = stmtRuns(rows)
  const phases = phaseRuns(rows, labelOf)
  const named = phases.some((p) => p.key !== '')
  if (stmts.length <= MAX_STMT_BRACKETS) return { stmts, phases: named && phases.length <= MAX_STMT_BRACKETS ? phases : [], runs: stmts }
  if (named && phases.length <= MAX_PHASE_BRACKETS) return { stmts: [], phases, runs: phases }
  return { stmts: [], phases: [], runs: [] }
}

/**
 * Rows for the bracket labels so they do not overlap: each label goes on the first of `maxRows` rows whose previous label ends
 * left of it (labels are left-aligned at the bracket's start, `widthOf` px wide); -1 = no room (the bracket keeps its title).
 */
export function labelRows(spans: readonly { x0: number; x1: number; width: number }[], maxRows = 3, pad = 8): number[] {
  const ends: number[] = []
  return spans.map((s) => {
    for (let k = 0; k < maxRows; k++) {
      if (ends[k] === undefined || ends[k] + pad <= s.x0) { ends[k] = s.x0 + s.width; return k }
    }
    return -1
  })
}

// ---- hit test ---------------------------------------------------------------------------------------

/**
 * The row under (x, y) in a panel: among the panel's rows whose mark is within `slop` px horizontally, the one whose block range
 * holds y, else the nearest vertically (within `slop` px too); the later row on a tie (it is drawn on top). -1 when none.
 */
export function hitTest(xs: XScale, rows: readonly number[][], panel: Panel, x: number, y: number, slop = 3): number {
  let best = -1, bestD = Infinity
  const consider = (i: number) => {
    const m = markRect(xs, rows, i, panel, panel.height)
    if (x < m.x - slop || x > m.x + m.w + slop) return
    const d = y < m.y ? m.y - y : y > m.y + m.h ? y - (m.y + m.h) : 0
    if (d <= slop && d <= bestD) { best = i; bestD = d }
  }
  if (xs.mode === 'order') {
    const a = Math.floor(indexOfX(xs, x - slop - 3)), b = Math.ceil(indexOfX(xs, x + slop))
    const pr = panel.rows
    let lo = 0, hi = pr.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (pr[m] < a) lo = m + 1; else hi = m }
    for (let k = lo; k < pr.length && pr[k] <= b; k++) consider(pr[k])
  } else {
    for (const i of panel.rows) consider(i)
  }
  return best
}

// ---- drawing ------------------------------------------------------------------------------------

/** The part of a 2-D context `drawBlockMap` uses (a canvas's, or a recording fake in the tests). */
export interface Paint { fillStyle: unknown; globalAlpha: number; fillRect(x: number, y: number, w: number, h: number): void }

export interface PanelColors {
  /** the resolved colour of each `Coloring.tones` entry */
  tones: string[]
  grid: string
  /** extent bands: block runs and their resolved colour */
  bands: { runs: BlockRun[]; color: string }[]
}

/** Alpha of the extent bands; the ruler left of the plot is solid. */
export const BAND_ALPHA = 0.13
export const RULER_PX = 5
/** The ruler sits at x in [-RULER_X, -RULER_X + RULER_PX): the canvas is RULER_X wider than the plot and translated by it. */
export const RULER_X = 8

/**
 * Paints one panel (`width` × `panel.height` px from x = 0; the ruler at negative x, see `RULER_X`): the y grid, the faint extent
 * bands with their solid ruler, the stretch boundaries, then the marks grouped by colour (one fillStyle per colour). Returns the
 * number of marks painted.
 */
export function drawBlockMap(ctx: Paint, panel: Panel, rows: readonly number[][], xs: XScale, idx: Uint16Array, colors: PanelColors): number {
  const h = panel.height, w = xs.width
  ctx.globalAlpha = 1
  ctx.fillStyle = colors.grid
  for (const t of blockTicks(panel, h)) ctx.fillRect(0, Math.round(t.y), w, 1)
  if (xs.mode === 'order') for (const s of xs.segs.slice(1)) ctx.fillRect(Math.round(s.x0) - 1, 0, 1, h)
  for (const b of colors.bands) {
    ctx.fillStyle = b.color
    for (const r of b.runs) {
      const y0 = yOfBlock(panel, h, r.hi), y1 = yOfBlock(panel, h, r.lo)
      const bh = Math.max(1, y1 - y0)
      ctx.globalAlpha = BAND_ALPHA
      ctx.fillRect(0, y0, w, bh)
      ctx.globalAlpha = 0.9
      ctx.fillRect(-RULER_X, y0, RULER_PX, bh)
    }
  }
  ctx.globalAlpha = 1
  const byTone: number[][] = colors.tones.map(() => [])
  for (const i of panel.rows) byTone[idx[i]]?.push(i)
  let n = 0
  byTone.forEach((list, t) => {
    if (list.length === 0) return
    ctx.fillStyle = colors.tones[t]
    for (const i of list) {
      const m = markRect(xs, rows, i, panel, h)
      ctx.fillRect(m.x, m.y, m.w, m.h)
      n++
    }
  })
  return n
}

/** The extent bands of a panel: each coloured object's block runs in the panel's file, from its non-temp rows. */
export function bandsOf(map: Pick<IOMap, 'rows'>, events: readonly Event[], panel: Pick<Panel, 'file' | 'temp'>, objectTone: Map<number, Tone>): { obj: number; runs: BlockRun[]; blocks: number; tone: Tone }[] {
  if (panel.temp) return []
  const out: { obj: number; runs: BlockRun[]; blocks: number; tone: Tone }[] = []
  for (const [obj, tone] of objectTone) {
    const runs = extentsOf(map.rows, obj, panel.file, (r) => !isTempEvent(events[r[IO.event]]))
    if (runs.length) out.push({ obj, runs, blocks: runBlocks(runs), tone })
  }
  return out
}
