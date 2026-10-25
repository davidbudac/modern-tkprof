// Statement statistics of a scope, computed from the fact columns: the in-browser twin of the engine's
// `GET api/statements` (internal/analyze `Statements` over the rows in scope). Same StmtStats objects as `doc.stats.statements`,
// one per statement id in id order, zero numbers for a statement with no call in scope.
import type { TraceDoc } from './doc'
import type { CallStats, ID, Link, StmtStats } from './types'
import { CallKind } from './types'
import { callFilter, type Scope } from '../state/store'

const zeroCalls = (): CallStats => ({
  count: 0, misses: 0, cpu: 0, elapsed: 0, disk: 0, query: 0, current: 0, rows: 0, waitUs: 0, idleUs: 0,
  selfCpu: 0, selfElapsed: 0, selfDisk: 0, selfQuery: 0, selfCurrent: 0,
})

function addStats(a: CallStats, o: CallStats): void {
  a.count += o.count; a.misses += o.misses; a.cpu += o.cpu; a.elapsed += o.elapsed; a.disk += o.disk; a.query += o.query
  a.current += o.current; a.rows += o.rows; a.waitUs += o.waitUs; a.idleUs += o.idleUs
  a.selfCpu += o.selfCpu; a.selfElapsed += o.selfElapsed; a.selfDisk += o.selfDisk; a.selfQuery += o.selfQuery; a.selfCurrent += o.selfCurrent
}

/** The slave process a PX context ran in (its pid, else its file), as analyze.PXProcess. */
const pxProcess = (doc: TraceDoc, ctx: ID): string => { const c = doc.contexts[ctx]; return c?.process ? `pid ${c.process}` : `file ${c?.fileIdx ?? 0}` }

/**
 * StmtStats of every statement over the calls in `scope` (window and effective contexts; the idle toggle is for waits only and
 * does not apply). Needs the fact columns. Links, plans and cursor counts of the whole trace are kept for the statements that
 * have calls; errors are counted in the scope's contexts.
 */
export function scopedStatements(doc: TraceDoc, scope: Scope): StmtStats[] {
  const base = doc.stats.statements
  const out: StmtStats[] = base.map((b) => ({
    id: b.id, parse: zeroCalls(), exec: zeroCalls(), fetch: zeroCalls(), close: zeroCalls(), other: zeroCalls(), total: zeroCalls(), allCalls: zeroCalls(),
    elapsed: 0, selfElapsed: 0, cpu: 0, selfCpu: 0, waitUs: 0, idleUs: 0, childUs: 0, executions: 0, hardParses: 0,
    cursors: b.cursors, errors: 0, minDepth: b.minDepth, maxDepth: b.minDepth, topLevel: false,
    firstWallUs: 0, lastWallUs: 0, firstTim: 0, lastTim: 0, parents: null, children: null, plans: b.plans, planHashes: b.planHashes,
  }))
  const c = doc.calls
  const keep = callFilter({ doc, window: scope.window, contexts: scope.contexts })
  const seenDep = new Uint8Array(out.length)
  const edges = new Map<number, Link>() // parent * N + child
  const nStmt = out.length
  const pxProcs = new Map<ID, Set<string>>()
  const add = (cs: CallStats, i: number) => {
    cs.count++; cs.misses += c.mis[i]; cs.cpu += c.c[i]; cs.elapsed += c.e[i]; cs.disk += c.p[i]; cs.query += c.cr[i]; cs.current += c.cu[i]; cs.rows += c.r[i]
    cs.waitUs += c.waitEla[i]; cs.idleUs += c.idleEla[i]
    cs.selfCpu += c.selfC[i]; cs.selfElapsed += c.selfE[i]; cs.selfDisk += c.selfP[i]; cs.selfQuery += c.selfCR[i]; cs.selfCurrent += c.selfCU[i]
  }
  for (let i = 0; i < c.n; i++) {
    if (keep && !keep(i)) continue
    const sid = c.stmt[i]
    const s = out[sid]
    if (!s) continue
    const ctx = doc.contexts[c.ctx[i]]
    if (ctx?.px && ctx.parent != null && ctx.parent >= 0) { // an attached PX slave: kept out of the coordinator's figures
      s.pxEla = (s.pxEla ?? 0) + c.selfE[i]
      s.pxCpu = (s.pxCpu ?? 0) + c.selfC[i]
      let set = pxProcs.get(sid)
      if (!set) pxProcs.set(sid, (set = new Set()))
      set.add(pxProcess(doc, c.ctx[i]))
      continue
    }
    switch (c.kind[i]) {
      case CallKind.parse: add(s.parse, i); if (c.mis[i] > 0) s.hardParses += c.mis[i]; break
      case CallKind.exec: add(s.exec, i); s.executions++; break
      case CallKind.fetch: add(s.fetch, i); break
      case CallKind.close: add(s.close, i); break
      default: add(s.other, i)
    }
    add(s.allCalls, i)
    const dep = c.dep[i]
    if (!seenDep[sid]) { seenDep[sid] = 1; s.minDepth = dep; s.maxDepth = dep } else { if (dep < s.minDepth) s.minDepth = dep; if (dep > s.maxDepth) s.maxDepth = dep }
    const parent = c.parent[i]
    if (parent < 0 || c.stmt[parent] !== sid) { s.elapsed += c.e[i]; s.cpu += c.c[i] }
    s.selfElapsed += c.selfE[i]; s.selfCpu += c.selfC[i]; s.waitUs += c.waitEla[i]; s.idleUs += c.idleEla[i]
    if (parent < 0) s.topLevel = true
    else if (c.stmt[parent] !== sid) {
      const ps = c.stmt[parent]
      const key = ps * nStmt + sid
      let l = edges.get(key)
      if (!l) edges.set(key, (l = { statement: sid, calls: 0, elapsed: 0 }))
      l.calls++; l.elapsed += c.e[i]
      out[ps].childUs += c.e[i]
    }
    const tim = c.tim[i]
    if (tim !== 0) {
      if (s.firstTim === 0 || tim - c.e[i] < s.firstTim) { s.firstTim = tim - c.e[i]; s.firstWallUs = doc.wallOf(tim) ? doc.wallOf(tim) - c.e[i] : 0 }
      if (tim > s.lastTim) { s.lastTim = tim; s.lastWallUs = doc.wallOf(tim) }
    }
  }
  for (const [sid, procs] of pxProcs) out[sid].pxSessions = procs.size
  const keys = [...edges.keys()].sort((a, b) => a - b) // parent id, then child id
  for (const key of keys) {
    const l = edges.get(key)!
    const ps = Math.floor(key / nStmt), cs = l.statement
    ;(out[ps].children ??= []).push({ ...l })
    ;(out[cs].parents ??= []).push({ statement: ps, calls: l.calls, elapsed: l.elapsed })
  }
  for (const s of out) {
    addStats(s.total, s.parse); addStats(s.total, s.exec); addStats(s.total, s.fetch)
    s.children?.sort((a, b) => b.elapsed - a.elapsed)
    s.parents?.sort((a, b) => b.elapsed - a.elapsed)
  }
  for (const e of doc.errors) {
    if (e.statement < 0 || !out[e.statement]) continue
    if (scope.contexts && !scope.contexts.has(e.context)) continue
    out[e.statement].errors++
  }
  return out
}
