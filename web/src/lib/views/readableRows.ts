// The rows of the Lines view's readable mode: each cached line described (data/readable.ts) and given its lane (the cursor it belongs
// to, in its statement's colour), its time from the pin or from the line before, its clock time and whether it is a hot spot.
import type { Tone } from '../data/blocklayout'
import { roleOfClass } from '../components/colors'
import type { TraceDoc } from '../data/doc'
import { fmtInt, preview } from '../data/format'
import { LINE_KINDS, type CachedLine } from '../data/linecache'
import type { BindAt } from '../data/bindat'
import { clockCell, fmtDelta, lineTim } from '../data/linetime'
import type { LineKind } from '../data/lines'
import { QUIET_TONE, describeLine, planDump, toneColor, type LineView, type PlanCell, type ReadableContext } from '../data/readable'

/** A cursor's stretch of consecutive lines, drawn as a band in the statement's colour; its first rows carry the sql_id and the SQL. */
export interface Lane {
  /** the band's colour (a CSS colour) */
  color: string
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
  /** the bar's length as a fraction of the scale (the longest line of the file), and its CPU part */
  barW?: number
  cpuW?: number
  /** the time from the pin (or the line before): '' for a line without a time; `pinned` on the pin itself */
  delta: string; deltaTitle?: string; pinned: boolean
  /** HH:MM:SS.mmm and the µs after it; '' for none */
  clock: string; micros: string; clockTitle?: string
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
  /** µs at which a bar is full: the file's longest line */
  scaleUs: number
  bindAt?(line: number): BindAt | undefined
  /** a BINDS header in view whose values are not known yet: the owner asks for them (and rebuilds the rows when they come) */
  missingBinds?(line: number): void
}

/** Lines without a cursor of their own: they join the lane around them when the lines before and after belong to the same cursor. */
const FRAMING = new Set<LineKind>(['blank', 'separator', 'header', 'marker', 'unknown'])
/** How far a framing line looks for its neighbours, and a line for the previous time. */
const LOOK = 40
const BACK = 400

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

  const timOf = (n: number) => { const l = lineAt(n); return l ? lineTim(l.text, kindOf(l)) : undefined }
  const prevTim = (n: number): { line: number; tim: number } | null => {
    for (let x = n - 1, i = 0; x >= 1 && i < BACK; x--, i++) { const t = timOf(x); if (t !== undefined) return { line: x, tim: t } }
    return null
  }

  const laneOf = (n: number, l: CachedLine): Lane | null => {
    const key = laneKey(n)
    if (key < 0) return null
    const cur = doc.cursors[key]
    const stmt = cur ? doc.statements[cur.statement] : undefined
    const sid = stmt?.id ?? (l.stmt >= 0 ? l.stmt : -1)
    const st = sid >= 0 ? doc.statements[sid] : undefined
    const first = laneKey(n - 1) !== key, second = !first && laneKey(n - 2) !== key
    const label = st ? doc.label(st) : cur ? `#${cur.number}` : ''
    return {
      color: toneColor((st && inp.tones.get(st.id)) || QUIET_TONE),
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
    let delta = '', deltaTitle: string | undefined, pinned = false
    if (tim !== undefined) {
      if (inp.pin && inp.pin.line === n) { pinned = true; deltaTitle = 'the pinned line: Δ is the time from here' }
      else {
        const ref = inp.pin ?? prevTim(n)
        if (ref) {
          const us = tim - ref.tim
          delta = fmtDelta(us)
          deltaTitle = `${us < 0 ? '−' : '+'}${fmtInt(Math.abs(us))} µs from ${inp.pin ? 'the pinned line' : 'the line with a time before'} (${fmtInt(ref.line)})`
        }
      }
    }
    let clock = v.wall?.clock ?? '', micros = v.wall?.micros ?? '', clockTitle = v.wall?.title
    if (tim !== undefined) {
      const c = clockCell(tim, doc)
      clockTitle = c.title
      if (doc.wallOffsetUs) { clock = c.text; micros = String(Math.floor((tim + doc.wallOffsetUs) % 1000)).padStart(3, '0') } else clock = c.text
    }
    const hotUs = inp.hot.get(n)
    const scale = Math.max(1, inp.scaleUs)
    const cell: ReadableCell = {
      ...v,
      lane: laneOf(n, l),
      hot: hotUs !== undefined,
      barW: v.bar ? Math.min(1, v.bar.us / scale) : undefined,
      cpuW: v.bar?.cpu !== undefined ? Math.min(1, v.bar.cpu / scale) : undefined,
      delta, deltaTitle, pinned, clock, micros, clockTitle,
    }
    out.set(n, cell)
    return cell
  }
}
