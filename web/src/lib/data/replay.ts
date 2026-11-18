// The Plan replay (docs/PLAN-REPLAY.md, ARCHITECTURE § Plan replay): one execution played back on its STAT plan. This
// module is the model and the layout numbers, pure: which plan line each wait belongs to, what the process does at each
// moment, rows over time, chapters, the blocks touched; views/Replay.tsx and views/replayDraw.ts only draw it.
//
// Facts: the waits (event, ela, tim, obj#, file, block), the calls, rows per fetch, the STAT totals. Inferred (the view
// marks them ≈): the line a wait belongs to, rows between the start and the end, which lines are on CPU between waits.

import type { TraceDoc } from './doc'
import type { ExecTrace, TraceCall } from './exectrace'
import { isBlockIO, blocksParam, isTempEvent, isWriteEvent, MAX_WAIT_BLOCKS } from './iomap'
import { CallKind, type Event, type ID, type Plan, type PlanLine } from './types'

export type WaitKind = 'read' | 'write' | 'twrite' | 'tread' | 'client' | 'net' | 'pxwait' | 'other' | 'recursive'

export interface RLine {
  /** the STAT line's id */
  id: number
  parentId: number
  /** 0 at the root of this plan */
  depth: number
  op: string
  object: string
  obj: number
  rows: number
  starts: number
  pw: number
  timeUs: number
  card: number
  kids: RLine[]
  parent: RLine | null
  /** pw minus the children's: the line wrote this to TEMP itself */
  selfPw: number
  /** STAT time minus the children's, at least 0 (row-source timings are sampled) */
  selfUs: number
  /** never started (starts 0, rows 0): an adaptive plan's other branch, a PX slave's line in the coordinator's dump */
  inactive: boolean
  /** the colour slot of its object (-1: no object) */
  objSlot: number
  reads: RWait[]
  treads: RWait[]
  twrites: RWait[]
}

export interface RWait {
  /** index in the execution trace's waits */
  i: number
  event: ID
  name: string
  kind: WaitKind
  /** µs from the start of the EXEC */
  start: number
  end: number
  ela: number
  obj: number
  /** datafile or tempfile number, 0 without a block address */
  file: number
  block: number
  blocks: number
  line: RLine | null
  /** the trace line of the WAIT */
  traceLine: number
}

export interface RCall {
  call: TraceCall
  kind: number
  start: number
  end: number
  rows: number
}

export type Seg =
  | { a: number; b: number; type: 'wait'; w: RWait }
  | { a: number; b: number; type: 'cpu'; call: RCall; lines: Map<RLine, number>; spread: boolean }
  | { a: number; b: number; type: 'recursive'; call: TraceCall }
  | { a: number; b: number; type: 'client'; w: RWait }
  | { a: number; b: number; type: 'between'; w: RWait }

export interface Chapter { i: number; a: number; b: number; key: string; label: string }

/** The distinct blocks of the block I/O waits of one kind of file (datafiles or TEMP), in (file, block) order. */
export interface Grid {
  temp: boolean
  files: number[]
  /** cells, with one empty cell between files */
  n: number
  distinct: number
  /** (file · 2³², block) → cell */
  cellOf: Map<number, number>
  /** per cell: the object's colour slot, -1 none, -2 the gap between files */
  owner: Int16Array
}

export interface PlanMatch {
  plan: Plan | null
  /** the dump's STAT lines (a dump the model split is joined again: dumpLines) */
  lines: PlanLine[]
  /** the STAT lines were written for this execution */
  exact: boolean
  /** else the execution of the cursor they were written after (0: unknown) */
  fromExecNo: number
}

export interface Replay {
  lines: RLine[]
  root: RLine | null
  match: PlanMatch
  /** rows of the plan lines can be inferred (the STAT is this execution's) */
  rowsKnown: boolean
  calls: RCall[]
  waits: RWait[]
  segs: Seg[]
  chapters: Chapter[]
  data: Grid | null
  temp: Grid | null
  /** objects in colour-slot order */
  objects: { obj: number; name: string }[]
  /** µs from the start of the EXEC to the end of the last FETCH */
  D: number
  /** tim of the EXEC's start */
  t0: number
  parseUs: number
  fetchRows: number
  /** end of the first FETCH with rows */
  firstRow: number | null
  truncated: boolean
  /** a PX coordinator: the slaves' work is in other sessions */
  px: boolean
  /** rows of the line produced by t; NaN when not known (STAT of another execution) */
  rowsAt(l: RLine, t: number): number
  /** the share of the line's rows produced by t, 0..1 */
  fracAt(l: RLine, t: number): number
  /** the time the line produced its last row */
  doneAt(l: RLine): number
  segAt(t: number): Seg | null
  chapterAt(t: number): Chapter
}

/** Operations that read all their input before the first row out. */
export const BLOCKING = /^(SORT|HASH GROUP BY|HASH UNIQUE|BUFFER SORT|WINDOW SORT)/
const isHashJoin = (op: string) => /^HASH JOIN/.test(op)
/** A run of waits shorter than this share of the execution joins the chapter before it. */
export const CHAPTER_MIN = 0.04
/** A line takes part in the CPU of a call without waits from this share of the self time on. */
export const SPREAD_MIN = 0.03

const fileKey = (file: number, block: number) => file * 2 ** 32 + block

/**
 * The STAT dump of an execution: the plan of its cursor and plan hash written after its EXEC and before the cursor's next
 * EXEC; else the nearest dump of the plan hash (its counts are another execution's); else none.
 */
export function planOfExecution(doc: TraceDoc, stmt: ID, trace: ExecTrace): PlanMatch {
  const none: PlanMatch = { plan: null, lines: [], exact: false, fromExecNo: 0 }
  const ex = trace.calls.find((c) => c.kind === CallKind.exec)
  if (!ex) return none
  const all = doc.plansOf(stmt)
  // dumps start at id=1; a piece that does not is the rest of a dump the model split (see dumpLines)
  const plans = all.filter((p) => p.planHash === ex.plh && p.n > 0 && doc.planLines[p.first]?.id === 1)
  if (!plans.length) return none
  const c = doc.calls
  const ids = doc.callsByStmt.get(stmt)
  let nextExec = Infinity
  for (let k = ids.indexOf(ex.id) + 1; k < ids.length; k++) {
    const i = ids[k]
    if (c.cursor[i] === ex.cursor && c.kind[i] === CallKind.exec) { nextExec = c.line[i]; break }
  }
  const own = plans.find((p) => p.cursor === ex.cursor && p.line > ex.line && p.line < nextExec)
  if (own) return { plan: own, lines: dumpLines(all, doc.planLines, own), exact: true, fromExecNo: ex.execNo }
  const near = plans.slice().sort((a, b) => (Number(b.cursor === ex.cursor) - Number(a.cursor === ex.cursor)) || Math.abs(a.line - ex.line) - Math.abs(b.line - ex.line))[0]
  let fromExecNo = 0
  for (const i of ids) if (c.cursor[i] === near.cursor && c.kind[i] === CallKind.exec && c.line[i] < near.line) fromExecNo = c.execNo[i]
  return { plan: near, lines: dumpLines(all, doc.planLines, near), exact: false, fromExecNo }
}

/**
 * The STAT lines of the dump that starts with plan `start`. The model starts a plan wherever STAT lines are not adjacent,
 * and an interleaved 10053 trace writes optimizer lines between them (opt_interleaved.trc): the plans of the same cursor and
 * plan hash right after it whose ids go on and whose parents are in the dump so far are the rest of it.
 */
export function dumpLines(plans: readonly Plan[], planLines: readonly PlanLine[], start: Plan): PlanLine[] {
  const out = planLines.slice(start.first, start.first + start.n)
  const ids = new Set(out.map((l) => l.id))
  for (let k = plans.indexOf(start) + 1; k < plans.length; k++) {
    const p = plans[k]
    const first = planLines[p.first]
    if (p.cursor !== start.cursor || p.planHash !== start.planHash || !p.n || !first) break
    if (first.id === 1 || first.id <= out[out.length - 1].id || !ids.has(first.parentId)) break
    for (const l of planLines.slice(p.first, p.first + p.n)) { out.push(l); ids.add(l.id) }
  }
  return out
}

/** The replay of an execution trace on its plan (`replayOf` finds the plan in the document). */
export function replayOf(doc: TraceDoc, stmt: ID, trace: ExecTrace): Replay {
  const match = planOfExecution(doc, stmt, trace)
  return buildReplay({ events: doc.events, trace, lines: match.lines, match })
}

export interface ReplayInput {
  events: readonly Event[]
  trace: ExecTrace
  /** the plan's STAT lines in dump order (empty: no plan) */
  lines: readonly PlanLine[]
  match: PlanMatch
}

export function buildReplay({ events, trace, lines: planLines, match }: ReplayInput): Replay {
  // ---- the plan
  const lines: RLine[] = planLines.map((p) => ({
    id: p.id, parentId: p.parentId, depth: 0, op: p.op.replace(/\s+/g, ' ').trim(), object: p.object ?? '', obj: p.obj,
    rows: p.rows, starts: p.starts, pw: p.pw, timeUs: p.timeUs, card: p.card, kids: [], parent: null,
    selfPw: 0, selfUs: 0, inactive: false, objSlot: -1, reads: [], treads: [], twrites: [],
  }))
  for (const l of lines) if (l.object && l.op.endsWith(' ' + l.object)) l.op = l.op.slice(0, -l.object.length - 1)
  const byId = new Map(lines.map((l) => [l.id, l]))
  for (const l of lines) {
    const p = l.parentId !== l.id ? byId.get(l.parentId) : undefined
    if (p) { l.parent = p; p.kids.push(l) }
  }
  const root = lines.find((l) => !l.parent) ?? null
  const setDepth = (l: RLine, d: number) => { l.depth = d; for (const k of l.kids) setDepth(k, d + 1) }
  if (root) setDepth(root, 0)
  const objects: { obj: number; name: string }[] = []
  for (const l of lines) {
    l.selfPw = l.pw - l.kids.reduce((s, k) => s + k.pw, 0)
    l.selfUs = Math.max(0, l.timeUs - l.kids.reduce((s, k) => s + k.timeUs, 0))
    l.inactive = l.starts === 0 && l.rows === 0
    if (l.obj > 0) {
      let k = objects.findIndex((o) => o.obj === l.obj)
      if (k < 0) { k = objects.length; objects.push({ obj: l.obj, name: l.object || `obj# ${l.obj}` }) }
      l.objSlot = k
    }
  }
  const work = lines.filter((l) => l.selfPw > 0).sort((a, b) => b.selfPw - a.selfPw)[0] ?? null
  const coordinator = lines.find((l) => l.op.startsWith('PX COORDINATOR')) ?? null
  const lineOfObj = (obj: number) => (obj > 0 ? lines.find((l) => l.obj === obj && !l.inactive) ?? lines.find((l) => l.obj === obj) ?? null : null)

  // ---- the clock: from the EXEC's start
  const own = trace.calls
  const exec = own.find((c) => c.kind === CallKind.exec)
  const t0 = exec ? exec.tim - exec.e : own.length ? own[0].tim - own[0].e : 0
  const ownDep = own.length ? own[0].dep : 0
  const parseUs = own.filter((c) => c.kind === CallKind.parse).reduce((s, c) => s + c.e, 0)
  const playIds = new Set(own.filter((c) => c.kind !== CallKind.parse).map((c) => c.id))
  const calls: RCall[] = own.filter((c) => playIds.has(c.id)).map((c) => ({ call: c, kind: c.kind, start: c.tim - c.e - t0, end: c.tim - t0, rows: c.kind === CallKind.fetch ? c.r : 0 }))

  // ---- the waits and the line each belongs to
  const waits: RWait[] = []
  trace.waits.forEach((tw, i) => {
    if (!playIds.has(tw.owner)) return
    const end = tw.tim - t0, start = end - tw.ela
    if (end < 0) return
    const ev = events[tw.event]
    const name = ev?.name ?? `event ${tw.event}`
    const w: RWait = { i, event: tw.event, name, kind: 'other', start, end, ela: tw.ela, obj: tw.obj, file: 0, block: 0, blocks: 0, line: null, traceLine: tw.line }
    if (ev && isBlockIO(ev)) { w.file = tw.p1; w.block = tw.p2; w.blocks = blocksParam(ev) && tw.p3 > 0 ? Math.min(tw.p3, MAX_WAIT_BLOCKS) : 1 }
    else if (ev && ev.p2Name === 'blocks' && tw.p2 > 0) w.blocks = Math.min(tw.p2, MAX_WAIT_BLOCKS) // db file parallel read: no address
    if (tw.dep > ownDep) w.kind = 'recursive'
    else if (/^SQL\*Net message from client/.test(name)) w.kind = 'client'
    else if (/^SQL\*Net/.test(name)) w.kind = 'net'
    else if (ev && isTempEvent(ev) && w.blocks) {
      w.kind = isWriteEvent(ev) ? 'twrite' : 'tread'
      w.line = work ?? root
      if (w.line) (w.kind === 'twrite' ? w.line.twrites : w.line.treads).push(w)
    } else if (w.blocks && (w.file > 0 || lineOfObj(tw.obj))) {
      // a block read or write: on the line of its object, else (an object no line names) only in the grid
      w.kind = ev && isWriteEvent(ev) ? 'write' : 'read'
      w.line = lineOfObj(tw.obj)
      if (w.kind === 'read' && w.line) w.line.reads.push(w)
    } else if (/^PX Deq: Execute Reply/.test(name) && coordinator) { w.kind = 'pxwait'; w.line = coordinator }
    waits.push(w)
  })
  waits.sort((a, b) => a.start - b.start || a.i - b.i)
  const D = Math.max(1, ...calls.map((c) => c.end), ...waits.filter((w) => w.kind !== 'client').map((w) => w.end))

  // ---- rows over time
  const fetchKnots: [number, number][] = [[0, 0]]
  let fetched = 0
  for (const c of calls) if (c.kind === CallKind.fetch && c.rows) { fetchKnots.push([c.end - 1, fetched]); fetched += c.rows; fetchKnots.push([c.end, fetched]) }
  const firstFetch = calls.find((c) => c.kind === CallKind.fetch && c.rows) ?? null
  const firstRow = firstFetch ? firstFetch.end : null
  type F = (t: number) => number
  const cumulative = (ws: RWait[]): F => {
    const k: [number, number][] = [[0, 0]]
    let s = 0
    for (const w of ws.slice().sort((a, b) => a.end - b.end)) { k.push([w.start, s]); s += w.blocks || 1; k.push([w.end, s]) }
    return (t) => valueAt(k, t) / s
  }
  const step = (at: number): F => (t) => (t >= at ? 1 : 0)
  const linear = (a: number, b: number): F => (t) => clamp((t - a) / Math.max(1, b - a), 0, 1)
  const contains = (a: RLine, b: RLine) => { for (let x: RLine | null = b; x; x = x.parent) if (x === a) return true; return false }
  const blockedAbove = (l: RLine) => {
    for (let x = l.parent; x; x = x.parent) if (BLOCKING.test(x.op) || (isHashJoin(x.op) && x.kids[0] && contains(x.kids[0], l))) return true
    return false
  }
  const leafReads = (l: RLine): RWait[] => {
    if (l.reads.length) return l.reads
    if (BLOCKING.test(l.op)) return []
    return (isHashJoin(l.op) ? l.kids.slice(1) : l.kids).flatMap(leafReads)
  }
  const memo = new Map<RLine, F>()
  const done = new Map<RLine, number>()
  const fracOf = (l: RLine): F => {
    const m = memo.get(l)
    if (m) return m
    memo.set(l, () => 0) // a cycle reads 0
    let f: F
    if (l === root && fetched) f = (t) => valueAt(fetchKnots, t) / fetched
    else if (l.inactive) f = () => 0
    else if (l.reads.length) f = cumulative(l.reads)
    else if (isHashJoin(l.op)) {
      const ws = [...l.treads, ...l.kids.slice(1).flatMap(leafReads)]
      f = ws.length ? cumulative(ws) : step(kidsDone(l))
    } else if (BLOCKING.test(l.op) && l.kids.length) {
      const at = kidsDone(l)
      const back = l.treads.filter((w) => w.start >= at)
      f = back.length ? cumulative(back) : step(at)
    } else if (l.kids.length) {
      const k0 = l.kids.find((k) => !k.inactive) ?? l.kids[0]
      f = fracOf(k0)
    } else if (blockedAbove(l)) f = linear(0, firstFetch ? firstFetch.start + (firstFetch.end - firstFetch.start) * 0.98 : D)
    else f = fetched ? (t) => valueAt(fetchKnots, t) / fetched : linear(0, D)
    memo.set(l, f)
    return f
  }
  const doneAt = (l: RLine): number => {
    const d = done.get(l)
    if (d !== undefined) return d
    done.set(l, D)
    const f = fracOf(l)
    let lo = 0, hi = D
    if (f(D) >= 0.9999) for (let i = 0; i < 48; i++) { const m = (lo + hi) / 2; if (f(m) >= 0.9999) hi = m; else lo = m }
    done.set(l, hi)
    return hi
  }
  function kidsDone(l: RLine): number {
    const ks = l.kids.filter((k) => !k.inactive)
    return ks.length ? Math.max(...ks.map(doneAt)) : 0
  }
  const rowsKnown = match.exact
  const fracAt = (l: RLine, t: number) => fracOf(l)(t)
  const rowsAt = (l: RLine, t: number) => {
    if (l === root && fetched) return valueAt(fetchKnots, t)
    return rowsKnown ? l.rows * fracOf(l)(t) : NaN
  }

  // ---- segments: what the process does at each moment
  const segs: Seg[] = []
  const pathBetween = (a: RLine | null, b: RLine | null): RLine[] => {
    if (!a || !b) return root ? [root] : []
    const up = (x: RLine) => { const r: RLine[] = []; for (let y: RLine | null = x; y; y = y.parent) r.push(y); return r }
    const A = up(a), B = up(b), inB = new Set(B), out: RLine[] = []
    for (const x of A) { out.push(x); if (inB.has(x)) { for (const y of B) { if (y === x) break; out.push(y) } break } }
    return out
  }
  const active = lines.filter((l) => !l.inactive)
  const selfSum = active.reduce((s, l) => s + l.selfUs, 0)
  const spread = selfSum > 0 ? new Map(active.filter((l) => l.selfUs / selfSum >= SPREAD_MIN).map((l) => [l, l.selfUs / selfSum])) : new Map<RLine, number>()
  const spreadMax = Math.max(0, ...spread.values())
  for (const c of calls) {
    const inCall = waits.filter((w) => w.kind !== 'recursive' && w.kind !== 'client' && !trace.waits[w.i].between && trace.waits[w.i].owner === c.call.id)
    const kids = trace.children.filter((k) => k.owner === c.call.id && k.dep === ownDep + 1)
      .map((k) => ({ a: k.tim - k.e - t0, b: k.tim - t0, call: k }))
    type Item = { a: number; b: number; w?: RWait; rec?: TraceCall }
    const items: Item[] = [...inCall.map((w) => ({ a: w.start, b: w.end, w })), ...kids.map((k) => ({ a: k.a, b: k.b, rec: k.call }))].sort((x, y) => x.a - y.a)
    const noLines = !inCall.some((w) => w.line)
    let t = c.start, prev: RLine | null = root
    const cpu = (a: number, b: number, next: RLine | null) => {
      if (b <= a) return
      if (noLines && spread.size > 1) segs.push({ a, b, type: 'cpu', call: c, lines: new Map([...spread].map(([l, v]) => [l, v / spreadMax])), spread: true })
      else segs.push({ a, b, type: 'cpu', call: c, lines: new Map(pathBetween(prev, next).map((l) => [l, 1])), spread: false })
    }
    for (const it of items) {
      if (it.b <= t) continue
      if (it.a > t) cpu(t, it.a, it.w?.line ?? prev)
      const a = Math.max(it.a, t)
      if (it.w) { segs.push({ a, b: it.b, type: 'wait', w: it.w }); if (it.w.line) prev = it.w.line }
      else segs.push({ a, b: it.b, type: 'recursive', call: it.rec! })
      t = it.b
    }
    cpu(t, c.end, root)
  }
  for (const w of waits) {
    const tw = trace.waits[w.i]
    if (w.kind === 'client') segs.push({ a: w.start, b: w.end, type: 'client', w })
    else if (tw.between && w.kind !== 'recursive') segs.push({ a: w.start, b: w.end, type: 'between', w })
  }
  segs.sort((x, y) => x.a - y.a)
  const segAt = (t: number): Seg | null => {
    let lo = 0, hi = segs.length - 1, best = -1
    while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m].a <= t) { best = m; lo = m + 1 } else hi = m - 1 }
    for (let i = best; i >= 0 && i >= best - 4; i--) if (segs[i].a <= t && t < segs[i].b) return segs[i]
    return null
  }

  // ---- chapters
  const chapters = chaptersOf(waits, calls, D)
  const chapterAt = (t: number) => chapters.find((c) => t >= c.a && t < c.b) ?? chapters[chapters.length - 1]

  // ---- the blocks touched
  const gridOf = (temp: boolean): Grid | null => {
    const ws = waits.filter((w) => w.file > 0 && (temp ? w.kind === 'twrite' || w.kind === 'tread' : w.kind === 'read' || w.kind === 'write'))
    if (!ws.length) return null
    const ranges = ws.map((w) => ({ a: fileKey(w.file, w.block), n: w.blocks, file: w.file, slot: w.line && !temp ? w.line.objSlot : -1 })).sort((x, y) => x.a - y.a)
    const cellOf = new Map<number, number>()
    const owner: number[] = []
    let n = 0, lastFile = -1
    for (const r of ranges) {
      if (lastFile >= 0 && r.file !== lastFile) { owner[n] = -2; n++ }
      lastFile = r.file
      for (let k = 0; k < r.n; k++) if (!cellOf.has(r.a + k)) { cellOf.set(r.a + k, n); owner[n] = r.slot; n++ }
    }
    return { temp, files: [...new Set(ranges.map((r) => r.file))], n, distinct: cellOf.size, cellOf, owner: Int16Array.from(owner) }
  }

  return {
    lines, root, match, rowsKnown, calls, waits, segs, chapters, data: gridOf(false), temp: gridOf(true), objects, D, t0, parseUs,
    fetchRows: fetched, firstRow, truncated: trace.truncated, px: !!coordinator,
    rowsAt, fracAt, doneAt, segAt, chapterAt,
  }
}

/** The cell of a wait's first block in a grid. */
export const cellOfWait = (g: Grid, w: RWait, k = 0): number | undefined => g.cellOf.get(fileKey(w.file, w.block + k))

/** Chapters over the waits on plan lines: runs of one key, each from where the previous one ended; short runs join the one before. */
export function chaptersOf(waits: readonly RWait[], calls: readonly RCall[], D: number): Chapter[] {
  const runs: { key: string; a: number; b: number }[] = []
  let prev = null as string | null
  for (const w of waits) {
    let k = prev
    if (w.kind === 'read' && w.line) k = `read:${w.line.id}`
    else if (w.kind === 'tread' && w.line) k = `back:${w.line.id}`
    else if ((w.kind === 'twrite' || w.kind === 'write') && w.line) k = prev?.startsWith('read:') ? prev : `spill:${w.line.id}`
    if (!k) continue
    const last = runs[runs.length - 1]
    if (last && last.key === k) last.b = w.end
    else runs.push({ key: k, a: w.start, b: w.end })
    prev = k
  }
  if (!runs.length) runs.push({ key: 'all', a: 0, b: D })
  runs.forEach((r, i) => { r.a = i ? runs[i - 1].b : 0 })
  runs[runs.length - 1].b = D
  const merged: typeof runs = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && (r.b - r.a < D * CHAPTER_MIN || last.key === r.key)) last.b = r.b
    else merged.push({ ...r })
  }
  if (merged.length > 1 && merged[0].b - merged[0].a < D * CHAPTER_MIN) { merged[1].a = 0; merged.shift() }
  return merged.map((r, i) => ({ ...r, i, label: chapterLabel(waits, calls, r.a, r.b) }))
}

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const dur = (us: number) => (us >= 1e6 ? `${(us / 1e6).toFixed(2)} s` : us >= 1e3 ? `${(us / 1e3).toFixed(1)} ms` : `${Math.round(us)} µs`)

/** What a chapter holds, in fragments: blocks read per object, TEMP writes and reads, fetches and rows; else its longest events. */
export function chapterLabel(waits: readonly RWait[], calls: readonly RCall[], a: number, b: number): string {
  const ws = waits.filter((w) => w.start >= a && w.end <= b)
  const parts: string[] = []
  const reads = new Map<RLine, number>()
  for (const w of ws) if (w.kind === 'read' && w.line) reads.set(w.line, (reads.get(w.line) ?? 0) + w.blocks)
  for (const [l, n] of [...reads].sort((x, y) => y[1] - x[1]).slice(0, 3)) parts.push(`${l.object || l.op} ${int(n)} block${n === 1 ? '' : 's'} read`)
  const tw = ws.filter((w) => w.kind === 'twrite'), tr = ws.filter((w) => w.kind === 'tread')
  if (tw.length) parts.push(`${tw[0].line?.op ?? ''} ${int(tw.length)} TEMP write${tw.length === 1 ? '' : 's'} (${dur(tw.reduce((s, w) => s + w.ela, 0))})`.trim())
  if (tr.length) parts.push(`${tr[0].line?.op ?? ''} ${int(tr.length)} TEMP read${tr.length === 1 ? '' : 's'} of ${int(new Set(tr.map((w) => fileKey(w.file, w.block))).size)} blocks`.trim())
  if (!parts.length) {
    const by = new Map<string, { n: number; us: number }>()
    for (const w of ws) if (w.kind !== 'client' && w.kind !== 'net') { const e = by.get(w.name) ?? { n: 0, us: 0 }; e.n++; e.us += w.ela; by.set(w.name, e) }
    for (const [ev, e] of [...by].sort((x, y) => y[1].us - x[1].us).slice(0, 2)) parts.push(`${ev} ×${int(e.n)} (${dur(e.us)})`)
  }
  const f = calls.filter((c) => c.kind === CallKind.fetch && c.end > a && c.end <= b)
  const rows = f.reduce((s, c) => s + c.rows, 0)
  if (f.length > 1) parts.push(`${int(f.length)} fetches, ${int(rows)} row${rows === 1 ? '' : 's'}`)
  else if (rows) parts.push(`${int(rows)} row${rows === 1 ? '' : 's'} to the client`)
  if (!parts.length) parts.push('CPU')
  return parts.join(' · ')
}

export function valueAt(knots: readonly (readonly [number, number])[], t: number): number {
  if (t <= knots[0][0]) return knots[0][1]
  let lo = 0, hi = knots.length - 1
  if (t >= knots[hi][0]) return knots[hi][1]
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (knots[m][0] <= t) lo = m; else hi = m }
  const [ta, va] = knots[lo], [tb, vb] = knots[hi]
  return tb === ta ? vb : va + (vb - va) * ((t - ta) / (tb - ta))
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

// ================================================================ layout

export type Pt = readonly [number, number]
export interface NodeBox { x: number; y: number; w: number; h: number; out: Pt; in: Pt; dock: Pt }
export interface GridBox { grid: Grid; x: number; y: number; w: number; h: number; cell: number; cols: number }
export interface StageLayout {
  mode: 'cards' | 'tree'
  width: number
  height: number
  nodes: Map<RLine, NodeBox>
  client: NodeBox
  /** where rows leave the root for the client */
  rootOut: Pt
  grids: GridBox[]
}

/** Cards for small plans (≤ 5 lines, depth ≤ 2, ≤ 3 leaves, room for them), DBMS_XPLAN rows for the rest. */
export function stageLayout(r: Pick<Replay, 'lines' | 'root' | 'data' | 'temp'>, width: number): StageLayout {
  const W = Math.max(320, width)
  const maxDepth = Math.max(0, ...r.lines.map((l) => l.depth))
  const leaves = r.lines.filter((l) => !l.kids.length).length
  const grids = [r.data, r.temp].filter((g): g is Grid => !!g)
  if (r.root && r.lines.length <= 5 && maxDepth <= 2 && leaves <= 3 && W >= 560) return cardsLayout(r.lines, r.root, grids, W, maxDepth)
  return treeLayout(r.lines, grids, W)
}

function cardsLayout(lines: readonly RLine[], root: RLine, grids: Grid[], W: number, maxDepth: number): StageLayout {
  const nw = clamp(W * 0.185, 124, 178), nh = 74, cw = clamp(W * 0.13, 92, 120)
  const xr = W - 12 - cw - Math.max(52, W * 0.085) - nw
  const stepX = maxDepth ? Math.min((xr - 12) / maxDepth, nw + 140) : 0
  const leaves: RLine[] = []
  const walk = (l: RLine) => { if (!l.kids.length) leaves.push(l); l.kids.forEach(walk) }
  walk(root)
  const top = 28, bottom = 206, slot = (bottom - top) / Math.max(1, leaves.length)
  const yOf = new Map<RLine, number>()
  leaves.forEach((l, i) => yOf.set(l, top + slot * (i + 0.5)))
  const ym = (l: RLine): number => { const v = yOf.get(l); if (v !== undefined) return v; const m = l.kids.reduce((s, k) => s + ym(k), 0) / l.kids.length; yOf.set(l, m); return m }
  const nodes = new Map<RLine, NodeBox>()
  for (const l of lines) {
    const x = xr - l.depth * stepX, y = ym(l) - nh / 2
    nodes.set(l, { x, y, w: nw, h: nh, out: [x + nw, y + nh / 2], in: [x, y + nh / 2], dock: [x + nw / 2, y + nh] })
  }
  const rn = nodes.get(root)!
  const cy = rn.y + nh / 2 - 32
  const client: NodeBox = { x: W - 12 - cw, y: cy, w: cw, h: 64, out: [W - 12, cy + 32], in: [W - 12 - cw, cy + 32], dock: [W - 12 - cw / 2, cy + 64] }
  const height = grids.length ? 360 : 236
  return { mode: 'cards', width: W, height, nodes, client, rootOut: [rn.x + nw, rn.y + nh / 2], grids: placeGrids(grids, 12, W - 12, 268, 82, 'row') }
}

function treeLayout(lines: readonly RLine[], grids: Grid[], W: number): StageLayout {
  const rh = lines.length > 14 ? 24 : 28
  const treeR = grids.length ? Math.max(330, Math.round(W * 0.6)) : W - 8
  const y0 = 46
  const height = Math.max(grids.length ? 300 : 120, y0 + lines.length * rh + 14)
  const nodes = new Map<RLine, NodeBox>()
  // dump order is the DBMS_XPLAN order (parents before children, siblings by position)
  lines.forEach((l, i) => {
    const x = 8 + Math.min(l.depth, 12) * 16, y = y0 + i * rh, h = rh - 5
    nodes.set(l, { x, y, w: treeR - x, h, out: [x, y + h / 2], in: [x + 8, y + h], dock: [treeR, y + h / 2] })
  })
  const client: NodeBox = { x: 8, y: 8, w: treeR - 8, h: 26, out: [16, 8], in: [16, 34], dock: [treeR, 21] }
  const first = lines.length ? nodes.get(lines[0])! : null
  return { mode: 'tree', width: W, height, nodes, client, rootOut: first ? [16, first.y] : [16, y0], grids: placeGrids(grids, treeR + 18, W - 8, 8, height - 12, 'col') }
}

function placeGrids(grids: Grid[], x0: number, x1: number, y0: number, hTotal: number, dir: 'row' | 'col'): GridBox[] {
  if (!grids.length) return []
  const box = (g: Grid, x: number, y: number, w: number, h: number): GridBox => {
    const inner = h - 16
    let cell = clamp(Math.floor(Math.sqrt((w * inner) / Math.max(1, g.n))), 2, 14)
    while (cell > 2 && Math.ceil(g.n / Math.floor(w / cell)) * cell > inner) cell--
    return { grid: g, x, y: y + 16, w, h: inner, cell, cols: Math.max(1, Math.floor(w / cell)) }
  }
  if (dir === 'row') {
    const gap = 18, sw = (x1 - x0 - gap * (grids.length - 1)) / grids.length
    return grids.map((g, i) => box(g, x0 + i * (sw + gap), y0, sw, hTotal))
  }
  const gap = 10, tot = grids.reduce((s, g) => s + Math.sqrt(g.n), 0)
  let y = y0
  return grids.map((g) => {
    const h = Math.max(46, (hTotal - gap * (grids.length - 1)) * (Math.sqrt(g.n) / tot))
    const b = box(g, x0, y, x1 - x0, h)
    y += h + gap
    return b
  })
}

/** The centre of a cell of a placed grid. */
export function cellCenter(b: GridBox, cell: number): Pt {
  return [b.x + (cell % b.cols) * b.cell + b.cell / 2, b.y + Math.floor(cell / b.cols) * b.cell + b.cell / 2]
}

/** A point k ∈ [0, 1] on the way rows take from a child to its parent: a curve between cards, an elbow along the tree guides. */
export function edgePoint(lay: StageLayout, child: RLine, parent: RLine, k: number): Pt {
  const a = lay.nodes.get(child)!.out, b = lay.nodes.get(parent)!.in
  const [x0, y0] = a, [x1, y1] = b
  if (lay.mode === 'cards') {
    const mx = (x0 + x1) / 2, u = 1 - k
    return [u * u * u * x0 + 3 * u * u * k * mx + 3 * u * k * k * mx + k * k * k * x1, u * u * u * y0 + 3 * u * u * k * y0 + 3 * u * k * k * y1 + k * k * k * y1]
  }
  const l1 = Math.abs(x0 - x1), l2 = Math.abs(y0 - y1), d = k * (l1 + l2)
  return d <= l1 ? [x0 - d, y0] : [x1, y0 - (d - l1)]
}

export type LaneRow =
  | { kind: 'cpu'; label: string; y: number }
  | { kind: 'line'; line: RLine; label: string; y: number }
  | { kind: 'recursive' | 'other' | 'client'; label: string; y: number }
export interface LanesLayout { rows: LaneRow[]; lh: number; head: number; gx: number; w: number; height: number }

/** The lanes under the stage: CPU, a lane per plan line, recursive SQL and other waits when there are any, the client. */
export function lanesLayout(r: Pick<Replay, 'lines' | 'waits' | 'segs'>, width: number): LanesLayout {
  const rows: LaneRow[] = [{ kind: 'cpu', label: 'CPU', y: 0 }]
  for (const l of r.lines) rows.push({ kind: 'line', line: l, label: `${l.id} ${l.op}${l.object ? ' ' + l.object : ''}`, y: 0 })
  if (r.segs.some((s) => s.type === 'recursive')) rows.push({ kind: 'recursive', label: 'recursive SQL', y: 0 })
  if (r.waits.some((w) => (w.kind === 'other' || w.kind === 'write') && !w.line) || r.segs.some((s) => s.type === 'between')) rows.push({ kind: 'other', label: 'other waits', y: 0 })
  rows.push({ kind: 'client', label: 'client', y: 0 })
  const lh = rows.length > 14 ? 16 : 20, head = 22, axis = 18
  rows.forEach((row, i) => { row.y = head + i * lh })
  const gx = clamp(width * 0.27, 120, 230)
  return { rows, lh, head, gx, w: Math.max(40, width - gx - 8), height: head + rows.length * lh + axis }
}
