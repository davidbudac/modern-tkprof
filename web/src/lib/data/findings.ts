// The findings of a scope, computed from the fact columns: the in-browser twin of the engine's `GET api/findings`
// (internal/analyze `FindingsOn`, the rules of findings.go over the rows in scope). With no narrowing it returns
// `doc.stats.findings` (findings.test.ts checks it on documents written by `mtkprof json`), so every summary, number and
// evidence row is formatted as the Go rules format it.
import type { TraceDoc } from './doc'
import type { EvidenceRow, Finding, ID, Severity, StmtStats } from './types'
import { CallKind, NONE } from './types'
import { callFilter, waitFilter, type Scope } from '../state/store'
import { scopedStatements } from './stmtstats'
import { scopeResponse } from './response'

// ---- thresholds (analyze.Thresholds; doc.stats.findingsConfig has the effective ones) ----

export const DEFAULT_THRESHOLDS = {
  outlier_factor: 3.0, outlier_min_us: 100_000, outlier_min_execs: 3,
  hard_parse_ratio: 0.5, hard_parse_min_execs: 10, hard_parse_min_total: 20,
  parse_exec_ratio: 0.9, parse_exec_min_execs: 10,
  hard_close_share: 0.5, hard_close_min_parses: 3, hard_close_min_count: 10,
  think_time_share: 0.30, in_call_idle_share: 0.10,
  small_fetch_rows: 20, small_fetch_min_fetches_per_exec: 3, small_fetch_min_fetches: 100, small_fetch_min_rows: 1000,
  commit_per_dml_ratio: 0.5, commit_min_count: 10,
  round_trips_per_row: 0.5, round_trips_min: 100,
  max_evidence_rows: 10, bind_preview_max: 80,
  serious_share: 0.25, serious_min_us: 1_000_000, notable_share: 0.05, notable_min_us: 100_000,
  serious_count: 10_000, notable_count: 1_000,
}
export type Thresholds = typeof DEFAULT_THRESHOLDS

// ---- Go formatting (fmt verbs the rules use) ----

/** %.<d>f: as JS toFixed, but an exact tie rounds to even like Go (toFixed rounds it away from zero). */
export function goFixed(x: number, d: number): string {
  const t = x * 2 ** (d + 1)
  if (Number.isInteger(t) && Math.abs(t) % 2 === 1) { // x * 10^d is exactly n + 0.5
    const p = 10 ** d, a = Math.abs(x) * p, lo = Math.floor(a)
    const even = lo % 2 === 0 ? lo : lo + 1
    return (x < 0 && even !== 0 ? '-' : '') + (even / p).toFixed(d)
  }
  return x.toFixed(d)
}

/** %g with the shortest precision: exponent form below 1e-4 and from 1e6 on (Go decides with precision 6). */
export function goG(x: number): string {
  if (x === 0 || !Number.isFinite(x)) return String(x)
  const [m, e] = x.toExponential().split('e')
  const n = Number(e)
  if (n < -4 || n >= 6) return `${m}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`
  return String(x)
}

/** analyze.fmtUs: microseconds as us, ms or s (ASCII only). */
export function fmtUsGo(us: number): string {
  if (us < 1000 && us > -1000) return `${us} us`
  if (us < 1_000_000 && us > -1_000_000) return `${goFixed(us / 1e3, 1)} ms`
  return `${goFixed(us / 1e6, 3)} s`
}

const pct = (part: number, whole: number) => goFixed((100 * part) / whole, 0)

// ---- inputs ----

interface Exec {
  cursor: ID; execNo: number; exec: number; bindSet: ID
  elapsed: number; rows: number; disk: number; fetches: number[]
}

interface IdleSplit { us: number; n: Map<ID, number>; byEvent: Map<ID, number>; byStmt: Map<ID, number> }
const newSplit = (): IdleSplit => ({ us: 0, n: new Map(), byEvent: new Map(), byStmt: new Map() })
const bump = (m: Map<ID, number>, k: ID, v: number) => m.set(k, (m.get(k) ?? 0) + v)

const STMT_KINDS = ['sql', 'unknown', 'commit', 'rollback', 'lob', 'rpc', 'parse-error']
const SEV_RANK: Record<Severity, number> = { serious: 0, notable: 1, info: 2 }

/**
 * The findings over the rows of `scope` (window and effective contexts; the idle toggle does not apply: the idle-time rules
 * always count idle waits), most severe first. Needs the fact columns. Thresholds: the document's (`findingsConfig`).
 */
export function scopedFindings(doc: TraceDoc, scope: Pick<Scope, 'window' | 'contexts'>): Finding[] {
  const th: Thresholds = { ...DEFAULT_THRESHOLDS, ...(doc.stats.findingsConfig as Partial<Thresholds>) }
  const stats = scopedStatements(doc, { window: scope.window, contexts: scope.contexts, files: null, includeIdle: true })
  const nStmt = doc.statements.length
  const c = doc.calls, w = doc.waits
  const keepCall = callFilter({ doc, window: scope.window, contexts: scope.contexts })
  const keepWait = waitFilter({ doc, window: scope.window, contexts: scope.contexts, includeIdle: true })
  const pxChild = (ctx: ID) => { const x = doc.contexts[ctx]; return !!(x?.px && x.parent != null && x.parent >= 0) }

  // calls in scope
  const missUs = new Float64Array(nStmt)
  const closes = Array.from({ length: nStmt }, () => [0, 0, 0, 0])
  const byStmt: Exec[][] = Array.from({ length: nStmt }, () => [])
  const execIdx = new Map<string, number>()
  let topRows = 0, cpu = 0
  for (let i = 0; i < c.n; i++) {
    if (keepCall && !keepCall(i)) continue
    const kind = c.kind[i]
    if (c.parent[i] === NONE && (kind === CallKind.exec || kind === CallKind.fetch)) topRows += c.r[i]
    if (pxChild(c.ctx[i])) continue
    if (c.parent[i] === NONE) cpu += c.c[i]
    const sid = c.stmt[i]
    if (sid < 0 || sid >= nStmt) continue
    if (kind === CallKind.parse && c.mis[i] > 0) missUs[sid] += c.e[i]
    else if (kind === CallKind.close && c.type[i] < 4) closes[sid][c.type[i]]++
    else if (kind === CallKind.exec) {
      execIdx.set(`${c.cursor[i]}:${c.execNo[i]}`, byStmt[sid].length)
      byStmt[sid].push({ cursor: c.cursor[i], execNo: c.execNo[i], exec: i, bindSet: c.bindSet[i], elapsed: c.e[i], rows: c.r[i], disk: c.p[i], fetches: [] })
    } else if (kind === CallKind.fetch) {
      const j = execIdx.get(`${c.cursor[i]}:${c.execNo[i]}`)
      const e = j === undefined ? undefined : byStmt[sid][j]
      if (e && e.cursor === c.cursor[i]) { e.fetches.push(i); e.elapsed += c.e[i]; e.rows += c.r[i]; e.disk += c.p[i] }
    }
  }

  // waits in scope
  const think = newSplit(), inCall = newSplit()
  const evUs = new Float64Array(doc.events.length), evN = new Float64Array(doc.events.length)
  let waitUs = 0, idleUs = 0
  for (let i = 0; i < w.n; i++) {
    if (keepWait && !keepWait(i)) continue
    const fl = w.flags[i], isIdle = !!(fl & 2), idle = !!(fl & 3), ev = w.event[i], ela = w.ela[i]
    if (!pxChild(w.ctx[i])) {
      if (idle) idleUs += ela; else waitUs += ela
      if (ev >= 0 && ev < evUs.length) { evUs[ev] += ela; evN[ev]++ }
    }
    if (!idle) continue
    let a = think
    const call = w.call[i], tim = w.tim[i]
    if (isIdle && call !== NONE && call < c.n && tim !== 0) {
      if (!(c.flags[call] & 2) && c.tim[call] !== 0 && tim > c.tim[call] - c.e[call] && tim <= c.tim[call]) a = inCall
    }
    a.us += ela
    if (doc.events[ev]?.idle) { bump(a.n, ev, 1); bump(a.byEvent, ev, ela) }
    if (w.stmt[i] !== NONE) bump(a.byStmt, w.stmt[i], ela)
  }
  let total = scopeResponse(doc, scope).responseUs // Σ session spans (analyze.ResponseOf), never below the ledger's sum
  if (cpu + waitUs + idleUs > total) total = cpu + waitUs + idleUs

  const r = new Rules(doc, stats, th, total, { missUs, closes, byStmt, think, inCall, evUs, evN, topRows, keepTx: txFilter(scope) })
  return r.run()
}

function txFilter(scope: Pick<Scope, 'window' | 'contexts'>) {
  return (ctx: ID, tim: number) => {
    if (scope.contexts && !scope.contexts.has(ctx)) return false
    const win = scope.window
    if (win && (tim > win.endTim || tim < win.startTim)) return false
    return true
  }
}

interface Inputs {
  missUs: Float64Array
  closes: number[][]
  byStmt: Exec[][]
  think: IdleSplit
  inCall: IdleSplit
  evUs: Float64Array
  evN: Float64Array
  topRows: number
  keepTx: (ctx: ID, tim: number) => boolean
}

// ---- the rules (internal/analyze/findings.go) ----

function row(label: string, value: string): EvidenceRow {
  return { label, value, statement: NONE, cursor: NONE, call: NONE }
}
function stmtRow(sid: ID, label: string, value: string): EvidenceRow {
  return { ...row(label, value), statement: sid }
}
/** The JSON of an EvidenceRow leaves execNo, line and us out when 0 (omitempty). */
function fin(r: EvidenceRow): EvidenceRow {
  if (!r.execNo) delete r.execNo
  if (!r.line) delete r.line
  if (!r.us) delete r.us
  return r
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return 0
  return n % 2 === 1 ? s[(n - 1) / 2] : Math.trunc((s[n / 2 - 1] + s[n / 2]) / 2)
}

/** keys of m by descending value (ties by id), values > 0 only, at most k */
function topIDs(m: Map<ID, number>, k: number): ID[] {
  const ids = [...m.keys()].filter((id) => (m.get(id) ?? 0) > 0)
  ids.sort((a, b) => (m.get(b)! - m.get(a)!) || a - b)
  return ids.slice(0, k)
}

const isDML = (oct: number) => oct === 2 || oct === 6 || oct === 7 || oct === 189

class Rules {
  private out: Finding[] = []
  constructor(private doc: TraceDoc, private stats: StmtStats[], private th: Thresholds, private total: number, private in_: Inputs) {}

  run(): Finding[] {
    this.outliers(); this.planChanges(); this.hardParses(); this.parsePerExec(); this.hardCloses()
    this.thinkTime(); this.inCallIdle(); this.smallFetches(); this.commitPerRow(); this.roundTrips()
    return this.out.sort((a, b) =>
      (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (b.impactUs - a.impactUs) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) || (a.statement - b.statement))
  }

  private add(f: Omit<Finding, 'evidence'> & { evidence?: EvidenceRow[] }) {
    this.out.push({ ...f, evidence: (f.evidence ?? []).map(fin) })
  }

  private timeSeverity(impact: number, total: number): Severity {
    const share = total > 0 ? impact / total : 0
    if (share >= this.th.serious_share && impact >= this.th.serious_min_us) return 'serious'
    if (share >= this.th.notable_share && impact >= this.th.notable_min_us) return 'notable'
    return 'info'
  }
  private countSeverity(n: number): Severity {
    if (n >= this.th.serious_count) return 'serious'
    if (n >= this.th.notable_count) return 'notable'
    return 'info'
  }
  private atLeast(s: Severity, floor: Severity): Severity { return SEV_RANK[s] > SEV_RANK[floor] ? floor : s }

  private label(sid: ID): string {
    const st = this.doc.statements[sid]
    return st.sqlId ? st.sqlId : `(${STMT_KINDS[st.kind] ?? '?'})`
  }
  private isSQL(sid: ID): boolean { const k = this.doc.statements[sid].kind; return k === 0 || k === 1 }

  private bindPreview(set: ID): string {
    const d = this.doc
    if (set === NONE || set < 0 || set >= d.bindSets.n) return ''
    const b = d.binds, first = d.bindSets.first[set], n = d.bindSets.count[set]
    const parts: string[] = []
    for (let j = first; j < first + n; j++) {
      const f = b.flags[j]
      if (f & 2) continue // no definition
      if (f & 1) parts.push(`:${b.pos[j]}=NULL`)
      else if (f & 4) parts.push(`:${b.pos[j]}=<dump>`)
      else parts.push(`:${b.pos[j]}=${b.value[j]}`)
    }
    const s = parts.join(' ')
    const bytes = new TextEncoder().encode(s)
    if (bytes.length <= this.th.bind_preview_max) return s
    let cut = this.th.bind_preview_max - 3
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--
    return new TextDecoder().decode(bytes.subarray(0, cut)) + '...'
  }

  private outliers() {
    const th = this.th, d = this.doc
    for (const s of this.stats) {
      if (s.executions < th.outlier_min_execs) continue
      const ex = this.in_.byStmt[s.id]
      if (ex.length < th.outlier_min_execs) continue
      const med = median(ex.map((e) => e.elapsed))
      const hits: Exec[] = []
      let excess = 0
      for (const e of ex) {
        if (e.elapsed > th.outlier_factor * med && e.elapsed > th.outlier_min_us) { hits.push(e); excess += e.elapsed - med }
      }
      if (hits.length === 0) continue
      hits.sort((a, b) => b.elapsed - a.elapsed)
      const worst = hits[0].elapsed
      const evidence: EvidenceRow[] = []
      for (let k = 0; k < hits.length; k++) {
        const e = hits[k]
        if (k === th.max_evidence_rows) { evidence.push(row('...', `${hits.length - k} more outlier executions`)); break }
        let v = `${fmtUsGo(e.elapsed)}  ${e.rows} rows  ${e.disk} disk  ${e.fetches.length} fetches  cursor at line ${d.cursors[e.cursor]?.line ?? 0}`
        const b = this.bindPreview(e.bindSet)
        if (b !== '') v += '  binds ' + b
        evidence.push({ ...stmtRow(s.id, `exec ${e.execNo}`, v), cursor: e.cursor, execNo: e.execNo, call: e.exec, line: d.calls.line[e.exec], us: e.elapsed })
      }
      this.add({
        rule: 'outlier-executions', title: 'Outlier executions', statement: s.id, impactUs: excess, severity: this.timeSeverity(excess, this.total),
        summary: `${this.label(s.id)}: ${hits.length} of ${ex.length} executions over ${goG(th.outlier_factor)}x the median ${fmtUsGo(med)}; slowest ${fmtUsGo(worst)} (${goFixed(worst / Math.max(med, 1), 0)}x); ${fmtUsGo(excess)} over the median in total`,
        evidence,
      })
    }
  }

  private planChanges() {
    const d = this.doc, th = this.th
    interface Agg { execs: number; elapsed: number; dumps: number; line: number; firstLine: number }
    for (const s of this.stats) {
      const agg = new Map<number, Agg>()
      const order: number[] = []
      const get = (h: number, line: number) => {
        let a = agg.get(h)
        if (!a) { a = { execs: 0, elapsed: 0, dumps: 0, line: 0, firstLine: line }; agg.set(h, a); order.push(h) }
        return a
      }
      for (const pid of s.plans ?? []) {
        const p = d.plans[pid]
        if (!p || p.planHash === 0) continue
        const a = get(p.planHash, p.line)
        a.dumps++; a.line = p.line
      }
      if ((s.planHashes?.length ?? 0) < 2 && s.executions < 2) continue
      if (s.executions > 1) {
        for (const e of this.in_.byStmt[s.id]) {
          const plh = d.calls.plh[e.exec]
          if (plh === 0) continue
          const a = get(plh, d.calls.line[e.exec])
          a.execs++; a.elapsed += e.elapsed
        }
      }
      if (agg.size < 2) continue
      order.sort((a, b) => agg.get(a)!.firstLine - agg.get(b)!.firstLine)
      let sev: Severity = 'notable'
      let minAvg = -1, maxAvg = 0
      for (const h of order) {
        const a = agg.get(h)!
        if (a.execs === 0) continue
        const avg = a.elapsed / a.execs
        if (minAvg < 0 || avg < minAvg) minAvg = avg
        if (avg > maxAvg) maxAvg = avg
      }
      if (minAvg > 0 && maxAvg >= th.outlier_factor * minAvg && s.elapsed >= th.notable_min_us) sev = 'serious'
      let summary = `${this.label(s.id)}: ${order.length} plans (plan hash ${order.map(String).join(', ')})`
      if (minAvg > 0 && maxAvg > minAvg) summary += `; slowest plan ${goFixed(maxAvg / minAvg, 1)}x the fastest per execution`
      const evidence = order.map((h) => {
        const a = agg.get(h)!
        const parts: string[] = []
        if (a.execs > 0) parts.push(`${a.execs} executions, avg ${fmtUsGo(Math.trunc(a.elapsed / a.execs))}`)
        parts.push(a.dumps > 0 ? `${a.dumps} STAT dumps, last at line ${a.line}` : 'no STAT dump')
        return { ...stmtRow(s.id, `plan ${h}`, parts.join('; ')), line: a.dumps > 0 ? a.line : a.firstLine, us: a.elapsed }
      })
      this.add({ rule: 'plan-change', title: 'Plan change', statement: s.id, severity: sev, impactUs: s.elapsed, summary, evidence })
    }
  }

  private hardParses() {
    const th = this.th, missUs = this.in_.missUs
    let hp = 0, ex = 0, impact = 0
    const ids: ID[] = [], single: ID[] = []
    for (const s of this.stats) {
      if (!this.isSQL(s.id)) continue
      const n = s.hardParses
      hp += n; ex += s.executions; impact += missUs[s.id]
      if (n > 0) ids.push(s.id)
      if (s.executions > th.hard_parse_min_execs && n / s.executions > th.hard_parse_ratio) single.push(s.id)
    }
    const traceWide = hp >= th.hard_parse_min_total && ex > 0 && hp / ex > th.hard_parse_ratio
    if (!traceWide && single.length === 0) return
    const misses = (id: ID) => this.stats[id].hardParses
    const isSingle = new Set(single)
    ids.sort((a, b) => {
      if (isSingle.has(a) !== isSingle.has(b)) return isSingle.has(a) ? -1 : 1
      if (misses(a) !== misses(b)) return misses(b) - misses(a)
      return missUs[b] - missUs[a]
    })
    let once = 0
    for (const id of ids) if (misses(id) === 1 && this.stats[id].executions <= 1) once++
    let severity = this.timeSeverity(impact, this.total)
    if (single.length > 0) severity = this.atLeast(severity, 'notable')
    let summary: string
    if (traceWide) {
      summary = `${hp} hard parses / ${ex} executions (${pct(hp, ex)}%) in ${ids.length} statements; ${fmtUsGo(impact)} in hard-parsing calls`
      if (once > Math.trunc(ids.length / 2)) summary += `; ${once} statements executed once`
    } else summary = `${single.length} statements hard parsed on most executions`
    const evidence: EvidenceRow[] = []
    for (let k = 0; k < ids.length; k++) {
      if (k === th.max_evidence_rows) { evidence.push(row('...', `${ids.length - k} more statements with hard parses`)); break }
      const id = ids[k], s = this.stats[id]
      evidence.push({ ...stmtRow(id, this.label(id), `${misses(id)} hard parses / ${s.executions} executions, ${fmtUsGo(missUs[id])}`), us: missUs[id] })
    }
    this.add({ rule: 'hard-parses', title: 'Hard parses', statement: single.length === 1 ? single[0] : NONE, impactUs: impact, severity, summary, evidence })
  }

  private closeSummary(t: number[]): string {
    const names = ['hard (type 0)', 'to session cursor cache (type 1)', 'to PL/SQL cursor cache (type 2)', 'already cached (type 3)']
    const parts = t.flatMap((n, i) => (n > 0 ? [`${n} ${names[i]}`] : []))
    return parts.length ? 'closes: ' + parts.join(', ') : ''
  }

  private parsePerExec() {
    const th = this.th, ids: ID[] = []
    let impact = 0, parses = 0, execs = 0
    for (const s of this.stats) {
      if (!this.isSQL(s.id) || s.executions <= th.parse_exec_min_execs) continue
      if (s.parse.count / s.executions > th.parse_exec_ratio) { ids.push(s.id); impact += s.parse.elapsed; parses += s.parse.count; execs += s.executions }
    }
    if (ids.length === 0) return
    ids.sort((a, b) => this.stats[b].parse.count - this.stats[a].parse.count)
    const ct = this.in_.closes
    let summary = `${ids.length} statements: ${parses} parses / ${execs} executions, ${fmtUsGo(impact)} parsing`
    if (ids.length === 1) summary = `${this.label(ids[0])}: ${parses} parses / ${execs} executions, ${fmtUsGo(impact)} parsing`
    const evidence: EvidenceRow[] = []
    for (let k = 0; k < ids.length; k++) {
      if (k === th.max_evidence_rows) { evidence.push(row('...', `${ids.length - k} more statements`)); break }
      const id = ids[k], s = this.stats[id]
      let v = `${s.parse.count} parses / ${s.executions} executions (${goFixed(s.parse.count / s.executions, 2)}), ${fmtUsGo(s.parse.elapsed)} parsing`
      const cs = this.closeSummary(ct[id])
      if (cs) v += '; ' + cs
      evidence.push({ ...stmtRow(id, this.label(id), v), us: s.parse.elapsed })
    }
    this.add({ rule: 'parse-per-exec', title: 'Parse per execution', statement: ids.length === 1 ? ids[0] : NONE, impactUs: impact, severity: this.timeSeverity(impact, this.total), summary, evidence })
  }

  private hardCloses() {
    const th = this.th, ct = this.in_.closes, ids: ID[] = []
    let n = 0
    for (const s of this.stats) {
      const t = ct[s.id], all = t[0] + t[1] + t[2] + t[3]
      if (!this.isSQL(s.id) || s.parse.count < th.hard_close_min_parses || all === 0) continue
      if (t[0] / all > th.hard_close_share) { ids.push(s.id); n += t[0] }
    }
    if (n <= th.hard_close_min_count) return
    ids.sort((a, b) => ct[b][0] - ct[a][0])
    const evidence: EvidenceRow[] = []
    for (let k = 0; k < ids.length; k++) {
      if (k === th.max_evidence_rows) { evidence.push(row('...', `${ids.length - k} more statements`)); break }
      const id = ids[k]
      evidence.push(stmtRow(id, this.label(id), `${this.stats[id].parse.count} parses; ${this.closeSummary(ct[id])}`))
    }
    this.add({ rule: 'hard-closes', title: 'Hard closes', statement: ids.length === 1 ? ids[0] : NONE, impactUs: 0, severity: this.countSeverity(n),
      summary: `${n} hard closes (CLOSE type=0) in ${ids.length} repeatedly parsed statements`, evidence })
  }

  private idleEvidence(a: IdleSplit, nEvents: number, nStmts: number): EvidenceRow[] {
    const out: EvidenceRow[] = []
    for (const ev of topIDs(a.byEvent, nEvents)) {
      const us = a.byEvent.get(ev)!
      out.push({ ...row(this.doc.events[ev].name, `${fmtUsGo(us)} in ${a.n.get(ev) ?? 0} waits (${pct(us, this.total)}%)`), us })
    }
    for (const id of topIDs(a.byStmt, nStmts)) {
      const us = a.byStmt.get(id)!
      out.push({ ...stmtRow(id, this.label(id), `${fmtUsGo(us)} idle (${pct(us, this.total)}% of response time); ${fmtUsGo(this.stats[id].elapsed)} elapsed in calls`), us })
    }
    return out
  }

  private thinkTime() {
    const idle = this.in_.think.us, total = this.total
    if (total <= 0 || idle / total <= this.th.think_time_share) return
    this.add({ rule: 'think-time', title: 'Think time', statement: NONE, impactUs: idle, severity: this.timeSeverity(idle, total),
      summary: `${fmtUsGo(idle)} of ${fmtUsGo(total)} response time (${pct(idle, total)}%) idle between calls`, evidence: this.idleEvidence(this.in_.think, 3, 5) })
  }

  private inCallIdle() {
    const a = this.in_.inCall, total = this.total
    if (total <= 0 || a.us === 0 || a.us / total <= this.th.in_call_idle_share) return
    this.add({ rule: 'in-call-idle', title: 'Idle waits inside calls', statement: NONE, impactUs: a.us, severity: 'info',
      summary: `${fmtUsGo(a.us)} of ${fmtUsGo(total)} response time (${pct(a.us, total)}%) idle inside calls (PL/SQL lock timer, dequeue); included in call elapsed`,
      evidence: this.idleEvidence(a, 3, 5) })
  }

  private smallFetches() {
    const th = this.th, c = this.doc.calls
    for (const s of this.stats) {
      if (!this.isSQL(s.id) || s.fetch.count <= th.small_fetch_min_fetches || s.fetch.rows <= th.small_fetch_min_rows) continue
      const ex = this.in_.byStmt[s.id]
      let nEx = 0, fetches = 0, rows = 0, impact = 0
      let first: Exec | undefined
      for (const e of ex) {
        const nf = e.fetches.length
        if (nf < th.small_fetch_min_fetches_per_exec) continue
        let r = 0
        for (const id of e.fetches) r += c.r[id]
        if (r / nf >= th.small_fetch_rows) continue
        nEx++; fetches += nf; rows += r
        for (const id of e.fetches) impact += c.e[id] + c.idleEla[id]
        first ??= e
      }
      if (fetches <= th.small_fetch_min_fetches || rows <= th.small_fetch_min_rows) continue
      const avg = rows / fetches
      const evidence: EvidenceRow[] = [
        stmtRow(s.id, 'small-fetch executions', `${nEx} of ${ex.length} (at least ${th.small_fetch_min_fetches_per_exec} fetches, under ${goG(th.small_fetch_rows)} rows per fetch)`),
        stmtRow(s.id, 'fetches / rows', `${fetches} / ${rows} (${goFixed(avg, 1)} rows per fetch)`),
        stmtRow(s.id, 'whole statement', `${s.fetch.count} fetches / ${s.fetch.rows} rows (${goFixed(s.fetch.rows / s.fetch.count, 1)} rows per fetch)`),
      ]
      if (first) {
        evidence.push({ ...stmtRow(s.id, `exec ${first.execNo}`, `first: ${first.fetches.length} fetches, ${first.rows} rows, ${fmtUsGo(first.elapsed)}`),
          cursor: first.cursor, execNo: first.execNo, call: first.exec, line: c.line[first.exec], us: first.elapsed })
      }
      this.add({ rule: 'small-fetches', title: 'Small fetches', statement: s.id, impactUs: impact, severity: this.timeSeverity(impact, this.total),
        summary: `${this.label(s.id)}: ${goFixed(avg, 1)} rows per fetch; ${fetches} fetches, ${rows} rows in ${nEx} of ${ex.length} executions; ${fmtUsGo(impact)} in these fetches and preceding round trips`,
        evidence })
    }
  }

  private eventUs(name: string): [number, number] {
    let us = 0, n = 0
    this.doc.events.forEach((e, i) => { if (e.name === name) { us += this.in_.evUs[i]; n += this.in_.evN[i] } })
    return [us, n]
  }

  private commitPerRow() {
    const th = this.th, d = this.doc
    let commits = 0
    for (const t of d.transactions) if (t.rollback === 0 && t.readOnly === 0 && this.in_.keepTx(t.context, t.tim)) commits++
    if (commits <= th.commit_min_count) return
    let dmlExecs = 0, dmlRows = 0
    const ids: ID[] = []
    for (const s of this.stats) {
      const st = d.statements[s.id]
      if (st.kind === 0 && isDML(st.commandType) && s.executions > 0) { dmlExecs += s.executions; dmlRows += s.exec.rows; ids.push(s.id) }
    }
    if (dmlExecs === 0 || commits / dmlExecs <= th.commit_per_dml_ratio) return
    const [lfs, nlfs] = this.eventUs('log file sync')
    const evidence: EvidenceRow[] = [
      row('commits', `${commits} (read-write, XCTEND rlbk=0 rd_only=0)`),
      row('DML executions', `${dmlExecs} INSERT/UPDATE/DELETE/MERGE executions, ${dmlRows} rows, ${goFixed(commits / dmlExecs, 2)} commits per execution`),
    ]
    if (nlfs > 0) evidence.push({ ...row('log file sync', `${fmtUsGo(lfs)} in ${nlfs} waits`), us: lfs })
    ids.sort((a, b) => this.stats[b].executions - this.stats[a].executions)
    for (const id of ids.slice(0, 5)) evidence.push(stmtRow(id, this.label(id), `${this.stats[id].executions} executions, ${this.stats[id].exec.rows} rows`))
    this.add({ rule: 'commit-per-row', title: 'Commit per row', statement: NONE, impactUs: lfs, severity: this.atLeast(this.timeSeverity(lfs, this.total), 'notable'),
      summary: `${commits} commits / ${dmlExecs} DML executions (${dmlRows} rows); ${fmtUsGo(lfs)} log file sync`, evidence })
  }

  private roundTrips() {
    const [trips] = this.eventUs('SQL*Net message to client')
    if (trips <= this.th.round_trips_min) return
    const rows = this.in_.topRows
    const ratio = trips / Math.max(rows, 1)
    if (ratio <= this.th.round_trips_per_row) return
    const [fromUs, fromN] = this.eventUs('SQL*Net message from client')
    const evidence: EvidenceRow[] = [row('SQL*Net message to client', `${trips} waits`), row('rows', `${rows} (top-level calls)`)]
    if (fromN > 0) evidence.push({ ...row('SQL*Net message from client', `${fmtUsGo(fromUs)} in ${fromN} waits (avg ${fmtUsGo(Math.trunc(fromUs / fromN))})`), us: fromUs })
    this.add({ rule: 'round-trips', title: 'Round trips per row', statement: NONE, impactUs: fromUs, severity: this.countSeverity(trips),
      summary: `${trips} SQL*Net round trips / ${rows} rows (${goFixed(ratio, 2)} per row)`, evidence })
  }
}
