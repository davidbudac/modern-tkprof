// The response time of a scope and a statement's share of it: one definition for the Overview heading and ledger, the top bar,
// the Statements list, the statement detail, the findings and the Files panel, so the same number reads the same everywhere.
import type { TraceDoc } from './doc'
import type { ID, StmtStats } from './types'
import { contextStats } from './ctxstats'
import { fmtPct } from './format'

/**
 * A statement's response time: the elapsed time of its calls not nested in another call of the same statement (recursive
 * children of other statements included) plus the between-call waits attributed to it (`StmtStats.idleUs`, think time).
 */
export const responseUs = (s: Pick<StmtStats, 'elapsed' | 'idleUs'>): number => s.elapsed + s.idleUs

/** The response time of a scope (`analyze.Response`, the `responseUs` / `wallUs` / `sessions` of `api/profile`). */
export interface ScopeResponse {
  /** Σ over the scope's sessions of each session's span */
  responseUs: number
  /** the wall-clock span: the window, else the span of the files of the contexts, else the trace's */
  wallUs: number
  /** sessions with time in scope */
  sessions: number
}

export interface ResponseScope {
  window: { startTim: number; endTim: number } | null
  /** effective context filter; null = all, empty = none */
  contexts: ReadonlySet<ID> | null
}

const sessionCache = new WeakMap<object, { of: Int32Array; n: number }>()

/**
 * The session of every context (`analyze.SessionsOf`): one per server process of a file chain (`FileEntry.chain` +
 * `Context.process`). A single file without trcsess markers is one session; a process runs one thing at a time, so the spans
 * of its contexts add up without overlap.
 */
export function sessionsOf(doc: Pick<TraceDoc, 'contexts' | 'file'>): { of: Int32Array; n: number } {
  const hit = sessionCache.get(doc)
  if (hit) return hit
  const files = doc.file.files ?? []
  const idx = new Map<string, number>()
  const of = new Int32Array(doc.contexts.length)
  doc.contexts.forEach((c, i) => {
    const fi = c.fileIdx ?? 0
    const chain = files[fi] ? files[fi].chain : -1 - fi
    const k = `${chain}\u0000${c.process ?? ''}`
    let s = idx.get(k)
    if (s === undefined) { s = idx.size; idx.set(k, s) }
    of[i] = s
  })
  const out = { of, n: idx.size }
  sessionCache.set(doc, out)
  return out
}

/** The wall-clock span of a scope: the window, else the span of the files of the contexts, else the trace span. */
export function wallSpanUs(doc: Pick<TraceDoc, 'contexts' | 'file' | 'spanUs'>, scope: ResponseScope): number {
  if (scope.window) return Math.max(0, scope.window.endTim - scope.window.startTim)
  if (!scope.contexts) return doc.spanUs()
  if (scope.contexts.size === 0) return 0
  const files = doc.file.files ?? []
  let lo = 0, hi = 0, seen = false
  for (const id of scope.contexts) {
    const ctx = doc.contexts[id]
    if (!ctx) continue
    const f = files[ctx.fileIdx ?? 0]
    if (!f || f.firstTim <= 0 || f.lastTim < f.firstTim) continue
    if (!seen || f.firstTim < lo) lo = f.firstTim
    if (!seen || f.lastTim > hi) hi = f.lastTim
    seen = true
  }
  return !seen || hi <= lo ? doc.spanUs() : hi - lo
}

/**
 * The response time of a scope (`analyze.ResponseOf`, DB-time-like): Σ over its sessions of the session's span, from the start
 * of its first call to the end of its last call or wait (between-call idle included). Each context is clipped to the tim range
 * of its file (a call that started before the file counts from the file's first line), the session to the window. A
 * single-session trace's response time is its span. PX slave contexts attached to a coordinator in scope are left out (their
 * work is the coordinator's: `pxEla`); a slave without its coordinator in scope is a session. With a context subset each run of
 * consecutive selected contexts of a session counts from its first to its last row.
 */
export function scopeResponse(doc: TraceDoc, scope: ResponseScope): ScopeResponse {
  const out: ScopeResponse = { responseUs: 0, wallUs: wallSpanUs(doc, scope), sessions: 0 }
  const sel = scope.contexts
  if (sel && sel.size === 0) return out
  const inScope = (id: ID) => !sel || sel.has(id)
  const cs = contextStats(doc)
  const files = doc.file.files ?? []
  let lo = doc.span.firstTim, hi = doc.span.lastTim
  if (scope.window) { lo = Math.max(lo, scope.window.startTim); hi = Math.min(hi, scope.window.endTim) }
  const { of, n } = sessionsOf(doc)
  const skip = pxOut(doc, scope)
  const open = new Uint8Array(n), from = new Float64Array(n), to = new Float64Array(n), us = new Float64Array(n)
  const end = (s: number) => {
    if (!open[s]) return
    us[s] += Math.max(Math.min(to[s], hi) - Math.max(from[s], lo), 0)
    open[s] = 0
  }
  for (let i = 0; i < doc.contexts.length && i < cs.length; i++) {
    const c = cs[i]
    if (!c.firstTim && !c.lastTim) continue // no timed row: neither part of a run nor a gap
    const ctx = doc.contexts[i]
    const f = files[ctx.fileIdx ?? 0]
    const [flo, fhi] = f && f.firstTim > 0 && f.lastTim >= f.firstTim ? [f.firstTim, f.lastTim] : [doc.span.firstTim, doc.span.lastTim]
    const a = Math.max(c.firstTim, flo), b = Math.max(a, Math.min(c.lastTim, fhi))
    const s = of[i]
    if (!inScope(i) || skip(i)) { end(s); continue }
    if (!open[s]) { open[s] = 1; from[s] = a; to[s] = b; continue }
    from[s] = Math.min(from[s], a)
    to[s] = Math.max(to[s], b)
  }
  for (let s = 0; s < n; s++) {
    end(s)
    if (us[s] > 0) { out.responseUs += us[s]; out.sessions++ }
  }
  return out
}

/**
 * Whether a context is a PX slave attached to a coordinator in scope (`analyze.PXOut`): its rows are the coordinator's work,
 * outside the scope's response time and ledger (`DataSource.profile`).
 */
export function pxOut(doc: Pick<TraceDoc, 'contexts'>, scope: Pick<ResponseScope, 'contexts'>): (ctx: ID) => boolean {
  const sel = scope.contexts
  return (id) => {
    const c = doc.contexts[id]
    const parent = c?.parent ?? -1
    return !!c?.px && parent >= 0 && (!sel || sel.has(parent))
  }
}

/** The scope's response time from a profile answer (`api/profile` carries it), else computed here. */
export function responseOf(doc: TraceDoc, scope: ResponseScope, p?: Partial<ScopeResponse> | null): ScopeResponse {
  if (p && p.responseUs !== undefined && p.wallUs !== undefined && p.sessions !== undefined) return { responseUs: p.responseUs, wallUs: p.wallUs, sessions: p.sessions }
  return scopeResponse(doc, scope)
}

/**
 * What a statement's share is measured against: the scope's response time as the Overview heading and ledger have it.
 * `narrowed` false means the numbers are the whole trace's (no scope, or an engine that cannot answer statistics of one), so
 * the base is the whole trace's too.
 */
export function responseBaseUs(doc: TraceDoc, scope: ResponseScope, narrowed: boolean): number {
  return scopeResponse(doc, narrowed ? scope : { window: null, contexts: null }).responseUs
}

/**
 * Share of the base, 0..1 and beyond. The base sums the sessions, so a statement stays within it; it can exceed 100 % when its
 * calls reach outside a window (a call overlapping the window counts whole) or start before the trace; `shareNote` says so.
 * An idle wait inside a call (PL/SQL lock timer of a sleep) is in the call's elapsed time only, not in `idleUs`.
 */
export function responseShare(s: Pick<StmtStats, 'elapsed' | 'idleUs'>, baseUs: number): number {
  return baseUs > 0 ? responseUs(s) / baseUs : 0
}

/** Tooltip for a share above 100 %. */
export function shareNote(share: number): string | undefined {
  return share > 1 ? 'above 100 %: calls reaching outside the scope\'s time count whole' : undefined
}

/** "4 sessions · wall 3.849 s" for a scope of several sessions, else "". */
export function sessionsLabel(r: ScopeResponse, fmt: (us: number) => string): string {
  return r.sessions > 1 ? `${r.sessions} sessions · wall ${fmt(r.wallUs)}` : ''
}

/**
 * The Overview lede: how many statements (largest first) make up 80 % of the scope's response time, "top 2 statements: 83 %";
 * "" for a single statement or when the statements do not reach it.
 */
export function concentrationLede(totalUs: number, stmts: readonly Pick<StmtStats, 'elapsed' | 'idleUs'>[]): string {
  if (totalUs <= 0) return 'no time information'
  let acc = 0, k = 0
  for (const s of stmts) { acc += responseUs(s); k++; if (acc >= 0.8 * totalUs) break }
  return stmts.length > 1 && acc >= 0.8 * totalUs ? `top ${k} statement${k === 1 ? '' : 's'}: ${fmtPct(acc, totalUs, 0)}` : ''
}
