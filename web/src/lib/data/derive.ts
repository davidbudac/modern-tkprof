// Derived aggregations computed in the browser from the fact columns.
import type { TraceDoc } from './doc'
import type { ID, StmtStats } from './types'
import { CallKind, NONE } from './types'
import { groupIndex, groupOf, kindGroups, type KindGroup } from './callkinds'
import { groupBy, sumOver, type Agg } from './groupby'
import { roleOfClass, roleLabel, roleOrder, type Role } from '../components/colors'
import type { Segment } from '../components/ProfileBar'

export type RowFilter = ((i: number) => boolean) | undefined

/** Sum of ela per event over the filtered waits. */
export function waitsByEvent(doc: TraceDoc, filter: RowFilter) {
  const w = doc.waits
  return groupBy({ n: w.n, filter, key: (i) => w.event[i], value: (i) => w.ela[i] })
}

/** CPU of the top-level calls and the waits per event of some scope (a window, some contexts), whoever computed it. */
/** CPU and waits per event of a scope, and (`api/profile`, `LocalSource`) the scope's response time (`response.ts`). */
export interface ScopeProfile { cpuUs: number; events: Agg[]; responseUs?: number; wallUs?: number; sessions?: number }

/** Segments by color role for a set of calls (CPU) and waits. */
export function segmentsFor(doc: TraceDoc, opts: { cpuUs: number; totalUs: number; waitFilter: RowFilter }): Segment[] {
  return segmentsOfProfile(doc, { cpuUs: opts.cpuUs, events: waitsByEvent(doc, opts.waitFilter) }, opts.totalUs)
}

/** Segments by color role from the CPU and the waits per event. */
export function segmentsOfProfile(doc: TraceDoc, p: ScopeProfile, totalUs: number): Segment[] {
  const byEvent = p.events
  const opts = { cpuUs: p.cpuUs, totalUs }
  const byRole = new Map<Role, { us: number; count: number }>()
  let waitUs = 0
  for (const a of byEvent) {
    const ev = doc.events[a.key]
    const role = roleOfClass(ev?.class ?? '', ev?.idle ?? false)
    const acc = byRole.get(role) ?? { us: 0, count: 0 }
    acc.us += a.sum; acc.count += a.count
    byRole.set(role, acc)
    waitUs += a.sum
  }
  const segs: Segment[] = [{ role: 'cpu', label: 'CPU', us: opts.cpuUs }]
  for (const role of ['userio', 'sysio', 'commit', 'concurrency', 'network', 'other', 'idle'] as Role[]) {
    const a = byRole.get(role)
    if (a) segs.push({ role, label: roleLabel[role], us: a.us, count: a.count })
  }
  const un = opts.totalUs - opts.cpuUs - waitUs
  if (un > 0) segs.push({ role: 'unaccounted', label: 'Unaccounted', us: un })
  return segs
}

/** CPU of top-level calls (children are included in their parents). */
export function topLevelCpu(doc: TraceDoc, filter: RowFilter): number {
  const c = doc.calls
  let s = 0
  for (let i = 0; i < c.n; i++) if (c.parent[i] === NONE && (!filter || filter(i))) s += c.c[i]
  return s
}

/** Profile segments for the whole trace (falls back to server stats without facts). */
export function traceSegments(doc: TraceDoc, callFilter: RowFilter, waitFilter: RowFilter, totalUs: number): Segment[] {
  return traceSegmentsFrom(doc, doc.hasFacts ? { cpuUs: topLevelCpu(doc, callFilter), events: waitsByEvent(doc, waitFilter) } : null, totalUs)
}

/** Profile segments from a scope profile; null = none available, use the document's whole-trace stats. */
export function traceSegmentsFrom(doc: TraceDoc, profile: ScopeProfile | null, totalUs: number): Segment[] {
  if (!profile) {
    const p = doc.stats.profile
    const segs: Segment[] = []
    const byRole = new Map<Role, Segment>()
    for (const r of p.rows) {
      if (r.kind === 'cpu') { segs.push({ role: 'cpu', label: 'CPU', us: r.us }); continue }
      if (r.kind === 'unaccounted') continue
      const role = roleOfClass(r.class ?? '', r.kind === 'idle')
      const s = byRole.get(role) ?? { role, label: roleLabel[role], us: 0, count: 0 }
      s.us += r.us; s.count = (s.count ?? 0) + r.count
      byRole.set(role, s)
    }
    for (const role of ['userio', 'sysio', 'commit', 'concurrency', 'network', 'other', 'idle'] as Role[]) { const s = byRole.get(role); if (s) segs.push(s) }
    if (p.unaccountedUs > 0) segs.push({ role: 'unaccounted', label: 'Unaccounted', us: p.unaccountedUs })
    return segs
  }
  return segmentsOfProfile(doc, profile, totalUs)
}

/** Profile segments for one statement: response time = elapsed + idle between its calls. */
export function statementSegments(doc: TraceDoc, st: StmtStats): Segment[] {
  const sid = st.id
  const w = doc.waits
  return segmentsFor(doc, { cpuUs: st.cpu, totalUs: st.elapsed + st.idleUs, waitFilter: (i) => w.stmt[i] === sid })
}

export interface Execution {
  line: number // trace line of the EXEC call
  cursor: ID
  execNo: number
  exec: number // call index
  fetches: number
  startTim: number
  endTim: number
  e: number
  c: number
  p: number
  cr: number
  cu: number
  r: number
  waitEla: number
  idleEla: number
  bindSet: ID
  ctx: ID
  /** the bind values, when the server sent them with the row; else read them with bindsOf(doc, bindSet) */
  binds?: BindRow[]
}

/**
 * EXEC + following FETCH calls of a statement, in file order. With `keep` (a call-row predicate: the scope's `callFilter`)
 * only the calls it lets through count: an execution exists when its EXEC call is kept and sums the kept FETCH calls
 * (the server's `EachExecutionIn`).
 */
export function executions(doc: TraceDoc, sid: ID, keep?: (call: number) => boolean): Execution[] {
  const c = doc.calls
  const ids = doc.callsByStmt.get(sid)
  const out: Execution[] = []
  const idx = new Map<string, number>()
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k]
    if (keep && !keep(i)) continue
    const kind = c.kind[i]
    if (kind === CallKind.exec) {
      const ex: Execution = { line: c.line[i], cursor: c.cursor[i], execNo: c.execNo[i], exec: i, fetches: 0, startTim: c.tim[i] - c.e[i], endTim: c.tim[i],
        e: c.e[i], c: c.c[i], p: c.p[i], cr: c.cr[i], cu: c.cu[i], r: c.r[i], waitEla: c.waitEla[i], idleEla: c.idleEla[i], bindSet: c.bindSet[i], ctx: c.ctx[i] }
      idx.set(`${ex.cursor}:${ex.execNo}`, out.length)
      out.push(ex)
    } else if (kind === CallKind.fetch) {
      const j = idx.get(`${c.cursor[i]}:${c.execNo[i]}`)
      if (j === undefined) continue
      const ex = out[j]
      ex.fetches++; ex.e += c.e[i]; ex.c += c.c[i]; ex.p += c.p[i]; ex.cr += c.cr[i]; ex.cu += c.cu[i]; ex.r += c.r[i]
      ex.waitEla += c.waitEla[i]; ex.idleEla += c.idleEla[i]
      if (c.tim[i] > ex.endTim) ex.endTim = c.tim[i]
    }
  }
  return out
}

/** The kind column of the bind table (model.BindKind). */
export const BIND_KINDS = ['string', 'number', 'date', 'timestamp', 'interval', 'raw', 'rowid', 'other'] as const
export type BindKind = (typeof BIND_KINDS)[number]

/** `kind` and `typed` are optional so older documents and servers still fit: typed is the ISO 8601 form of a date / timestamp / interval (P3DT4H5M6.789S) or the base-64 ROWID. */
export interface BindRow { pos: number; type: string; value: string; isNull: boolean; noDef: boolean; dump: boolean; mal: number; kind?: BindKind; typed?: string }

export function bindsOf(doc: TraceDoc, set: ID): BindRow[] {
  if (set === NONE || set >= doc.bindSets.n) return []
  const first = doc.bindSets.first[set], n = doc.bindSets.count[set]
  const b = doc.binds
  const out: BindRow[] = []
  for (let i = first; i < first + n; i++) {
    const f = b.flags[i]
    out.push({ pos: b.pos[i], type: b.type[i], value: b.value[i], isNull: !!(f & 1), noDef: !!(f & 2), dump: !!(f & 4), mal: b.mal[i], kind: BIND_KINDS[b.kind[i]], typed: b.typed?.[i] || undefined })
  }
  return out
}

/** Short "k=v k=v" preview of a bind set. */
export function bindPreview(doc: TraceDoc, set: ID, max = 60): string {
  return previewOfBinds(bindsOf(doc, set), max)
}

export function previewOfBinds(binds: BindRow[], max = 60): string {
  const parts = binds.map((b) => `:${b.pos}=${b.noDef ? '(dup)' : b.isNull ? 'NULL' : b.dump ? '<dump>' : b.value}`)
  const s = parts.join(' ')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export interface TimelineSeries { key: string; label: string; role: Role; values: Float64Array }

/**
 * Timeline buckets: CPU of top-level calls (spread over the call's duration) plus waits,
 * either folded into wait classes or one series per event. In event mode the top
 * `topEvents` events by time get their own series; the rest fold into "Other events".
 */
export function timeline(doc: TraceDoc, bucketUs: number, callFilter: RowFilter, waitFilter: RowFilter, by: 'class' | 'event' = 'class', topEvents = 10) {
  const raw = timelineRaw(doc, bucketUs, callFilter, waitFilter)
  return raw ? foldTimeline(doc, raw, by, topEvents) : { starts: [] as number[], series: [] as TimelineSeries[] }
}

/** CPU and wait time per bucket and event, before they are folded into series. */
export interface TimelineRaw {
  bucketUs: number
  starts: number[] // tim of each bucket
  cpu: Float64Array
  perEvent: (Float64Array | undefined)[] // by event id
  totals: Float64Array // by event id
}

/** The buckets of `timeline()` before folding; null when the span or the bucket is unknown. */
export function timelineRaw(doc: TraceDoc, bucketUs: number, callFilter: RowFilter, waitFilter: RowFilter): TimelineRaw | null {
  const base = doc.span.firstTim
  const span = doc.spanUs()
  if (bucketUs <= 0 || span <= 0) return null
  const n = Math.floor(span / bucketUs) + 1
  const add = (arr: Float64Array, tim: number, dur: number, v: number) => {
    if (dur <= bucketUs || v === 0) { arr[Math.min(n - 1, Math.max(0, Math.floor((tim - base) / bucketUs)))] += v; return }
    const b0 = Math.max(0, Math.floor((tim - dur - base) / bucketUs)), b1 = Math.min(n - 1, Math.floor((tim - base) / bucketUs))
    const per = v / (b1 - b0 + 1)
    for (let b = b0; b <= b1; b++) arr[b] += per
  }
  const c = doc.calls
  const cpu = new Float64Array(n)
  for (let i = 0; i < c.n; i++) {
    if (c.parent[i] !== NONE || !c.tim[i]) continue
    if (callFilter && !callFilter(i)) continue
    add(cpu, c.tim[i], c.e[i], c.c[i])
  }
  const w = doc.waits
  const perEvent: (Float64Array | undefined)[] = new Array(doc.events.length)
  const totals = new Float64Array(doc.events.length)
  for (let i = 0; i < w.n; i++) {
    if (!w.tim[i]) continue
    if (waitFilter && !waitFilter(i)) continue
    const ev = w.event[i]
    const arr = (perEvent[ev] ??= new Float64Array(n))
    add(arr, w.tim[i], w.ela[i], w.ela[i])
    totals[ev] += w.ela[i]
  }
  // Oracle's `c` can exceed `e` and CPU is spread evenly over a call's duration, so a bucket's CPU
  // plus waits can pass the bucket's own length. A bucket cannot be more than 100 % busy: CPU is
  // clamped to the time the waits leave free (and waits scaled down if they alone overflow), so
  // stacks and the % axis never exceed 100 %.
  for (let b = 0; b < n; b++) {
    let waitUs = 0
    for (const arr of perEvent) if (arr) waitUs += arr[b]
    if (waitUs > bucketUs) { // a short wait straddling a boundary is counted whole in one bucket
      const k = bucketUs / waitUs
      for (const arr of perEvent) if (arr) arr[b] *= k
      waitUs = bucketUs
    }
    cpu[b] = Math.min(cpu[b], Math.max(0, bucketUs - waitUs))
  }
  const starts = Array.from({ length: n }, (_, i) => base + i * bucketUs)
  return { bucketUs, starts, cpu, perEvent, totals }
}

/** Folds the raw buckets into series: waits by class, or the top events and the rest. */
export function foldTimeline(doc: TraceDoc, raw: TimelineRaw, by: 'class' | 'event' = 'class', topEvents = 10) {
  const { starts, cpu, perEvent, totals } = raw
  const n = cpu.length
  const series: TimelineSeries[] = [{ key: 'cpu', label: roleLabel.cpu, role: 'cpu', values: cpu }]
  const roleOf = doc.events.map((ev) => roleOfClass(ev.class, ev.idle))
  const used = doc.events.map((_, e) => e).filter((e) => totals[e] > 0)
  if (by === 'class') {
    const byRole = new Map<Role, Float64Array>()
    for (const e of used) {
      const arr = byRole.get(roleOf[e]) ?? new Float64Array(n)
      byRole.set(roleOf[e], arr)
      const src = perEvent[e]!
      for (let b = 0; b < n; b++) arr[b] += src[b]
    }
    for (const r of roleOrder) { const arr = byRole.get(r); if (arr) series.push({ key: r, label: roleLabel[r], role: r, values: arr }) }
    return { starts, series }
  }
  const ranked = [...used].sort((x, y) => totals[y] - totals[x])
  const top = ranked.slice(0, topEvents).sort((x, y) => roleOrder.indexOf(roleOf[x]) - roleOrder.indexOf(roleOf[y]) || totals[y] - totals[x])
  for (const e of top) series.push({ key: `ev${e}`, label: doc.events[e].name, role: roleOf[e], values: perEvent[e]! })
  if (ranked.length > topEvents) {
    const rest = new Float64Array(n)
    for (const e of ranked.slice(topEvents)) { const src = perEvent[e]!; for (let b = 0; b < n; b++) rest[b] += src[b] }
    series.push({ key: 'rest', label: `Other events (${ranked.length - topEvents})`, role: 'unaccounted', values: rest })
  }
  return { starts, series }
}

/**
 * Timeline/pivot bucket size in µs. Same rule as `analyze.BucketForSpan`
 * (internal/analyze/pivot.go) - keep the two identical: the smallest of
 * 1 ms, 10 ms, 100 ms, 1 s, 10 s, 1 min, 10 min, 1 h with floor(span/bucket)
 * <= 400, else span/400; 0 when the span is unknown.
 */
export function pickBucket(spanUs: number): number {
  if (spanUs <= 0) return 0
  for (const b of [1000, 10000, 100000, 1e6, 10e6, 60e6, 600e6, 3600e6]) if (Math.floor(spanUs / b) <= 400) return b
  return Math.floor(spanUs / 400)
}

/**
 * The chart's bucket for a selection spanning `selUs` of a trace of `wholeUs`: the bucket `pickBucket` picks for the selection,
 * raised until the whole trace still fits in `maxBuckets` (the buckets are counted from the trace's start; the engine
 * refuses more than `analyze.MaxBuckets` = 100000).
 */
export function selectionBucket(wholeUs: number, selUs: number, maxBuckets = 20000): number {
  let b = pickBucket(selUs)
  if (b <= 0) return pickBucket(wholeUs)
  for (const step of [1000, 10000, 100000, 1e6, 10e6, 60e6, 600e6, 3600e6]) {
    if (step >= b && Math.floor(wholeUs / b) > maxBuckets) b = step
  }
  return Math.floor(wholeUs / b) > maxBuckets ? Math.ceil(wholeUs / maxBuckets) : b
}

export { sumOver }

/** One row of the response-time ledger: CPU, a wait event, or the unaccounted remainder. */
export interface ComponentRow { label: string; role: Role; us: number; count: number; maxUs: number; event: ID; kind: 'cpu' | 'wait' | 'unaccounted' }

/** Response-time components (per event, not per class) for the current filters, largest first. */
export function componentRows(doc: TraceDoc, callFilter: RowFilter, waitFilter: RowFilter, totalUs: number): ComponentRow[] {
  return componentRowsFrom(doc, doc.hasFacts ? { cpuUs: topLevelCpu(doc, callFilter), events: waitsByEvent(doc, waitFilter) } : null, totalUs)
}

/** The ledger from a scope profile; null = none available, use the document's whole-trace stats. */
export function componentRowsFrom(doc: TraceDoc, profile: ScopeProfile | null, totalUs: number): ComponentRow[] {
  const out: ComponentRow[] = []
  let accounted = 0
  if (!profile) {
    for (const r of doc.stats.profile.rows) {
      if (r.kind === 'unaccounted') continue
      const role: Role = r.kind === 'cpu' ? 'cpu' : roleOfClass(r.class ?? '', r.kind === 'idle')
      const ev = r.kind === 'cpu' ? NONE : doc.events.findIndex((e) => e.name === r.component)
      out.push({ label: r.component, role, us: r.us, count: r.count, maxUs: r.maxUs, event: ev, kind: r.kind === 'cpu' ? 'cpu' : 'wait' })
      accounted += r.us
    }
  } else {
    const cpu = profile.cpuUs
    out.push({ label: 'CPU', role: 'cpu', us: cpu, count: 0, maxUs: 0, event: NONE, kind: 'cpu' })
    accounted += cpu
    for (const a of profile.events) {
      const ev = doc.events[a.key]
      out.push({ label: ev?.name ?? `event ${a.key}`, role: roleOfClass(ev?.class ?? '', ev?.idle ?? false), us: a.sum, count: a.count, maxUs: a.max, event: a.key, kind: 'wait' })
      accounted += a.sum
    }
  }
  out.sort((a, b) => b.us - a.us)
  const un = totalUs - accounted
  if (un !== 0) out.push({ label: 'unaccounted', role: 'unaccounted', us: un, count: 0, maxUs: 0, event: NONE, kind: 'unaccounted' })
  return out
}

const roleTotalsCache = new WeakMap<TraceDoc, Float64Array>()
export const NROLES = roleOrder.length

/**
 * Wait time per statement and color role, one pass over the waits (cached per document).
 * Row = statement id, column = roleOrder index.
 */
export function statementRoleUs(doc: TraceDoc, keep?: (wait: number) => boolean): Float64Array {
  let t = keep ? undefined : roleTotalsCache.get(doc)
  if (t) return t
  t = new Float64Array(doc.statements.length * NROLES)
  const w = doc.waits
  const roleIdx = doc.events.map((ev) => roleOrder.indexOf(roleOfClass(ev.class, ev.idle)))
  for (let i = 0; i < w.n; i++) {
    const s = w.stmt[i]
    if (s < 0 || (keep && !keep(i))) continue
    t[s * NROLES + roleIdx[w.event[i]]] += w.ela[i]
  }
  if (!keep) roleTotalsCache.set(doc, t)
  return t
}

/**
 * Cheap profile of one statement from the role totals (`statementRoleUs`, or the server's equivalent
 * as `table`): CPU + waits by role (no unaccounted). Without totals (or `fromStats`): CPU, waits and idle from the stats.
 */
export function quickSegments(doc: TraceDoc, st: StmtStats, table?: Float64Array | null, fromStats = false): Segment[] {
  const segs: Segment[] = [{ role: 'cpu', label: 'CPU', us: st.cpu }]
  // `fromStats`: the numbers are those of a scope, the role totals are of the whole trace
  const t = fromStats ? null : table ?? (doc.hasFacts ? statementRoleUs(doc) : null)
  if (!t) {
    if (st.waitUs > 0) segs.push({ role: 'other', label: 'Waits', us: st.waitUs })
    if (st.idleUs > 0) segs.push({ role: 'idle', label: 'Idle', us: st.idleUs })
    return segs
  }
  for (let r = 1; r < NROLES; r++) {
    const us = t[st.id * NROLES + r]
    if (us > 0) segs.push({ role: roleOrder[r], label: roleLabel[roleOrder[r]], us })
  }
  return segs
}

/** The role a statement's time mostly went to (CPU, a wait class, or idle). */
export function dominantRole(doc: TraceDoc, st: StmtStats, table?: Float64Array | null): Role {
  let best: Role = 'cpu', bestUs = -1
  for (const s of quickSegments(doc, st, table)) if (s.us > bestUs) { best = s.role; bestUs = s.us }
  return best
}

export interface StmtWait { event: ID; name: string; role: Role; us: number; count: number; maxUs: number; obj: number; maxLine: number; maxFile?: number }

/** Top wait events of one statement, with the object they were on when every wait names the same one. */
export function statementWaits(doc: TraceDoc, sid: ID, max = 6, keep?: (wait: number) => boolean): StmtWait[] {
  if (!doc.hasFacts) return []
  const w = doc.waits
  const all = doc.waitsByStmt.get(sid)
  const ids = keep ? all.filter((i) => keep(i)) : all
  const byEvent = groupBy({ n: ids.length, key: (k) => w.event[ids[k]], value: (k) => w.ela[ids[k]] })
  return byEvent.slice(0, max).map((a) => {
    const ev = doc.events[a.key]
    let obj = -1, maxLine = 0, maxCtx: ID = -1, maxEla = -1
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k]
      if (w.event[i] !== a.key) continue
      if (w.ela[i] > maxEla) { maxEla = w.ela[i]; maxLine = w.line[i]; maxCtx = w.ctx[i] }
      const o = w.obj[i]
      if (obj === -1) obj = o; else if (obj !== o) obj = -2
    }
    return { event: a.key, name: ev?.name ?? '?', role: roleOfClass(ev?.class ?? '', ev?.idle ?? false), us: a.sum, count: a.count, maxUs: a.max, obj: obj > 0 ? obj : -1, maxLine, maxFile: doc.fileOfCtx(maxCtx) }
  })
}

export interface Span2 { start: number; end: number }

/** Time intervals a statement was executing (its calls, merged; gaps shorter than `gapUs` closed). */
export function statementSpans(doc: TraceDoc, sid: ID, gapUs: number, keep?: (call: number) => boolean): Span2[] {
  const c = doc.calls
  const ids = doc.callsByStmt.get(sid)
  const iv: Span2[] = []
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k]
    if (!c.tim[i] || (keep && !keep(i))) continue
    iv.push({ start: c.tim[i] - c.e[i], end: c.tim[i] })
  }
  iv.sort((a, b) => a.start - b.start)
  const out: Span2[] = []
  for (const s of iv) {
    const last = out[out.length - 1]
    if (last && s.start - last.end <= gapUs) { if (s.end > last.end) last.end = s.end } else out.push({ ...s })
  }
  return out
}

export interface PhaseSpan2 extends Span2 {
  /** the dominant call group of the stretch */
  kind: KindGroup
  /** elapsed µs per call group: parse, exec, fetch, close, other */
  us: number[]
}

/**
 * Phase segments of one statement's calls (the engine's analyze.segmentPhases / StmtPhasesOn; keep them identical,
 * web/src/lib/data/testdata/phases-case.json is the shared case). Calls, sorted by start, join the current segment when
 * they begin at most `gapUs` after its end and either continue its dominant group, or the segment is still narrower
 * than `gapUs`, or the call is shorter than `gapUs`: segments stay about `gapUs` wide while long runs of one phase stay exact.
 */
export function statementPhases(doc: TraceDoc, sid: ID, gapUs: number, keep?: (call: number) => boolean): PhaseSpan2[] {
  const c = doc.calls
  const ids = doc.callsByStmt.get(sid)
  const calls: { start: number; end: number; e: number; g: number }[] = []
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k]
    if (!c.tim[i] || (keep && !keep(i))) continue
    calls.push({ start: c.tim[i] - c.e[i], end: c.tim[i], e: c.e[i], g: groupIndex[groupOf(c.kind[i])] })
  }
  calls.sort((a, b) => a.start - b.start || a.end - b.end || a.g - b.g)
  const dominant = (us: number[], first: number) => {
    let best = 0, bi = first
    for (let g = 0; g < us.length; g++) if (us[g] > best) { best = us[g]; bi = g }
    return bi
  }
  const out: PhaseSpan2[] = []
  let cur: PhaseSpan2 | null = null
  let first = 0
  const flush = () => { if (cur) { cur.kind = kindGroups[dominant(cur.us, first)].id; out.push(cur) } }
  for (const x of calls) {
    if (cur && x.start - cur.end <= gapUs && (x.g === dominant(cur.us, first) || cur.end - cur.start < gapUs || x.e < gapUs)) {
      if (x.end > cur.end) cur.end = x.end
      cur.us[x.g] += x.e
      continue
    }
    flush()
    cur = { start: x.start, end: x.end, kind: 'other', us: [0, 0, 0, 0, 0] }
    cur.us[x.g] = x.e
    first = x.g
  }
  flush()
  return out
}
