// Derived aggregations computed in the browser from the fact columns.
import type { TraceDoc } from './doc'
import type { ID, StmtStats } from './types'
import { CallKind, NONE } from './types'
import { groupBy, sumOver } from './groupby'
import { roleOfClass, roleLabel, type Role } from '../components/colors'
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
      const ex: Execution = { cursor: c.cursor[i], execNo: c.execNo[i], exec: i, fetches: 0, startTim: c.tim[i] - c.e[i], endTim: c.tim[i],
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

/** Timeline buckets by role (CPU of top-level calls at completion time; waits by class). */
export function timelineByRole(doc: TraceDoc, bucketUs: number, callFilter: RowFilter, waitFilter: RowFilter) {
  const roles: Role[] = ['cpu', 'userio', 'sysio', 'commit', 'concurrency', 'network', 'other', 'idle']
  const base = doc.span.firstTim
  const span = doc.spanUs()
  if (bucketUs <= 0 || span <= 0) return { roles, starts: [] as number[], series: new Map<Role, Float64Array>() }
  const n = Math.floor(span / bucketUs) + 1
  const series = new Map<Role, Float64Array>()
  for (const r of roles) series.set(r, new Float64Array(n))
  const c = doc.calls
  const cpu = series.get('cpu')!
  for (let i = 0; i < c.n; i++) {
    if (c.parent[i] !== NONE || !c.tim[i]) continue
    if (callFilter && !callFilter(i)) continue
    // spread CPU over the call's duration so long calls do not spike one bucket
    const e = c.e[i], cv = c.c[i]
    if (e <= bucketUs || cv === 0) { cpu[Math.min(n - 1, Math.max(0, Math.floor((c.tim[i] - base) / bucketUs)))] += cv; continue }
    const b0 = Math.max(0, Math.floor((c.tim[i] - e - base) / bucketUs)), b1 = Math.min(n - 1, Math.floor((c.tim[i] - base) / bucketUs))
    const per = cv / (b1 - b0 + 1)
    for (let b = b0; b <= b1; b++) cpu[b] += per
  }
  const w = doc.waits
  const roleOfEvent = doc.events.map((ev) => roleOfClass(ev.class, ev.idle))
  for (let i = 0; i < w.n; i++) {
    if (!w.tim[i]) continue
    if (waitFilter && !waitFilter(i)) continue
    const arr = series.get(roleOfEvent[w.event[i]])!
    const ela = w.ela[i]
    if (ela <= bucketUs) { arr[Math.min(n - 1, Math.max(0, Math.floor((w.tim[i] - base) / bucketUs)))] += ela; continue }
    const b0 = Math.max(0, Math.floor((w.tim[i] - ela - base) / bucketUs)), b1 = Math.min(n - 1, Math.floor((w.tim[i] - base) / bucketUs))
    const per = ela / (b1 - b0 + 1)
    for (let b = b0; b <= b1; b++) arr[b] += per
  }
  const starts = Array.from({ length: n }, (_, i) => base + i * bucketUs)
  return { roles, starts, series }
}

export function pickBucket(spanUs: number, target = 300): number {
  for (const b of [1000, 10000, 100000, 500000, 1e6, 5e6, 10e6, 60e6, 300e6, 600e6, 3600e6]) if (spanUs / b <= target) return b
  return Math.ceil(spanUs / target)
}

export { sumOver }
