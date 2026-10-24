// Where the views get fact-level answers from.
//
//   LocalSource   the fact columns held by the browser (standalone HTML, `serve` with facts):
//                 every method answers synchronously, exactly as the views used to compute it.
//   RemoteSource  `mtkprof serve -facts=false` (document.slice): the Go server answers the same
//                 questions from /api/* (internal/slice), so the browser never holds the facts.
//
// A method returns `T | Promise<T>`; `useSourceQuery` runs it, cancels stale requests and keeps
// the screen on the previous answer while the next one is on its way.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TraceDoc } from './doc'
import type { ID } from './types'
import { CallKind, NONE } from './types'
import { callFilter, waitFilter, type Scope } from '../app/store'
import { groupBy, logHistogram, type Agg } from './groupby'
import {
  executions as localExecutions, bindsOf, statementRoleUs, statementWaits, statementSpans, timelineRaw, topLevelCpu, waitsByEvent, NROLES,
  type BindRow, type Execution, type ScopeProfile, type Span2, type StmtWait, type TimelineRaw,
} from './derive'
import { pivotDims, pivotMeasures, runPivot, type Fact } from './pivot'
import { roleOfClass, roleOrder } from '../components/colors'

export type Maybe<T> = T | Promise<T>

// ---- result shapes -------------------------------------------------------------

export interface PivotQuery {
  fact: Fact
  /** one or two dimension ids */
  by: string[]
  scope: Scope
  /** measure id the rows are sorted by (descending) */
  sort: string
  /** at most this many rows (Infinity = all groups) */
  limit: number
  /** only the rows of this statement / (waits) this event */
  stmt?: ID
  event?: ID
}

export interface PivotRowData {
  /** raw key per dimension (a statement id, an event id, ...; negative = none) */
  keys: number[]
  labels: string[]
  /** the descriptive column of dimensions that have one ("" otherwise) */
  extra: string[]
  /** one value per measure of the fact, in `pivotMeasures(fact)` order */
  values: number[]
}

export interface PivotData {
  rows: PivotRowData[]
  total: number[]
  /** fact rows in scope */
  facts: number
  /** groups before the row limit */
  groups: number
}

/** A call as the Timeline view draws it. */
export interface Bar { id: number; stmt: ID; kind: number; tim: number; e: number; c: number; r: number; line: number; dep: number; execNo: number
  /** input file of a multi-file trace when known (else take the statement's) */
  file?: number }

export interface CallsPicked {
  /** calls with a time stamp in scope */
  total: number
  /** `bars` holds only the longest ones */
  sampled: boolean
  bars: Bar[]
  /** the longest calls, longest first */
  longest: Bar[]
}

export interface ExecPage {
  /** executions of the statement */
  total: number
  avgE: number
  slowest: { execNo: number; e: number } | null
  rows: Execution[]
  /** `rows` are the slowest of `total`, not all of them */
  partial: boolean
}

export interface CallPart { calls: number; c: number; e: number; p: number; cr: number; cu: number; r: number }

/** One execution taken apart: the PARSE before its EXEC, the EXEC, its FETCHes. */
export interface ExecDetail {
  plh: number
  parse: CallPart
  exec: CallPart
  fetch: CallPart
  total: CallPart
  /** over the parse, exec and fetch calls */
  waits: { event: ID; count: number; us: number }[]
  /** waits attached to the EXEC call itself */
  execWaits: number
  binds: BindRow[]
  /** trace line of the BINDS block (0 = none) */
  bindLine: number
  /** trace line of the EXEC */
  line: number
}

export interface WaitHist { count: number; us: number; counts: number[]; sums: number[] }
export interface ScatterPoint { tim: number; ela: number; line: number; stmt: ID; file?: number }
export interface ScatterData { total: number; points: ScatterPoint[] }
export interface WaitRow { tim: number; ela: number; line: number; stmt: ID; file?: number }
export interface KeyAgg { key: number; count: number; sum: number }

export interface DataSource {
  readonly remote: boolean
  /** fact-level questions can be answered (facts in the document, or a server behind it) */
  readonly ready: boolean
  pivot(q: PivotQuery, signal?: AbortSignal): Maybe<PivotData>
  /** CPU of top-level calls and waits per event; null = not available (use the document's stats) */
  profile(scope: Scope, signal?: AbortSignal): Maybe<ScopeProfile | null>
  timeline(bucketUs: number, scope: Scope, signal?: AbortSignal): Maybe<TimelineRaw | null>
  calls(scope: Scope, signal?: AbortSignal): Maybe<CallsPicked>
  executions(stmt: ID, signal?: AbortSignal): Maybe<ExecPage>
  executionDetail(stmt: ID, ex: Execution, signal?: AbortSignal): Maybe<ExecDetail>
  waitHist(event: ID, scope: Scope, signal?: AbortSignal): Maybe<WaitHist>
  waitScatter(event: ID, scope: Scope, signal?: AbortSignal): Maybe<ScatterData>
  waitTop(event: ID, scope: Scope, limit: number, signal?: AbortSignal): Maybe<WaitRow[]>
  waitsBy(event: ID, scope: Scope, by: 'stmt' | 'obj' | 'p1', limit: number, signal?: AbortSignal): Maybe<KeyAgg[]>
  stmtWaits(stmts: ID[], max: number, signal?: AbortSignal): Maybe<Map<ID, StmtWait[]>>
  /** wait time per statement and color role (row = statement, column = roleOrder index); null = not available */
  stmtRoles(signal?: AbortSignal): Maybe<Float64Array | null>
  stmtSpans(stmts: ID[], gapUs: number, signal?: AbortSignal): Maybe<Map<ID, Span2[]>>
}

// ---- registry ----------------------------------------------------------------

const sources = new WeakMap<TraceDoc, DataSource>()

/** The source of a document: the server behind it when it has one, else its own fact columns. */
export function sourceOf(doc: TraceDoc): DataSource {
  let s = sources.get(doc)
  if (!s) { s = new LocalSource(doc); sources.set(doc, s) }
  return s
}

/** The server at `apiBase` answers the fact-level questions of `doc` (a document served with the slicing API). */
export function attachRemote(doc: TraceDoc, apiBase: string): void {
  sources.set(doc, new RemoteSource(doc, apiBase))
}

// ---- LocalSource ---------------------------------------------------------------

const MAX_BARS = 20000
const MAX_DOTS = 20000
export const KEEP_SLOWEST = 2000

/** At most `cap` of the indices: the slowest waits are always kept, the rest evenly strided. */
function sampleWaits(ids: number[], ela: ArrayLike<number>, cap: number): number[] {
  if (ids.length <= cap) return ids
  const byEla = [...ids].sort((a, b) => ela[b] - ela[a])
  const keep = byEla.slice(0, KEEP_SLOWEST)
  const rest = byEla.slice(KEEP_SLOWEST)
  const stride = rest.length / (cap - KEEP_SLOWEST)
  for (let k = 0; k < cap - KEEP_SLOWEST; k++) keep.push(rest[Math.floor(k * stride)])
  return keep
}

const zeroPart = (): CallPart => ({ calls: 0, c: 0, e: 0, p: 0, cr: 0, cu: 0, r: 0 })

export class LocalSource implements DataSource {
  readonly remote = false
  private dims: Partial<Record<Fact, ReturnType<typeof pivotDims>>> = {}
  constructor(private readonly doc: TraceDoc) {}

  get ready(): boolean { return this.doc.hasFacts }

  private cf(scope: Scope) { return callFilter({ doc: this.doc, ...scope }) }
  private wf(scope: Scope) { return waitFilter({ doc: this.doc, ...scope }) }

  pivot(q: PivotQuery): PivotData {
    const doc = this.doc
    const dims = (this.dims[q.fact] ??= pivotDims(doc, q.fact))
    const d1 = dims.find((d) => d.id === q.by[0]) ?? dims[0]
    const d2 = q.by[1] && q.by[1] !== d1.id ? dims.find((d) => d.id === q.by[1]) ?? null : null
    let filter = q.fact === 'calls' ? this.cf(q.scope) : this.wf(q.scope)
    if (q.stmt !== undefined || q.event !== undefined) {
      const base = filter, stmt = q.stmt, event = q.event
      const stmtCol = q.fact === 'calls' ? doc.calls.stmt : doc.waits.stmt
      filter = (i) => (stmt === undefined || stmtCol[i] === stmt) && (event === undefined || q.fact !== 'waits' || doc.waits.event[i] === event) && (!base || base(i))
    }
    const res = runPivot(doc, q.fact, filter, d1, d2)
    const measures = pivotMeasures(q.fact)
    const sortM = measures.find((m) => m.id === q.sort) ?? measures[1]
    const t = res.total
    const sorted = [...res.groups].sort((a, b) => sortM.value(b.acc, t) - sortM.value(a.acc, t))
    const rows = (Number.isFinite(q.limit) ? sorted.slice(0, q.limit) : sorted).map((g): PivotRowData => ({
      keys: d2 ? [g.k1, g.k2] : [g.k1],
      labels: d2 ? [d1.name(g.k1), d2.name(g.k2)] : [d1.name(g.k1)],
      extra: d2 ? [d1.extra?.get(g.k1) ?? '', d2.extra?.get(g.k2) ?? ''] : [d1.extra?.get(g.k1) ?? ''],
      values: measures.map((m) => m.value(g.acc, t)),
    }))
    return { rows, total: measures.map((m) => m.value(t, t)), facts: res.rows, groups: res.groups.length }
  }

  profile(scope: Scope): ScopeProfile | null {
    const doc = this.doc
    if (!doc.hasFacts) return null
    return { cpuUs: topLevelCpu(doc, this.cf(scope)), events: waitsByEvent(doc, this.wf(scope)) }
  }

  // The chart and the lanes strips have always drawn the CPU of every context: only waits follow the filter.
  timeline(bucketUs: number, scope: Scope): TimelineRaw | null {
    return this.doc.hasFacts ? timelineRaw(this.doc, bucketUs, undefined, this.wf(scope)) : null
  }

  calls(scope: Scope): CallsPicked {
    const doc = this.doc
    const c = doc.calls
    const cf = this.cf(scope)
    const idx: number[] = []
    for (let i = 0; i < c.n; i++) {
      if (!c.tim[i]) continue
      if (cf && !cf(i)) continue
      idx.push(i)
    }
    const total = idx.length
    let keep = idx
    let sampled = false
    if (total > MAX_BARS) {
      sampled = true
      const es = new Float64Array(total)
      for (let k = 0; k < total; k++) es[k] = c.e[idx[k]]
      es.sort()
      const threshold = es[total - MAX_BARS]
      const above: number[] = [], equal: number[] = []
      for (const i of idx) {
        const e = c.e[i]
        if (e > threshold) above.push(i)
        else if (e === threshold) equal.push(i)
      }
      keep = above.concat(equal.slice(0, MAX_BARS - above.length))
    }
    // longest calls in the window (from the unsampled set)
    const longest = idx.length <= 20 ? idx.slice() : (() => {
      const es = new Float64Array(total)
      for (let k = 0; k < total; k++) es[k] = c.e[idx[k]]
      const sorted = es.slice().sort()
      const th = sorted[total - 20]
      return idx.filter((i) => c.e[i] >= th)
    })()
    longest.sort((a, b) => c.e[b] - c.e[a])
    const bar = (i: number): Bar => ({ id: i, stmt: c.stmt[i], kind: c.kind[i], tim: c.tim[i], e: c.e[i], c: c.c[i], r: c.r[i], line: c.line[i], dep: c.dep[i], execNo: c.execNo[i], file: this.doc.fileOfCtx(c.ctx[i]) })
    return { total, sampled, bars: keep.map(bar), longest: longest.slice(0, 20).map(bar) }
  }

  executions(stmt: ID): ExecPage {
    const rows = localExecutions(this.doc, stmt)
    let sum = 0, slow: Execution | null = null
    for (const e of rows) { sum += e.e; if (!slow || e.e > slow.e) slow = e }
    return { total: rows.length, avgE: rows.length ? sum / rows.length : 0, slowest: slow ? { execNo: slow.execNo, e: slow.e } : null, rows, partial: false }
  }

  /** The calls of one execution: the PARSE just before its EXEC on the same cursor, the EXEC, and its FETCHes. */
  executionDetail(stmt: ID, ex: Execution): ExecDetail {
    const doc = this.doc
    const c = doc.calls
    const ids = doc.callsByStmt.get(c.stmt[ex.exec])
    const calls: number[] = []
    const at = ids.indexOf(ex.exec)
    for (let k = at - 1; k >= 0; k--) {
      const i = ids[k]
      if (c.cursor[i] !== ex.cursor) continue
      if (c.kind[i] === CallKind.parse) calls.push(i)
      break // the nearest earlier call of this cursor: a parse belongs to this execution, anything else to the previous one
    }
    calls.push(ex.exec)
    for (let k = at + 1; k < ids.length; k++) {
      const i = ids[k]
      if (c.cursor[i] !== ex.cursor) continue
      if (c.kind[i] !== CallKind.fetch || c.execNo[i] !== ex.execNo) { if (c.kind[i] === CallKind.exec || c.kind[i] === CallKind.close || c.kind[i] === CallKind.parse) break; continue }
      calls.push(i)
    }
    const d: ExecDetail = {
      plh: c.plh[ex.exec], parse: zeroPart(), exec: zeroPart(), fetch: zeroPart(), total: zeroPart(), waits: [],
      execWaits: doc.waitsByCall.get(ex.exec).length, binds: bindsOf(doc, ex.bindSet),
      bindLine: ex.bindSet !== NONE ? doc.bindSets.line[ex.bindSet] : 0, line: c.line[ex.exec],
    }
    const byEvent = new Map<number, { event: ID; count: number; us: number }>()
    const add = (part: CallPart, i: number) => {
      part.calls++; part.c += c.c[i]; part.e += c.e[i]; part.p += c.p[i]; part.cr += c.cr[i]; part.cu += c.cu[i]; part.r += c.r[i]
    }
    for (const i of calls) {
      add(c.kind[i] === CallKind.parse ? d.parse : c.kind[i] === CallKind.exec ? d.exec : d.fetch, i)
      add(d.total, i)
      for (const w of doc.waitsByCall.get(i)) {
        const ev = doc.waits.event[w]
        const a = byEvent.get(ev) ?? { event: ev, count: 0, us: 0 }
        a.count++; a.us += doc.waits.ela[w]
        byEvent.set(ev, a)
      }
    }
    d.waits = [...byEvent.values()]
    void stmt
    return d
  }

  waitHist(event: ID, scope: Scope): WaitHist {
    const w = this.doc.waits
    const wf = this.wf(scope)
    const els: number[] = []
    let us = 0
    for (let i = 0; i < w.n; i++) if (w.event[i] === event && (!wf || wf(i))) { els.push(w.ela[i]); us += w.ela[i] }
    const h = logHistogram(els)
    return { count: els.length, us, counts: h.counts, sums: h.sums }
  }

  waitScatter(event: ID, scope: Scope): ScatterData {
    const w = this.doc.waits
    const wf = this.wf(scope)
    const ids: number[] = []
    for (let i = 0; i < w.n; i++) if (w.event[i] === event && w.tim[i] && (!wf || wf(i))) ids.push(i)
    const dots = sampleWaits(ids, w.ela, MAX_DOTS)
    return { total: ids.length, points: dots.map((i) => ({ tim: w.tim[i], ela: w.ela[i], line: w.line[i], stmt: w.stmt[i], file: this.doc.fileOfCtx(w.ctx[i]) })) }
  }

  private waitIds(event: ID, scope: Scope): number[] {
    const w = this.doc.waits
    const wf = this.wf(scope)
    const ids: number[] = []
    for (let i = 0; i < w.n; i++) if (w.event[i] === event && (!wf || wf(i))) ids.push(i)
    return ids
  }

  waitTop(event: ID, scope: Scope, limit: number): WaitRow[] {
    const w = this.doc.waits
    return this.waitIds(event, scope).sort((a, b) => w.ela[b] - w.ela[a]).slice(0, limit)
      .map((i) => ({ tim: w.tim[i], ela: w.ela[i], line: w.line[i], stmt: w.stmt[i], file: this.doc.fileOfCtx(w.ctx[i]) }))
  }

  waitsBy(event: ID, scope: Scope, by: 'stmt' | 'obj' | 'p1', limit: number): KeyAgg[] {
    const w = this.doc.waits
    const ids = this.waitIds(event, scope)
    const key = by === 'stmt' ? (k: number) => w.stmt[ids[k]]
      : by === 'obj' ? (k: number) => { const o = w.obj[ids[k]]; return o > 0 ? o : NaN }
      : (k: number) => w.p1[ids[k]]
    return groupBy({ n: ids.length, key, value: (k) => w.ela[ids[k]] }).slice(0, limit).map((a: Agg) => ({ key: a.key, count: a.count, sum: a.sum }))
  }

  stmtWaits(stmts: ID[], max: number): Map<ID, StmtWait[]> {
    return new Map(stmts.map((s) => [s, statementWaits(this.doc, s, max)]))
  }

  stmtRoles(): Float64Array | null { return this.doc.hasFacts ? statementRoleUs(this.doc) : null }

  stmtSpans(stmts: ID[], gapUs: number): Map<ID, Span2[]> {
    return new Map(stmts.map((s) => [s, this.doc.hasFacts ? statementSpans(this.doc, s, gapUs) : []]))
  }
}

// ---- RemoteSource --------------------------------------------------------------

type Params = Record<string, string | number | undefined>

function scopeParams(scope: Scope, waits: boolean): Params {
  const p: Params = {}
  if (scope.window) { p.from = Math.floor(scope.window.startTim); p.to = Math.ceil(scope.window.endTim) }
  if (scope.contexts) p.contexts = [...scope.contexts].sort((a, b) => a - b).join(',')
  if (waits) p.idle = scope.includeIdle ? 1 : 0
  return p
}

const MAX_CACHE = 200

export class RemoteSource implements DataSource {
  readonly remote = true
  readonly ready = true
  private readonly cache = new Map<string, unknown>()
  private roles?: Promise<Float64Array>

  /** `base` is the URL of the API root, e.g. `http://127.0.0.1:8046/api/` (relative paths resolve against it). */
  constructor(private readonly doc: TraceDoc, private readonly base: string) {}

  /** GET base+path?params as JSON; answers are cached by URL, a cancelled request leaves nothing behind. */
  private async get<T>(path: string, params: Params, signal?: AbortSignal): Promise<T> {
    const u = new URL(path, new URL(this.base, location.href))
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v))
    const key = u.toString()
    if (this.cache.has(key)) {
      const v = this.cache.get(key) as T
      this.cache.delete(key); this.cache.set(key, v) // most recently used last
      return v
    }
    const res = await fetch(key, { signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`${path}: ${(await res.text()).trim() || res.statusText}`)
    const v = (await res.json()) as T
    this.cache.set(key, v)
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string)
    return v
  }

  async pivot(q: PivotQuery, signal?: AbortSignal): Promise<PivotData> {
    const measures = pivotMeasures(q.fact)
    const sort = measures.some((m) => m.id === q.sort) ? q.sort : measures[1].id
    const r = await this.get<{ measures: { id: string }[]; rows: { keys: number[]; labels: string[]; extra: string[]; values: number[] }[]; total: number[]; facts: number; groups: number }>('pivot', {
      fact: q.fact, by: q.by.join(','), measure: [sort, ...measures.map((m) => m.id).filter((id) => id !== sort)].join(','),
      limit: Number.isFinite(q.limit) ? q.limit : 100000, stmt: q.stmt, event: q.event, ...scopeParams(q.scope, q.fact === 'waits'),
    }, signal)
    // the server lists the measures in the order asked for; the views want pivotMeasures() order
    const at = measures.map((m) => r.measures.findIndex((x) => x.id === m.id))
    const order = (v: number[]) => at.map((k) => v[k])
    return { rows: r.rows.map((x) => ({ keys: x.keys, labels: x.labels, extra: x.extra, values: order(x.values) })), total: order(r.total), facts: r.facts, groups: r.groups }
  }

  async profile(scope: Scope, signal?: AbortSignal): Promise<ScopeProfile> {
    const r = await this.get<{ cpuUs: number; events: { event: number; count: number; us: number; minUs: number; maxUs: number }[] }>('profile', scopeParams(scope, true), signal)
    return { cpuUs: r.cpuUs, events: r.events.map((e) => ({ key: e.event, count: e.count, sum: e.us, min: e.minUs, max: e.maxUs, extra: new Float64Array(0) })) }
  }

  async timeline(bucketUs: number, scope: Scope, signal?: AbortSignal): Promise<TimelineRaw | null> {
    if (bucketUs <= 0 || this.doc.spanUs() <= 0) return null
    const r = await this.get<{ n: number; firstTim: number; cpu: number[]; events: { event: number; us: number[] }[] }>('timeline', { bucket: bucketUs, ...scopeParams(scope, true) }, signal)
    const perEvent: (Float64Array | undefined)[] = new Array(this.doc.events.length)
    const totals = new Float64Array(this.doc.events.length)
    for (const e of r.events) {
      const us = Float64Array.from(e.us)
      perEvent[e.event] = us
      let t = 0
      for (let b = 0; b < us.length; b++) t += us[b]
      totals[e.event] = t
    }
    return { bucketUs, starts: Array.from({ length: r.n }, (_, i) => r.firstTim + i * bucketUs), cpu: Float64Array.from(r.cpu), perEvent, totals }
  }

  async calls(scope: Scope, signal?: AbortSignal): Promise<CallsPicked> {
    const r = await this.get<{ total: number; sampled: boolean; cols: string[]; rows: number[][]; longest: number[] }>('calls', { limit: MAX_BARS, longest: 20, ...scopeParams(scope, false) }, signal)
    const at = (name: string) => r.cols.indexOf(name)
    const [iId, iStmt, iKind, iTim, iE, iC, iR, iLine, iDep, iExec] = ['id', 'stmt', 'kind', 'tim', 'e', 'c', 'r', 'line', 'dep', 'execNo'].map(at)
    const bars = r.rows.map((x): Bar => ({ id: x[iId], stmt: x[iStmt], kind: x[iKind], tim: x[iTim], e: x[iE], c: x[iC], r: x[iR], line: x[iLine], dep: x[iDep], execNo: x[iExec] }))
    const byId = new Map(bars.map((b) => [b.id, b]))
    return { total: r.total, sampled: r.sampled, bars, longest: r.longest.map((id) => byId.get(id)).filter((b): b is Bar => !!b) }
  }

  async executions(stmt: ID, signal?: AbortSignal): Promise<ExecPage> {
    type Page = { total: number; avgE: number; slowest: { execNo: number; e: number } | null; rows: Execution[] }
    const cap = 5000
    let r = await this.get<Page>('executions', { stmt, limit: cap, sort: 'file' }, signal)
    let partial = false
    if (r.total > r.rows.length) { // too many to list: the slowest ones
      r = await this.get<Page>('executions', { stmt, limit: cap, sort: 'e' }, signal)
      partial = true
    }
    return { total: r.total, avgE: r.avgE, slowest: r.slowest ? { execNo: r.slowest.execNo, e: r.slowest.e } : null, rows: r.rows, partial }
  }

  async executionDetail(stmt: ID, ex: Execution, signal?: AbortSignal): Promise<ExecDetail> {
    const r = await this.get<Omit<ExecDetail, 'exec'> & { execPart: CallPart }>('executions/detail', { stmt, cursor: ex.cursor, execNo: ex.execNo }, signal)
    return { plh: r.plh, parse: r.parse, exec: r.execPart, fetch: r.fetch, total: r.total, waits: r.waits, execWaits: r.execWaits, binds: r.binds, bindLine: r.bindLine, line: r.line }
  }

  waitHist(event: ID, scope: Scope, signal?: AbortSignal): Promise<WaitHist> {
    return this.get<WaitHist>('waits/hist', { event, ...scopeParams(scope, true) }, signal)
  }

  async waitScatter(event: ID, scope: Scope, signal?: AbortSignal): Promise<ScatterData> {
    const r = await this.get<{ total: number; rows: number[][] }>('waits/scatter', { event, max: MAX_DOTS, ...scopeParams(scope, true) }, signal)
    return { total: r.total, points: r.rows.map((x) => ({ tim: x[0], ela: x[1], line: x[2], stmt: x[3] })) }
  }

  async waitTop(event: ID, scope: Scope, limit: number, signal?: AbortSignal): Promise<WaitRow[]> {
    const r = await this.get<{ rows: { tim: number; ela: number; line: number; stmt: number }[] }>('waits', { event, limit, sort: 'ela', ...scopeParams(scope, true) }, signal)
    return r.rows.map((x) => ({ tim: x.tim, ela: x.ela, line: x.line, stmt: x.stmt }))
  }

  async waitsBy(event: ID, scope: Scope, by: 'stmt' | 'obj' | 'p1', limit: number, signal?: AbortSignal): Promise<KeyAgg[]> {
    const r = await this.get<{ rows: { key: number; count: number; us: number }[] }>('waits/by', { event, by, limit, ...scopeParams(scope, true) }, signal)
    return r.rows.map((x) => ({ key: x.key, count: x.count, sum: x.us }))
  }

  async stmtWaits(stmts: ID[], max: number, signal?: AbortSignal): Promise<Map<ID, StmtWait[]>> {
    const out = new Map<ID, StmtWait[]>()
    if (stmts.length === 0) return out
    const r = await this.get<{ waits: Record<string, { event: number; us: number; count: number; maxUs: number; obj: number; maxLine: number }[]> }>('stmt/waits', { stmt: stmts.join(','), max }, signal)
    for (const s of stmts) {
      out.set(s, (r.waits[String(s)] ?? []).map((w) => {
        const ev = this.doc.events[w.event]
        return { event: w.event, name: ev?.name ?? '?', role: roleOfClass(ev?.class ?? '', ev?.idle ?? false), us: w.us, count: w.count, maxUs: w.maxUs, obj: w.obj > 0 ? w.obj : -1, maxLine: w.maxLine }
      }))
    }
    return out
  }

  stmtRoles(signal?: AbortSignal): Promise<Float64Array> {
    return (this.roles ??= this.get<{ classes: string[]; rows: [number, number, number][] }>('stmt/roles', {}, signal).then((r) => {
      const roleIdx = r.classes.map((cl) => roleOrder.indexOf(roleOfClass(cl, cl === 'Idle')))
      const t = new Float64Array(this.doc.statements.length * NROLES)
      for (const [s, cl, us] of r.rows) if (s >= 0 && s < this.doc.statements.length) t[s * NROLES + roleIdx[cl]] += us
      return t
    }, (err) => { this.roles = undefined; throw err }))
  }

  async stmtSpans(stmts: ID[], gapUs: number, signal?: AbortSignal): Promise<Map<ID, Span2[]>> {
    const out = new Map<ID, Span2[]>()
    if (stmts.length === 0) return out
    const r = await this.get<{ spans: Record<string, { start: number; end: number }[]> }>('stmt/spans', { stmt: stmts.join(','), gap: Math.max(0, Math.floor(gapUs)) }, signal)
    for (const s of stmts) out.set(s, r.spans[String(s)] ?? [])
    return out
  }
}

// ---- hook ----------------------------------------------------------------------

export interface QueryState<T> {
  data: T | undefined
  /** an answer is on its way (`data` is then the previous answer when `keep` matches, else undefined) */
  loading: boolean
  error: string | null
}

const NO_SIGNAL = new AbortController().signal

/**
 * Runs `run` for the current `key` (put everything it reads in the key). A local source answers in
 * the same render; a remote one in the background: the request of a stale key is aborted, and with
 * the same `keep` string the previous answer stays visible while the next one loads.
 */
export function useSourceQuery<T>(source: DataSource, key: string, run: (signal: AbortSignal) => Maybe<T>, keep?: string): QueryState<T> {
  const runRef = useRef(run)
  runRef.current = run
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const local = useMemo(() => (source.remote ? undefined : { value: runRef.current(NO_SIGNAL) as T }), [source, key])
  const [st, setSt] = useState<{ source: DataSource; key: string; keep?: string; data?: T; error?: string }>({ source, key })
  useEffect(() => {
    if (!source.remote) return
    const ac = new AbortController()
    Promise.resolve(runRef.current(ac.signal)).then(
      (data) => { if (!ac.signal.aborted) setSt({ source, key, keep, data }) },
      (err: unknown) => { if (!ac.signal.aborted && !(err instanceof DOMException && err.name === 'AbortError')) setSt({ source, key, keep, error: err instanceof Error ? err.message : String(err) }) },
    )
    return () => ac.abort()
  }, [source, key, keep])
  if (local) return { data: local.value, loading: false, error: null }
  if (st.source === source && st.key === key) return { data: st.data, loading: false, error: st.error ?? null }
  const sameShape = st.source === source && keep !== undefined && st.keep === keep
  return { data: sameShape ? st.data : undefined, loading: true, error: null }
}
