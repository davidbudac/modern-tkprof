// Derived aggregations computed in the browser from the fact columns.
import type { TraceDoc } from './doc'
import type { ID, StmtStats } from './types'
import { CallKind, NONE } from './types'
import { groupBy, sumOver } from './groupby'
import { roleOfClass, roleLabel, roleOrder, type Role } from '../components/colors'
import type { Segment } from '../components/ProfileBar'

export type RowFilter = ((i: number) => boolean) | undefined

/** Sum of ela per event over the filtered waits. */
export function waitsByEvent(doc: TraceDoc, filter: RowFilter) {
  const w = doc.waits
  return groupBy({ n: w.n, filter, key: (i) => w.event[i], value: (i) => w.ela[i] })
}

/** Segments by color role for a set of calls (CPU) and waits. */
export function segmentsFor(doc: TraceDoc, opts: { cpuUs: number; totalUs: number; waitFilter: RowFilter }): Segment[] {
  const byEvent = waitsByEvent(doc, opts.waitFilter)
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
  if (!doc.hasFacts) {
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
  return segmentsFor(doc, { cpuUs: topLevelCpu(doc, callFilter), totalUs, waitFilter })
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
}

/** EXEC + following FETCH calls of a statement, in file order. */
export function executions(doc: TraceDoc, sid: ID): Execution[] {
  const c = doc.calls
  const ids = doc.callsByStmt.get(sid)
  const out: Execution[] = []
  const idx = new Map<string, number>()
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k]
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

export interface BindRow { pos: number; type: string; value: string; isNull: boolean; noDef: boolean; dump: boolean; mal: number }

export function bindsOf(doc: TraceDoc, set: ID): BindRow[] {
  if (set === NONE || set >= doc.bindSets.n) return []
  const first = doc.bindSets.first[set], n = doc.bindSets.count[set]
  const b = doc.binds
  const out: BindRow[] = []
  for (let i = first; i < first + n; i++) {
    const f = b.flags[i]
    out.push({ pos: b.pos[i], type: b.type[i], value: b.value[i], isNull: !!(f & 1), noDef: !!(f & 2), dump: !!(f & 4), mal: b.mal[i] })
  }
  return out
}

/** Short "k=v k=v" preview of a bind set. */
export function bindPreview(doc: TraceDoc, set: ID, max = 60): string {
  const parts = bindsOf(doc, set).map((b) => `:${b.pos}=${b.noDef ? '(dup)' : b.isNull ? 'NULL' : b.dump ? '<dump>' : b.value}`)
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
  const base = doc.span.firstTim
  const span = doc.spanUs()
  if (bucketUs <= 0 || span <= 0) return { starts: [] as number[], series: [] as TimelineSeries[] }
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

export { sumOver }

/** One row of the response-time ledger: CPU, a wait event, or the unaccounted remainder. */
export interface ComponentRow { label: string; role: Role; us: number; count: number; maxUs: number; event: ID; kind: 'cpu' | 'wait' | 'unaccounted' }

/** Response-time components (per event, not per class) for the current filters, largest first. */
export function componentRows(doc: TraceDoc, callFilter: RowFilter, waitFilter: RowFilter, totalUs: number): ComponentRow[] {
  const out: ComponentRow[] = []
  let accounted = 0
  if (!doc.hasFacts) {
    for (const r of doc.stats.profile.rows) {
      if (r.kind === 'unaccounted') continue
      const role: Role = r.kind === 'cpu' ? 'cpu' : roleOfClass(r.class ?? '', r.kind === 'idle')
      const ev = r.kind === 'cpu' ? NONE : doc.events.findIndex((e) => e.name === r.component)
      out.push({ label: r.component, role, us: r.us, count: r.count, maxUs: r.maxUs, event: ev, kind: r.kind === 'cpu' ? 'cpu' : 'wait' })
      accounted += r.us
    }
  } else {
    const cpu = topLevelCpu(doc, callFilter)
    out.push({ label: 'CPU', role: 'cpu', us: cpu, count: 0, maxUs: 0, event: NONE, kind: 'cpu' })
    accounted += cpu
    for (const a of waitsByEvent(doc, waitFilter)) {
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
const NROLES = roleOrder.length

/**
 * Wait time per statement and color role, one pass over the waits (cached per document).
 * Row = statement id, column = roleOrder index.
 */
export function statementRoleUs(doc: TraceDoc): Float64Array {
  let t = roleTotalsCache.get(doc)
  if (t) return t
  t = new Float64Array(doc.statements.length * NROLES)
  const w = doc.waits
  const roleIdx = doc.events.map((ev) => roleOrder.indexOf(roleOfClass(ev.class, ev.idle)))
  for (let i = 0; i < w.n; i++) {
    const s = w.stmt[i]
    if (s < 0) continue
    t[s * NROLES + roleIdx[w.event[i]]] += w.ela[i]
  }
  roleTotalsCache.set(doc, t)
  return t
}

/** Cheap profile of one statement from the cached role totals: CPU + waits by role (no unaccounted). */
export function quickSegments(doc: TraceDoc, st: StmtStats): Segment[] {
  const segs: Segment[] = [{ role: 'cpu', label: 'CPU', us: st.cpu }]
  if (!doc.hasFacts) {
    if (st.waitUs > 0) segs.push({ role: 'other', label: 'Waits', us: st.waitUs })
    if (st.idleUs > 0) segs.push({ role: 'idle', label: 'Idle', us: st.idleUs })
    return segs
  }
  const t = statementRoleUs(doc)
  for (let r = 1; r < NROLES; r++) {
    const us = t[st.id * NROLES + r]
    if (us > 0) segs.push({ role: roleOrder[r], label: roleLabel[roleOrder[r]], us })
  }
  return segs
}

/** The role a statement's time mostly went to (CPU, a wait class, or idle). */
export function dominantRole(doc: TraceDoc, st: StmtStats): Role {
  let best: Role = 'cpu', bestUs = -1
  for (const s of quickSegments(doc, st)) if (s.us > bestUs) { best = s.role; bestUs = s.us }
  return best
}

/** Top wait events of one statement, with the object they were on when every wait names the same one. */
export function statementWaits(doc: TraceDoc, sid: ID, max = 6): { event: ID; name: string; role: Role; us: number; count: number; maxUs: number; obj: number; maxLine: number }[] {
  if (!doc.hasFacts) return []
  const w = doc.waits
  const ids = doc.waitsByStmt.get(sid)
  const byEvent = groupBy({ n: ids.length, key: (k) => w.event[ids[k]], value: (k) => w.ela[ids[k]] })
  return byEvent.slice(0, max).map((a) => {
    const ev = doc.events[a.key]
    let obj = -1, maxLine = 0, maxEla = -1
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k]
      if (w.event[i] !== a.key) continue
      if (w.ela[i] > maxEla) { maxEla = w.ela[i]; maxLine = w.line[i] }
      const o = w.obj[i]
      if (obj === -1) obj = o; else if (obj !== o) obj = -2
    }
    return { event: a.key, name: ev?.name ?? '?', role: roleOfClass(ev?.class ?? '', ev?.idle ?? false), us: a.sum, count: a.count, maxUs: a.max, obj: obj > 0 ? obj : -1, maxLine }
  })
}

export interface Span2 { start: number; end: number }

/** Time intervals a statement was executing (its calls, merged; gaps shorter than `gapUs` closed). */
export function statementSpans(doc: TraceDoc, sid: ID, gapUs: number): Span2[] {
  const c = doc.calls
  const ids = doc.callsByStmt.get(sid)
  const iv: Span2[] = []
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k]
    if (!c.tim[i]) continue
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
