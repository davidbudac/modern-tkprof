// The Dialogue (docs/ARCHITECTURE.md § "Dialogue"): one execution as a sequence diagram between the client, the server
// process and the resources it waited on. dialogueOf turns the raw rows of `executions/trace` (data/exectrace.ts) into
// turns (one per own call), collapses runs of alike round trips into loop frames, and adds up the true-scale totals;
// dialogueLayout places it all (the component only draws what it is given).
//
// Wait attribution follows the model (internal/model/builder.go attachWait): a WAIT line belongs to the next call of its
// cursor, and is `between` when its time falls outside that call's [tim - e, tim]. So a between wait of own call k is
// the client gap before turn k. A between wait of a recursive child is a gap only when its time is outside the own
// call too (then it goes to the turn it precedes); inside the own call it is part of the call, like any in-call wait.

import type { TraceDoc } from './doc'
import type { ExecTrace, TraceCall, TraceWait } from './exectrace'
import { CallKind, type ID } from './types'
import { isFileP1 } from './iomap'
import { roleOfClass, type Role } from '../components/colors'

export type Lifeline = 'client' | 'server' | 'disk' | 'temp' | 'others'
export type SideLine = Exclude<Lifeline, 'client' | 'server'>
export const sideLines: SideLine[] = ['disk', 'temp', 'others']

/** The waits of one event in a turn (or a frame): count, time, and the line of the first one (for its LineRef). */
export interface Traffic { event: ID; n: number; us: number; line: number }

/** The recursive calls one level down (dep + 1) inside an own call, by statement and call kind. */
export interface RecGroup {
  stmt: ID; kind: number; n: number; us: number; medianEla: number
  /** the first call of the group (its line is the LineRef) */
  first: TraceCall
  /** calls above outlierX × the median, in trace order (groups of at least minRun calls only) */
  outliers: TraceCall[]
}
export interface Recursive { n: number; us: number; groups: RecGroup[] }

export interface Turn {
  call: TraceCall; kind: number; rows: number; ela: number; cpu: number
  /** 1-based number among the execution's calls of the same kind (FETCH #1) */
  ordinal: number
  /** client gap before the call: its between waits (for the first turn: before the execution, outside the wall) */
  gapBefore: number; gapWaits: Traffic[]
  sides: Partial<Record<SideLine, Traffic[]>>
  net: { toClient: Traffic | null; moreData: Traffic | null }
  recursive: Recursive
  /** why it was kept out of its frame */
  outlier: 'ela' | 'gap' | null
  /** the medians of the run it belongs to (runs of at least minRun turns), which `outlier` is measured against */
  runMedian: { ela: number; gap: number } | null
  /** round trip number from 0: a new one starts after an idle between wait (the server waited for the client) */
  trip: number
  /** the last call of its round trip: the reply goes back to the client after it */
  endsTrip: boolean
}

export interface Frame {
  turns: Turn[]; n: number; kind: number
  /** rows of each turn (the run's key) */
  rows: number
  serverUs: number; cpuUs: number; gapUs: number; medianEla: number; medianGap: number
  sides: Turn['sides']; net: Turn['net']; recursive: Recursive; gapWaits: Traffic[]
}

export type Step = { type: 'turn'; turn: Turn } | { type: 'frame'; frame: Frame }

export interface Dialogue {
  /** client, server, then disk / temp / others only when used */
  lifelines: Lifeline[]
  steps: Step[]
  /** first call's tim - e … last call's tim */
  wall: { startTim: number; endTim: number; us: number }
  /**
   * cpuUs: Σ own calls' c (inclusive of recursive calls); byRole: in-call waits (own and recursive) by role; gapUs: the
   * client gaps inside the wall (the first turn's gap is before it: `leadGapUs`); untimedUs: the rest, clamped at 0.
   */
  totals: { cpuUs: number; byRole: Partial<Record<Role, number>>; gapUs: number; untimedUs: number; leadGapUs: number }
  /** time to first row: end of the first FETCH with rows > 0 minus wall.startTim */
  ttfrUs: number | null
  /** round trips (null: the trace has no WAIT lines at all, so they cannot be told apart) */
  trips: number | null
  /** the most frequent row count of the FETCH calls that returned rows (the fetch array size, in effect) */
  rowsPerTrip: number | null
  rows: number
  calls: number
  /** what the side lifelines stand for: the file numbers of their I/O waits (`isFileP1`: not a control file's), the wait classes */
  lanes: Partial<Record<SideLine, { files: number[]; classes: string[] }>>
  truncated: boolean
}

export interface DialogueOptions {
  /** shortest run of alike turns that becomes a frame (3) */
  minRun?: number
  /** a turn whose elapsed or gap exceeds this many times its run's median leaves the run (10) */
  outlierX?: number
  /** medians below this count as this, so timer noise on µs calls does not make outliers (10 µs) */
  floorUs?: number
}

const NET_TO = 'SQL*Net message to client'
const NET_MORE = 'SQL*Net more data to client'

/** The lifeline of an in-call wait: TEMP by name, Disk by class, network replies annotate the return, the rest is Others. */
export function lifelineOf(ev: { name: string; class: string } | undefined): SideLine | 'net' {
  if (!ev) return 'others'
  if (ev.name === NET_TO || ev.name === NET_MORE) return 'net'
  if (/temp/i.test(ev.name)) return 'temp'
  if (ev.class === 'User I/O' || ev.class === 'System I/O') return 'disk'
  return 'others'
}

/** Whether an arrow of this event points back at the server (data read from the lifeline) rather than at the lifeline. */
export const readsFrom = (name: string): boolean => /\bread\b/i.test(name)

export function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = xs.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

class TrafficMap {
  private m = new Map<ID, Traffic>()
  add(w: { event: ID; ela: number; line: number }) {
    const t = this.m.get(w.event)
    if (t) { t.n++; t.us += w.ela; if (w.line > 0 && (t.line <= 0 || w.line < t.line)) t.line = w.line } else this.m.set(w.event, { event: w.event, n: 1, us: w.ela, line: w.line })
  }
  merge(ts: Traffic[]) {
    for (const x of ts) {
      const t = this.m.get(x.event)
      if (t) { t.n += x.n; t.us += x.us; if (x.line > 0 && (t.line <= 0 || x.line < t.line)) t.line = x.line } else this.m.set(x.event, { ...x })
    }
  }
  get size() { return this.m.size }
  list(): Traffic[] { return [...this.m.values()].sort((a, b) => b.us - a.us || b.n - a.n || a.event - b.event) }
}

interface Build {
  turn: Turn
  gap: TrafficMap
  sides: Record<SideLine, TrafficMap>
  toClient: TrafficMap
  moreData: TrafficMap
  children: TraceCall[]
}

const sumOf = (ts: Traffic[] | undefined) => (ts ?? []).reduce((a, t) => a + t.us, 0)

/** Groups recursive calls by statement and kind; a group of at least minRun calls marks its outliers. */
export function recursiveOf(children: TraceCall[], o: Required<DialogueOptions>): Recursive {
  const by = new Map<string, TraceCall[]>()
  let us = 0
  for (const c of children) {
    us += c.e
    const k = `${c.stmt}:${c.kind}`
    const l = by.get(k)
    if (l) l.push(c); else by.set(k, [c])
  }
  const groups: RecGroup[] = [...by.values()].map((cs) => {
    const med = median(cs.map((c) => c.e))
    const thr = o.outlierX * Math.max(med, o.floorUs)
    return {
      stmt: cs[0].stmt, kind: cs[0].kind, n: cs.length, us: cs.reduce((a, c) => a + c.e, 0), medianEla: med, first: cs[0],
      outliers: cs.length >= o.minRun ? cs.filter((c) => c.e > thr) : [],
    }
  }).sort((a, b) => b.us - a.us || b.n - a.n || a.stmt - b.stmt || a.kind - b.kind)
  return { n: children.length, us, groups }
}

function mergeSides(turns: Turn[]): Turn['sides'] {
  const out: Turn['sides'] = {}
  for (const l of sideLines) {
    const m = new TrafficMap()
    for (const t of turns) if (t.sides[l]) m.merge(t.sides[l]!)
    if (m.size) out[l] = m.list()
  }
  return out
}

function mergeNet(turns: Turn[], k: 'toClient' | 'moreData'): Traffic | null {
  const m = new TrafficMap()
  for (const t of turns) if (t.net[k]) m.merge([t.net[k]!])
  return m.list()[0] ?? null
}

function frameOf(turns: Turn[], children: Map<Turn, TraceCall[]>, o: Required<DialogueOptions>): Frame {
  const gaps = new TrafficMap()
  for (const t of turns) gaps.merge(t.gapWaits)
  return {
    turns, n: turns.length, kind: turns[0].kind, rows: turns[0].rows,
    serverUs: turns.reduce((a, t) => a + t.ela, 0), cpuUs: turns.reduce((a, t) => a + t.cpu, 0), gapUs: turns.reduce((a, t) => a + t.gapBefore, 0),
    medianEla: median(turns.map((t) => t.ela)), medianGap: median(turns.map((t) => t.gapBefore)),
    sides: mergeSides(turns),
    net: { toClient: mergeNet(turns, 'toClient'), moreData: mergeNet(turns, 'moreData') },
    recursive: recursiveOf(turns.flatMap((t) => children.get(t) ?? []), o),
    gapWaits: gaps.list(),
  }
}

/** Splits turns into steps: maximal runs of equal (kind, rows) of at least minRun become frames, minus their outliers. */
export function collapse(turns: Turn[], children: Map<Turn, TraceCall[]>, o: Required<DialogueOptions>): Step[] {
  const steps: Step[] = []
  const flush = (seg: Turn[]) => {
    if (seg.length >= o.minRun) steps.push({ type: 'frame', frame: frameOf(seg, children, o) })
    else for (const t of seg) steps.push({ type: 'turn', turn: t })
  }
  for (let i = 0; i < turns.length;) {
    let j = i + 1
    while (j < turns.length && turns[j].kind === turns[i].kind && turns[j].rows === turns[i].rows) j++
    const run = turns.slice(i, j)
    i = j
    if (run.length < o.minRun) { flush(run); continue }
    const runMedian = { ela: median(run.map((t) => t.ela)), gap: median(run.map((t) => t.gapBefore)) }
    const thrE = o.outlierX * Math.max(runMedian.ela, o.floorUs)
    const thrG = o.outlierX * Math.max(runMedian.gap, o.floorUs)
    let seg: Turn[] = []
    for (const t of run) {
      t.runMedian = runMedian
      t.outlier = t.ela > thrE ? 'ela' : t.gapBefore > thrG ? 'gap' : null
      if (t.outlier) { flush(seg); seg = []; steps.push({ type: 'turn', turn: t }) } else seg.push(t)
    }
    flush(seg)
  }
  return steps
}

/** One execution as a dialogue. Only `doc.events` is read (the classes and names of the waits). */
export function dialogueOf(doc: Pick<TraceDoc, 'events'>, trace: ExecTrace, opts: DialogueOptions = {}): Dialogue {
  const o: Required<DialogueOptions> = { minRun: opts.minRun ?? 3, outlierX: opts.outlierX ?? 10, floorUs: opts.floorUs ?? 10 }
  const kindCount = new Map<number, number>()
  const builds: Build[] = trace.calls.map((call) => {
    const ordinal = (kindCount.get(call.kind) ?? 0) + 1
    kindCount.set(call.kind, ordinal)
    return {
      turn: {
        call, kind: call.kind, rows: call.r, ela: call.e, cpu: call.c, ordinal, gapBefore: 0, gapWaits: [], sides: {}, net: { toClient: null, moreData: null },
        recursive: { n: 0, us: 0, groups: [] }, outlier: null, runMedian: null, trip: 0, endsTrip: true,
      },
      gap: new TrafficMap(), sides: { disk: new TrafficMap(), temp: new TrafficMap(), others: new TrafficMap() },
      toClient: new TrafficMap(), moreData: new TrafficMap(), children: [],
    }
  })
  const at = new Map<ID, number>()
  trace.calls.forEach((c, k) => at.set(c.id, k))
  const start = (k: number) => trace.calls[k].tim - trace.calls[k].e

  const byRole: Partial<Record<Role, number>> = {}
  const idleGap: boolean[] = builds.map(() => false)
  const lanes: Partial<Record<SideLine, { files: Set<number>; classes: Set<string> }>> = {}
  const ownerOf = (w: TraceWait) => at.get(w.owner) ?? at.get(w.call)
  for (const w of trace.waits) {
    const k = ownerOf(w)
    if (k === undefined) continue
    const ev = doc.events[w.event]
    const own = trace.calls[k]
    let gap = w.between && w.call === own.id
    let gk = k
    if (w.between && !gap && w.tim > 0 && own.tim > 0 && !(w.tim > start(k) && w.tim <= own.tim)) {
      // a recursive call's between wait outside the own call: the gap before the turn it precedes
      gap = true
      while (gk > 0 && trace.calls[gk - 1].tim > 0 && start(gk - 1) >= w.tim) gk--
    }
    if (gap) {
      builds[gk].gap.add(w)
      if (ev?.idle) idleGap[gk] = true
      continue
    }
    const role = ev ? roleOfClass(ev.class, ev.idle) : 'other'
    byRole[role] = (byRole[role] ?? 0) + w.ela
    const line = lifelineOf(ev)
    if (line === 'net') { (ev!.name === NET_TO ? builds[k].toClient : builds[k].moreData).add(w); continue }
    builds[k].sides[line].add(w)
    const lane = (lanes[line] ??= { files: new Set(), classes: new Set() })
    if (ev) lane.classes.add(ev.class)
    if (ev && isFileP1(ev) && w.p1 >= 0) lane.files.add(w.p1)
  }
  for (const c of trace.children) {
    const k = at.get(c.owner)
    if (k === undefined) continue
    if (c.dep === trace.calls[k].dep + 1) builds[k].children.push(c)
  }

  const used = new Set<SideLine>()
  const children = new Map<Turn, TraceCall[]>()
  // with no WAIT lines in the trace at all (level 1) the round trips cannot be told apart; in a trace with waits, calls
  // without an idle wait between them went in one round trip
  const hasWaits = trace.waits.length > 0 || doc.events.length > 0
  let trip = 0
  builds.forEach((b, k) => {
    const t = b.turn
    t.gapWaits = b.gap.list()
    t.gapBefore = sumOf(t.gapWaits)
    for (const l of sideLines) if (b.sides[l].size) { t.sides[l] = b.sides[l].list(); used.add(l) }
    t.net = { toClient: b.toClient.list()[0] ?? null, moreData: b.moreData.list()[0] ?? null }
    t.recursive = recursiveOf(b.children, o)
    children.set(t, b.children)
    if (k > 0 && idleGap[k]) { trip++; builds[k - 1].turn.endsTrip = true }
    t.trip = trip
    if (hasWaits && k + 1 < builds.length) t.endsTrip = false // set again when the next turn starts a trip
  })
  const turns = builds.map((b) => b.turn)
  const steps = collapse(turns, children, o)

  const first = trace.calls[0], last = trace.calls[trace.calls.length - 1]
  const wall = first ? { startTim: first.tim - first.e, endTim: last.tim, us: Math.max(0, last.tim - (first.tim - first.e)) } : { startTim: 0, endTim: 0, us: 0 }
  const cpuUs = trace.calls.reduce((a, c) => a + c.c, 0)
  const leadGapUs = turns[0]?.gapBefore ?? 0
  const gapUs = turns.reduce((a, t) => a + t.gapBefore, 0) - leadGapUs
  const waitUs = Object.values(byRole).reduce((a, v) => a + (v ?? 0), 0)
  const firstRows = turns.find((t) => t.kind === CallKind.fetch && t.rows > 0)
  const counts = new Map<number, number>()
  for (const t of turns) if (t.kind === CallKind.fetch && t.rows > 0) counts.set(t.rows, (counts.get(t.rows) ?? 0) + 1)
  let rowsPerTrip: number | null = null, best = 0
  for (const [r, n] of counts) if (n > best || (n === best && r > (rowsPerTrip ?? 0))) { best = n; rowsPerTrip = r }

  return {
    lifelines: ['client', 'server', ...sideLines.filter((l) => used.has(l))],
    steps, wall,
    totals: { cpuUs, byRole, gapUs, untimedUs: Math.max(0, wall.us - cpuUs - waitUs - gapUs), leadGapUs },
    ttfrUs: firstRows ? firstRows.call.tim - wall.startTim : null,
    trips: hasWaits ? trip + 1 : null,
    rowsPerTrip,
    rows: turns.reduce((a, t) => a + (t.kind === CallKind.fetch ? t.rows : 0), 0),
    calls: turns.length,
    lanes: Object.fromEntries(Object.entries(lanes).map(([l, v]) => [l, { files: [...v.files].sort((a, b) => a - b), classes: [...v.classes].sort() }])),
    truncated: trace.truncated,
  }
}

// ---- layout --------------------------------------------------------------------------------------------------------

export const LANE_W = 170
export const GUTTER = 100
export const MIN_W = 520
export const HEAD_H = 52
/** at most this many steps are drawn; the rest is a note */
export const MAX_STEPS = 300
/** per lifeline at most this many event arrows in one turn; the rest is one "more events" arrow */
export const MAX_ARROWS = 3

/** Height of a server activation bar: 8 + 10·log10(1 + ela / 100 µs) px. */
export const actHeight = (us: number): number => 8 + 10 * Math.log10(1 + Math.max(0, us) / 100)
/** Height of a client gap block (the same log scale, a little flatter). */
export const gapHeight = (us: number): number => Math.min(36, 6 + 7 * Math.log10(1 + Math.max(0, us) / 100))
/** Stroke width of a side arrow by its time. */
export const arrowWidth = (us: number): number => 1.2 + Math.min(3, Math.log10(1 + Math.max(0, us) / 1000))

/** One side arrow: the events of one row (a single event, or the rest of a lifeline merged). */
export interface SideRow { line: SideLine; traffic: Traffic[]; y: number; read: boolean }

export interface StepBox {
  step: Step
  /** the turn drawn: the turn itself, or the frame's first turn standing for all of them */
  turn: Turn
  y: number; h: number
  frame: { x1: number; x2: number; y1: number; y2: number } | null
  gap: { y: number; h: number; us: number } | null
  callY: number
  act: { y: number; h: number }
  sides: SideRow[]
  rec: { y: number; lines: number } | null
  /** the dashed reply to the client (null: the call does not end a round trip) */
  retY: number | null
}

export interface Layout {
  width: number; height: number
  lanes: { line: Lifeline; x: number }[]
  x: Record<Lifeline, number>
  boxes: StepBox[]
  /** steps not drawn (beyond MAX_STEPS) */
  hidden: number
  /** the time-to-first-row bracket: from the first call to the reply with the first rows */
  ttfr: { y1: number; y2: number } | null
}

/** Lines of the recursive-SQL label: the total, then one per group with outliers (at most REC_OUTLIER_LINES). */
export const REC_OUTLIER_LINES = 2
export const recLines = (r: Recursive): number => 1 + Math.min(REC_OUTLIER_LINES, r.groups.filter((g) => g.outliers.length).length)
/** The recursive-SQL label starts this far right of the server lifeline and needs about this much room (an outlier line). */
export const REC_X = 32
export const REC_LABEL_W = 340

/** Places a dialogue. `nameOf(event)`: the event's name (read events point back at the server). */
export function dialogueLayout(d: Dialogue, nameOf: (event: ID) => string = () => ''): Layout {
  const n = d.lifelines.length
  const laneW = Math.max(LANE_W, (MIN_W - GUTTER) / n)
  const x = {} as Record<Lifeline, number>
  const lanes = d.lifelines.map((line, i) => { x[line] = Math.round(GUTTER + laneW * (i + 0.5)); return { line, x: x[line] } })
  const boxes: StepBox[] = []
  let y = HEAD_H + 14
  let ttfr: Layout['ttfr'] = null
  const shown = d.steps.slice(0, MAX_STEPS)
  // a recursive-SQL label next to the server must fit: with no lifeline right of it the figure gets a margin for it
  const hasRec = shown.some((s) => (s.type === 'turn' ? s.turn.recursive.n : s.frame.recursive.n) > 0)
  const width = Math.max(Math.round(GUTTER + n * laneW), hasRec ? x.server + REC_X + REC_LABEL_W : 0)
  shown.forEach((step, k) => {
    const isFrame = step.type === 'frame'
    const turn = step.type === 'turn' ? step.turn : step.frame.turns[0]
    const gapUs = step.type === 'turn' ? step.turn.gapBefore : step.frame.medianGap
    const ela = step.type === 'turn' ? step.turn.ela : step.frame.medianEla
    const sides = step.type === 'turn' ? step.turn.sides : step.frame.sides
    const rec = step.type === 'turn' ? step.turn.recursive : step.frame.recursive
    const y0 = y
    let cy = y0 + (isFrame ? 30 : 0)
    let gap: StepBox['gap'] = null
    if (gapUs > 0) {
      const h = gapHeight(gapUs)
      gap = { y: cy + 2, h, us: gapUs }
      cy += Math.max(h, 24) + 6
    }
    const callY = cy + 16
    const act = { y: callY, h: actHeight(ela) }
    const rows: SideRow[] = []
    let sy = callY + 30
    for (const l of sideLines) {
      const ts = sides[l]
      if (!ts?.length) continue
      const head = ts.length > MAX_ARROWS ? ts.slice(0, MAX_ARROWS - 1) : ts
      const groups: Traffic[][] = head.map((t) => [t])
      if (ts.length > MAX_ARROWS) groups.push(ts.slice(MAX_ARROWS - 1))
      for (const g of groups) {
        rows.push({ line: l, traffic: g, y: sy, read: g.length === 1 && readsFrom(nameOf(g[0].event)) })
        sy += 34
      }
    }
    let recBox: StepBox['rec'] = null
    if (rec.n > 0) {
      const lines = recLines(rec)
      recBox = { y: sy - 16, lines }
      sy += 8 + 14 * lines
    }
    const bottom = Math.max(act.y + act.h, rows.length || recBox ? sy - 24 : 0)
    const ends = step.type === 'turn' ? step.turn.endsTrip : true
    const retY = ends ? bottom + 22 : null
    let end = (retY ?? bottom) + 8
    let frame: StepBox['frame'] = null
    if (isFrame) {
      end += 6
      frame = { x1: 6, x2: width - 6, y1: y0, y2: end }
      end += 4
    }
    boxes.push({ step, turn, y: y0, h: end - y0, frame, gap, callY, act, sides: rows, rec: recBox, retY })
    if (d.ttfrUs !== null && !ttfr) {
      const has = step.type === 'turn' ? step.turn.kind === CallKind.fetch && step.turn.rows > 0 : step.frame.kind === CallKind.fetch && step.frame.rows > 0
      if (has) ttfr = { y1: boxes[0].callY, y2: retY ?? bottom }
    }
    y = end + (k + 1 < shown.length && !isFrame && shown[k + 1].type !== 'frame' ? 4 : 10)
  })
  return { width, height: Math.ceil(y + 10), lanes, x, boxes, hidden: d.steps.length - shown.length, ttfr }
}
