// The rows of the Lines view's readable mode: each cached line described (data/readable.ts) and given its lane (the cursor it belongs
// to, in its statement's colour), its time from the pin or from the line before, its clock time and whether it is a hot spot.
import type { Tone } from '../data/blocklayout'
import { roleOfClass } from '../components/colors'
import type { TraceDoc } from '../data/doc'
import { fmtDur, fmtInt, preview } from '../data/format'
import { LINE_KINDS, type CachedLine } from '../data/linecache'
import type { BindAt } from '../data/bindat'
import { barFrac, clockCell, fmtDelta, gapDelta, lineTim, unexplainedGap } from '../data/linetime'
import { durOf } from '../data/gaps'
import type { LineKind } from '../data/lines'
import { QUIET_TONE, describeLine, describeMarker, planDump, toneColor, type LineView, type PlanCell, type ReadableContext } from '../data/readable'
import { laneColorOf, type LaneColor } from '../data/lanecolor'

/** A cursor's stretch of consecutive lines, drawn as a band (in the statement's colour, or what the view colours by); its first rows carry the sql_id and the SQL. */
export interface Lane {
  /** the band's colour (a CSS colour), undefined for no band */
  color?: string
  /** the statement's colour, the label's (whatever the band shows); '' for none */
  ink: string
  /** the first row of the stretch shows `label`, the second `sub` */
  label?: string
  sub?: string
  /** the cursor number and the statement (the tooltip: the real cursor# is only shown here) */
  title: string
  /** the recursive depth of the cursor: its text is indented by it and the first row shows it as ↳n (the band stays in one column) */
  depth: number
  /** the statement id (a click on the label opens it) */
  stmt: number
}

/** Everything a readable row shows. */
export interface ReadableCell extends LineView {
  lane: Lane | null
  /** the line took 1 % of the traced time or more */
  hot: boolean
  /** the Duration cell's track: the line's own time as a fraction of it (log scale, 1 µs to 10 s: `barFrac`), and a call's CPU part */
  trackW?: number
  trackCpuW?: number
  /**
   * The Δ: with a pin, the time from the pin; else the unexplained gap before the line (where it started minus where the line with a time before
   * it ended, never negative), blank under 50 µs. '' for a line without a time or without a gap; `pinned` on the pin itself.
   */
  delta: string; deltaTitle?: string; pinned: boolean
  /** the Δ is measured from the pin (else it is a gap) */
  fromPin: boolean
  /** the Δ's size in µs (for the weight of its number), undefined with no Δ */
  deltaUs?: number
  /** an unexplained gap worth a look: at least 1 ms and twice the line before's duration */
  deltaEmph: boolean
  /** HH:MM:SS.mmm and the µs after it; '' for none */
  clock: string; micros: string; clockTitle?: string
  /**
   * The row shows its clock in full: it is the first with a clock or HH:MM:SS differs from the row with a clock before it (the viewer
   * also gives the full form to the first row in view and the selected one); a clock without HH:MM:SS (no wall clock) is always full.
   * Otherwise the row shows `clockShort`: the changing digits (`.828158`).
   */
  clockFull: boolean; clockShort: string
}

/** The Δ column's reference: the pinned line and its tim. */
export interface Pin { line: number; tim: number }

/** What the rows are built from. */
export interface ReadableInputs {
  doc: TraceDoc
  line(n: number): CachedLine | undefined
  tones: ReadonlyMap<number, Tone>
  pin: Pin | null
  /** line → µs of the hot spots */
  hot: ReadonlyMap<number, number>
  /** µs of a hot spot: 1 % of the traced time (a call or wait of it, a plan operation's own time); undefined: no plan cell is hot */
  hotUs?: number
  bindAt?(line: number): BindAt | undefined
  /** a BINDS header in view whose values are not known yet: the owner asks for them (and rebuilds the rows when they come) */
  missingBinds?(line: number): void
  /** what the lane band shows (default: the statement's colour) */
  colorBy?: LaneColor
  /** every row of a lane carries its label (the rows around it are filtered out, so no row reads as a lane's first) */
  labelAll?: boolean
}

/** Lines without a cursor of their own: they join the lane around them when the lines before and after belong to the same cursor. */
const FRAMING = new Set<LineKind>(['blank', 'separator', 'header', 'marker', 'unknown'])
/** How far a framing line looks for its neighbours, and a line for the previous time. */
const LOOK = 40
const BACK = 400

/** `HH:MM:SS` of a clock text; '' when it has none (a trace without a wall clock reads `+1.752 s`). */
const hmsOf = (clock: string) => (/^\d\d:\d\d:\d\d\./.test(clock) ? clock.slice(0, 8) : '')

export function readableRowsOf(inp: ReadableInputs): (line: number, l: CachedLine) => ReadableCell {
  const { doc, line: lineAt } = inp
  const kindOf = (l: CachedLine) => LINE_KINDS[l.kind] ?? 'unknown'
  // memo per line: the function is rebuilt whenever an input changes, and a scroll asks for the same lines again
  const laneMemo = new Map<number, number>()
  const plans = new Map<number, PlanCell>()
  const out = new Map<number, ReadableCell>()

  /** The cursor whose lane line n is in, -1 for none. */
  const laneKey = (n: number): number => {
    const m = laneMemo.get(n)
    if (m !== undefined) return m
    const l = lineAt(n)
    let k = -1
    if (l) {
      if (!FRAMING.has(kindOf(l))) k = l.cursor
      else {
        const near = (dir: 1 | -1) => {
          for (let i = 1, x = n + dir; i <= LOOK; i++, x += dir) {
            const o = lineAt(x)
            if (!o) return -2
            if (!FRAMING.has(kindOf(o))) return o.cursor
          }
          return -2
        }
        const a = near(-1)
        k = a >= 0 && a === near(1) ? a : -1
      }
    }
    laneMemo.set(n, k)
    return k
  }

  const events = new Map(doc.events.map((e) => [e.name, e]))
  const objects = new Map<number, string>()
  for (const p of doc.planLines) if (p.obj > 0 && p.object) objects.set(p.obj, p.object)
  const ctx: ReadableContext = {
    eventOf: (name) => { const e = events.get(name); return e ? { class: e.class, idle: e.idle, role: roleOfClass(e.class, e.idle) } : undefined },
    objectName: (obj) => doc.objectName(obj) ?? objects.get(obj),
    userName: (uid) => doc.userName(uid),
    bindsAt: (n) => {
      const b = inp.bindAt?.(n)
      if (!b) return undefined
      return { binds: b.binds, pos: b.pos, header: b.header, bind: b.bind, dty: b.dty, sql: doc.statements[b.stmt]?.text }
    },
    planAt: (n) => {
      if (!plans.has(n)) for (const [k, v] of planDump((x) => { const o = lineAt(x); return o && { text: o.text, kind: kindOf(o) } }, n)) plans.set(k, v)
      return plans.get(n)
    },
  }

  /** The line with a time before n: its number, tim and own time (its `e=` or `ela=`, 0 for a line that has none). */
  const prevTim = (n: number): { line: number; tim: number; dur: number } | null => {
    for (let x = n - 1, i = 0; x >= 1 && i < BACK; x--, i++) {
      const l = lineAt(x)
      const t = l ? lineTim(l.text, kindOf(l)) : undefined
      if (l && t !== undefined) return { line: x, tim: t, dur: durOf(l.text, kindOf(l)) }
    }
    return null
  }

  /** The HH:MM:SS of the clock of the row before n that has one (a line with a time, or a `***` line that prints its own), '' for none. */
  const prevHms = (n: number): string => {
    for (let x = n - 1, i = 0; x >= 1 && i < BACK; x--, i++) {
      const l = lineAt(x)
      if (!l) continue
      const k = kindOf(l), t = lineTim(l.text, k)
      if (t !== undefined) return doc.wallOffsetUs ? hmsOf(clockCell(t, doc).text) : ''
      if (k === 'marker') { const w = describeMarker(l.text).wall; if (w) return hmsOf(w.clock) }
    }
    return ''
  }

  const colorBy = inp.colorBy ?? 'stmt'
  const laneOf = (n: number, l: CachedLine, v: LineView, delta: number | undefined): Lane | null => {
    const key = laneKey(n)
    const cur = key >= 0 ? doc.cursors[key] : undefined
    const stmt = cur ? doc.statements[cur.statement] : undefined
    const sid = stmt?.id ?? (l.stmt >= 0 ? l.stmt : -1)
    const st = sid >= 0 ? doc.statements[sid] : undefined
    const ink = key >= 0 ? toneColor((st && inp.tones.get(st.id)) || QUIET_TONE) : ''
    const color = colorBy === 'stmt' ? (ink || undefined) : laneColorOf(colorBy, {
      stmt: ink, kind: kindOf(l), label: v.label, execNo: l.execNo, ctx: cur?.context ?? -1, depth: cur?.depth ?? 0,
      role: v.bar?.role, dur: v.dur, delta,
    })
    // a line outside a lane (a WAIT #0, a commit) still shows a colour of its own line
    if (key < 0) return color ? { color, ink: '', title: '', depth: 0, stmt: -1 } : null
    const first = inp.labelAll || laneKey(n - 1) !== key, second = !first && laneKey(n - 2) !== key
    const label = st ? doc.label(st) : cur ? `#${cur.number}` : ''
    return {
      color, ink,
      label: first ? label : undefined,
      sub: second && st?.kind === 0 && st.text ? preview(st.text, 60) : undefined,
      title: `cursor #${cur?.number ?? '?'}${st ? ` · ${label}` : ''}${st?.text ? `\n${preview(st.text, 200)}` : ''}`,
      depth: cur?.depth ?? 0,
      stmt: sid,
    }
  }

  return (n, l) => {
    const hit = out.get(n)
    if (hit) return hit
    const kind = kindOf(l)
    if (kind === 'binds' && /^BINDS\s+#/.test(l.text) && !inp.bindAt?.(n)) inp.missingBinds?.(n)
    else if (kind === 'bind-line' && inp.missingBinds && !inp.bindAt?.(n)) {
      // a bind line whose header is above the view: ask for the header's values
      for (let x = n - 1, i = 0; x >= 1 && i < 300; x--, i++) {
        const h = lineAt(x)
        if (!h) break
        const k = kindOf(h)
        if (k === 'binds') { if (/^BINDS\s+#/.test(h.text)) inp.missingBinds(x); break }
        if (k !== 'bind-line' && k !== 'blank' && k !== 'unknown') break
      }
    }
    const v = describeLine(l.text, kind, n, ctx)
    const tim = lineTim(l.text, kind)
    let before: { line: number; tim: number; dur: number } | null | undefined // the line with a time before (looked up once, when a column needs it)
    const prev = () => (before === undefined ? (before = prevTim(n)) : before)
    let delta = '', deltaTitle: string | undefined, pinned = false, deltaUs: number | undefined, deltaEmph = false
    const signed = (us: number) => `${us < 0 ? '−' : '+'}${fmtInt(Math.abs(us))} µs`
    let step: number | undefined // the time from the line with a time before (what the Δ colours and the Δ filter use: tim to tim, not the gap)
    if (tim !== undefined && colorBy === 'delta') { const p = prev(); if (p) step = tim - p.tim }
    if (tim !== undefined) {
      if (inp.pin && inp.pin.line === n) { pinned = true; deltaTitle = 'the pinned line: Δ is the time from here' }
      else if (inp.pin) {
        const us = tim - inp.pin.tim
        delta = fmtDelta(us)
        deltaUs = Math.abs(us)
        deltaTitle = `${signed(us)} from the pinned line (${fmtInt(inp.pin.line)})`
      } else {
        const p = prev()
        const own = durOf(l.text, kind)
        const g = p ? gapDelta(unexplainedGap(tim, own, p.tim), p.dur) : undefined
        if (p && g) {
          delta = fmtDelta(g.us)
          deltaUs = g.us
          deltaEmph = g.emph
          deltaTitle = `${fmtInt(g.us)} µs unexplained: this line started (its tim minus its own ${fmtDur(own)}) that long after line ${fmtInt(p.line)} ended\n${signed(tim - p.tim)} tim to tim, from line ${fmtInt(p.line)}`
        }
      }
    }
    let clock = v.wall?.clock ?? '', micros = v.wall?.micros ?? '', clockTitle = v.wall?.title
    if (tim !== undefined) {
      const c = clockCell(tim, doc)
      clockTitle = c.title
      if (doc.wallOffsetUs) { clock = c.text; micros = String(Math.floor((tim + doc.wallOffsetUs) % 1000)).padStart(3, '0') } else clock = c.text
    }
    // the clock in full where it starts or HH:MM:SS changes, else the digits that change
    const hms = hmsOf(clock)
    const clockFull = !hms || prevHms(n) !== hms
    const clockShort = hms ? clock.slice(8) + micros : ''
    const hotUs = inp.hot.get(n)
    // a hot spot is a call or wait of 1 % of the traced time or more; an idle wait (the client's think time) is not one to look at
    const hot = hotUs !== undefined && v.bar?.role !== 'idle'
    const plan = v.plan && inp.hotUs !== undefined && (v.plan.self ?? 0) >= inp.hotUs ? { ...v.plan, hot: true } : v.plan
    const cell: ReadableCell = {
      ...v,
      plan,
      lane: laneOf(n, l, v, step),
      hot,
      trackW: v.bar ? barFrac(v.bar.us) : undefined,
      trackCpuW: v.bar?.cpu !== undefined ? barFrac(v.bar.cpu) : undefined,
      delta, deltaTitle, pinned, fromPin: !!inp.pin, deltaUs, deltaEmph, clock, micros, clockTitle, clockFull, clockShort,
    }
    out.set(n, cell)
    return cell
  }
}
