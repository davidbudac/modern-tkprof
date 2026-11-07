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
import { QUIET_TONE, describeLine, describeMarker, headerKey, parseCall, parseWait, planDump, toneColor, waitRun, type LineView, type PlanCell, type ReadableContext, type WaitMicro } from '../data/readable'
import { laneColorOf, type LaneColor } from '../data/lanecolor'

/** A cursor's stretch of consecutive lines, drawn as a band (in the statement's colour, or what the view colours by); its first rows carry the sql_id and the SQL. */
export interface Lane {
  /** the band's colour (a CSS colour), undefined for no band */
  color?: string
  /** the statement's colour, the label's (whatever the band shows); '' for none */
  ink: string
  /** the first row of the stretch's `label` and the second's `sub` (the viewer shows them in the sticky lane row at the top of the view, not in the rows) */
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
  /** the Duration cell's track: the line's own time as a fraction of it (log of its share of the traced time, 0.01 % to 100 %: `barFrac`), and a call's CPU part */
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
  /** the first row of an execution (its BINDS block's header, else its EXEC): a rule above it and the `exec N` tag at the start of Detail (`execNo`) */
  execFirst: boolean; execNo?: number
  /** a wait of a run of 3 or more of the same event and object: its varying fields in columns (`micro`); `ditto`: the row above is of the run too, so the repeated prefix is faint */
  micro?: WaitMicro; ditto: boolean
  /** a trace header line: the length of the longest key of its block (the lines of the header around it), in digits: the key column is that wide, so a long key never pushes its value over */
  keyW?: number
  /** the bracket of the waits a call waited for: the rule down the Detail column from the first non-idle wait after the call before (`first`) through the rows (`in`) to the call that closes them (`end`); `brIndent`: this wait is one of them */
  br?: 'first' | 'in' | 'end'; brIndent: boolean
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
  /** the file's traced time (µs): the Duration tracks are log shares of it (`barFrac`); undefined: empty tracks */
  spanUs?: number
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
/** How far a wait looks for the other waits of its run, and a wait or call for its bracket; a BINDS block's lines for the BINDS header. */
const RUN_LOOK = 60
const BR_LOOK = 300
const BINDS_LOOK = 600
/** Lines a run of waits or a bracket reads through (anything else ends it). */
const THROUGH = new Set<LineKind>(['wait', 'marker', 'blank', 'separator', 'unknown', 'end-of-stmt'])

/** `HH:MM:SS` of a clock text; '' when it has none (a trace without a wall clock reads `+1.752 s`). */
const hmsOf = (clock: string) => (/^\d\d:\d\d:\d\d\./.test(clock) ? clock.slice(0, 8) : '')

export function readableRowsOf(inp: ReadableInputs): (line: number, l: CachedLine) => ReadableCell {
  const { doc, line: lineAt } = inp
  const span = inp.spanUs ?? 0
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


  // ---- runs of waits, the bracket of a call's waits, the first row of an execution: what the lines around a row say ----------------------------
  /** A WAIT line's cursor, whether it is idle, its run key and micro-columns (memoised per line). */
  const waits = new Map<number, { cur: string; idle: boolean; key: string; micro?: WaitMicro } | null>()
  const waitAt = (x: number) => {
    let w = waits.get(x)
    if (w === undefined) {
      const l = lineAt(x)
      const p = l && kindOf(l) === 'wait' ? parseWait(l.text) : null
      const r = p && l ? waitRun(l.text, ctx) : undefined
      w = p && r ? { cur: p.cur, idle: r.role === 'idle', key: r.key, micro: r.micro } : null
      waits.set(x, w)
    }
    return w
  }
  /** The waits of the same event and object around line n (itself included, at most RUN_LOOK lines each way, through the waits of the same call). */
  const runSize = (n: number, key: string): number => {
    let c = 1
    for (const dir of [-1, 1]) {
      for (let i = 1, x = n + dir; i <= RUN_LOOK && c < 3; i++, x += dir) {
        const l = lineAt(x)
        if (!l) break
        const k = kindOf(l)
        if (k === 'wait') { if (waitAt(x)?.key === key) c++ } else if (!THROUGH.has(k)) break
      }
    }
    return c
  }
  /** The line above n that a row shows (a blank, a rule or the end of a statement are folded away under it). */
  const lineAbove = (n: number): number => {
    for (let x = n - 1; x >= 1 && x > n - 8; x--) {
      const l = lineAt(x)
      if (!l) return -1
      const k = kindOf(l)
      if (k !== 'blank' && k !== 'separator' && k !== 'end-of-stmt') return x
    }
    return -1
  }
  /** The call that closes the waits of line n: its number; 'open' when the lines run on past what is loaded or looked at; null when another kind of line comes first. */
  const closerOf = (n: number): number | 'open' | null => {
    for (let i = 1, x = n + 1; i <= BR_LOOK; i++, x++) {
      const l = lineAt(x)
      if (!l) return 'open'
      const k = kindOf(l)
      if (k === 'call') return x
      if (!THROUGH.has(k)) return null
    }
    return 'open'
  }
  const openers = new Map<number, number>()
  /** The first non-idle wait of call c's cursor after the call (or other line) before it; -1 for none, and when a wait of another cursor comes in between. */
  const openerOf = (c: number): number => {
    let o = openers.get(c)
    if (o === undefined) {
      const cur = parseCall(lineAt(c)?.text ?? '')?.cur
      o = -1
      for (let i = 1, x = c - 1; i <= BR_LOOK; i++, x--) {
        const l = lineAt(x)
        if (!l) break
        const k = kindOf(l)
        if (k === 'wait') {
          const w = waitAt(x)
          if (w && !w.idle) { if (w.cur !== cur) break; o = x }
        } else if (!THROUGH.has(k)) break
      }
      openers.set(c, o)
    }
    return o
  }
  /** Whether a BINDS header comes before the EXEC at line n (through its Bind# and attribute lines): the EXEC is not the first row of its execution then. */
  const bindsBefore = (n: number): boolean => {
    for (let i = 1, x = n - 1; i <= BINDS_LOOK && x >= 1; i++, x--) {
      const l = lineAt(x)
      if (!l) return false
      const k = kindOf(l)
      if (k === 'binds') return /^BINDS\s+#/.test(l.text)
      if (k !== 'bind-line' && k !== 'blank' && k !== 'unknown') return false
    }
    return false
  }

  /** The longest key among the header lines around line n (the contiguous run of `header` lines, at most RUN_LOOK each way). */
  const headerKeyW = (n: number): number => {
    let w = 0
    for (const dir of [-1, 1]) {
      for (let i = 0, x = dir === 1 ? n : n - 1; i < RUN_LOOK; i++, x += dir) {
        const o = lineAt(x)
        if (!o || kindOf(o) !== 'header') break
        w = Math.max(w, headerKey(o.text)?.length ?? 0)
      }
    }
    return w
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
    // a run of 3 or more waits of one event: columns and a ditto
    let micro: WaitMicro | undefined, ditto = false
    if (kind === 'wait' && v.wait?.micro && runSize(n, v.wait.key) >= 3) {
      micro = v.wait.micro
      const a = lineAbove(n), pw = a > 0 ? waitAt(a) : null
      ditto = !!pw && pw.key === v.wait.key && !!pw.micro
    }
    // the bracket of what a call waited for
    let br: ReadableCell['br'], brIndent = false
    if (kind === 'call') { if (openerOf(n) >= 0) br = 'end' }
    else if (kind === 'wait' || kind === 'marker') {
      const c = closerOf(n)
      if (typeof c === 'number') { const o = openerOf(c); if (o >= 0 && o <= n) br = o === n ? 'first' : 'in' }
      else if (c === 'open' && kind === 'wait' && !waitAt(n)?.idle) br = 'in'
      brIndent = br !== undefined && kind === 'wait' && !waitAt(n)?.idle
    }
    // the first row of an execution
    let execFirst = false
    if (kind === 'binds' && /^BINDS\s+#/.test(l.text)) execFirst = true
    else if (kind === 'call' && l.text.startsWith('EXEC ')) execFirst = !bindsBefore(n)
    const plan = v.plan && inp.hotUs !== undefined && (v.plan.self ?? 0) >= inp.hotUs ? { ...v.plan, hot: true } : v.plan
    const cell: ReadableCell = {
      ...v,
      plan,
      lane: laneOf(n, l, v, step),
      hot,
      trackW: v.bar ? barFrac(v.bar.us, span) : undefined,
      trackCpuW: v.bar?.cpu !== undefined ? barFrac(v.bar.cpu, span) : undefined,
      delta, deltaTitle, pinned, fromPin: !!inp.pin, deltaUs, deltaEmph, clock, micros, clockTitle, clockFull, clockShort,
      execFirst, execNo: execFirst && l.execNo > 0 ? l.execNo : undefined, micro, ditto, br, brIndent, // (execNo 0: the line is in no execution)
      keyW: kind === 'header' && headerKey(l.text) !== undefined ? headerKeyW(n) : undefined,
    }
    out.set(n, cell)
    return cell
  }
}
