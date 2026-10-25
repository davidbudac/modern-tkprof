// A Pivot configuration that can be saved and applied to another trace (the desktop app's library):
// ids are positions in one document, so the scope rules that name things keep stable keys
// (sql_id + text hash, event name, session/module/action) and are resolved against the target.
import type { Context, Event, ID, Span, Statement } from './types'
import { pivotMeasures, type Fact } from './pivot'
import { resolveStmt, stmtRef, type StmtRef } from './annotations'
import type { PivotState, State } from '../state/store'

/** A session context by its trace attributes (the `*** SESSION ID` / MODULE / ACTION lines). */
export interface ContextKey { session: string; module: string; action: string }

export interface PivotConfig {
  fact: Fact
  /** one or two dimension ids */
  by: string[]
  /** measure id the rows are sorted by */
  sort: string
  limit: number
  /** the time window as offsets from the trace's first tim (µs) */
  window?: { fromUs: number; toUs: number }
  /**
   * The same window as absolute wall-clock times (µs since the epoch, as `TraceDoc.wallOf`), saved on request.
   * Applying the configuration to a trace with timestamps then selects that time of day on that day, whatever the trace's start;
   * `window` stays the fallback for traces without. Optional: configurations saved before it load unchanged.
   */
  windowClock?: { fromWallUs: number; toWallUs: number }
  contexts?: ContextKey[]
  includeIdle: boolean
  /** only the rows of this statement / event */
  stmt?: StmtRef
  event?: string
}

/** What resolving a config needs (a TraceDoc has all of it). */
export interface PivotDoc { statements: Statement[]; events: Event[]; contexts: Context[]; span: Span; /** see TraceDoc; absent or 0: no timestamps */ wallOffsetUs?: number }

const ctxKey = (c: Context): ContextKey => ({ session: c.sessionId, module: c.module, action: c.action })
const sameCtx = (a: ContextKey, b: ContextKey) => a.session === b.session && a.module === b.module && a.action === b.action

/** The current Pivot configuration of a store's state, with stable keys. */
export function pivotConfigOf(s: Pick<State, 'doc' | 'pivot' | 'window' | 'contexts' | 'includeIdle'>, opts: { clock?: boolean } = {}): PivotConfig {
  const p = s.pivot, doc = s.doc
  const cfg: PivotConfig = { fact: p.fact, by: [...p.by], sort: p.sort[p.fact], limit: p.limit, includeIdle: s.includeIdle }
  if (!doc) return cfg
  const base = doc.span.firstTim
  if (s.window) {
    cfg.window = { fromUs: s.window.startTim - base, toUs: s.window.endTim - base }
    if (opts.clock && doc.wallOffsetUs) cfg.windowClock = { fromWallUs: doc.wallOf(s.window.startTim), toWallUs: doc.wallOf(s.window.endTim) }
  }
  if (s.contexts) {
    const keys: ContextKey[] = []
    for (const id of [...s.contexts].sort((a, b) => a - b)) {
      const c = doc.contexts[id]
      if (c && !keys.some((k) => sameCtx(k, ctxKey(c)))) keys.push(ctxKey(c))
    }
    cfg.contexts = keys
  }
  if (p.stmt !== null && doc.statements[p.stmt]) cfg.stmt = stmtRef(doc.statements[p.stmt])
  if (p.event !== null && doc.events[p.event]) cfg.event = doc.events[p.event].name
  return cfg
}

/**
 * The state that shows `cfg` on `doc`, and the parts of it that do not exist there (dropped, in
 * words). The window keeps its offsets from the trace start and is cut to the trace's span.
 */
export function resolvePivotConfig(doc: PivotDoc, cfg: PivotConfig, cur: PivotState): { patch: Partial<State>; dropped: string[] } {
  const dropped: string[] = []
  const fact: Fact = cfg.fact === 'waits' ? 'waits' : 'calls'
  const measures = pivotMeasures(fact)
  const sort = measures.some((m) => m.id === cfg.sort) ? cfg.sort : cur.sort[fact]
  if (sort !== cfg.sort) dropped.push(`sort by ${cfg.sort}`)
  const pivot: PivotState = {
    ...cur, fact, by: cfg.by.length ? cfg.by.slice(0, 2) : [fact === 'calls' ? 'stmt' : 'event'],
    sort: { ...cur.sort, [fact]: sort }, limit: cfg.limit > 0 ? cfg.limit : cur.limit, stmt: null, event: null, notice: null,
  }
  const patch: Partial<State> = { pivot, view: 'pivot', includeIdle: cfg.includeIdle, window: null, contexts: null }

  if (cfg.windowClock && doc.wallOffsetUs) {
    const from = cfg.windowClock.fromWallUs - doc.wallOffsetUs, to = cfg.windowClock.toWallUs - doc.wallOffsetUs
    if (to <= doc.span.firstTim || from >= doc.span.lastTim) dropped.push('time window (that clock time is outside this trace)')
    else patch.window = { startTim: Math.max(doc.span.firstTim, from), endTim: Math.min(doc.span.lastTim, to) }
  } else if (cfg.window) {
    const span = Math.max(0, doc.span.lastTim - doc.span.firstTim)
    if (cfg.window.fromUs >= span) dropped.push('time window (after the end of this trace)')
    else patch.window = { startTim: doc.span.firstTim + Math.max(0, cfg.window.fromUs), endTim: doc.span.firstTim + Math.min(span, cfg.window.toUs) }
  }
  if (cfg.contexts?.length) {
    const ids = new Set<ID>()
    let missing = 0
    for (const k of cfg.contexts) {
      const hit = doc.contexts.filter((c) => sameCtx(ctxKey(c), k))
      if (hit.length === 0) missing++
      for (const c of hit) ids.add(c.id)
    }
    if (ids.size) patch.contexts = ids
    if (missing) dropped.push(ids.size ? `${missing} of ${cfg.contexts.length} session contexts` : 'session contexts')
  }
  if (cfg.stmt) {
    const id = resolveStmt(doc, cfg.stmt)
    if (id === null) dropped.push(`statement ${cfg.stmt.sqlId || cfg.stmt.hash}`)
    else pivot.stmt = id
  }
  if (cfg.event) {
    const ev = doc.events.find((e) => e.name === cfg.event)
    if (!ev) dropped.push(`event "${cfg.event}"`)
    else pivot.event = ev.id
  }
  if (dropped.length) pivot.notice = `not in this trace, left out: ${dropped.join(', ')}`
  return { patch, dropped }
}

// ---- the library file -------------------------------------------------------------------------------

export interface SavedPivot {
  id: string
  name: string
  config: PivotConfig
  /** ms since the epoch */
  created: number
  updated: number
}

/** `{version: 1, pivots}` (the desktop app's `mtkprof-library.json`). */
export interface LibraryFile { version: 1; exported?: string; pivots: SavedPivot[] }

export function libraryFile(pivots: SavedPivot[], now = new Date()): LibraryFile {
  return { version: 1, exported: now.toISOString(), pivots }
}

function validSaved(x: unknown): x is SavedPivot {
  if (!x || typeof x !== 'object') return false
  const p = x as SavedPivot
  const c = p.config
  return typeof p.id === 'string' && !!p.id && typeof p.name === 'string' && typeof p.updated === 'number'
    && !!c && typeof c === 'object' && (c.fact === 'calls' || c.fact === 'waits') && Array.isArray(c.by) && c.by.every((b) => typeof b === 'string') && typeof c.sort === 'string'
}

const validClock = (w: unknown): w is NonNullable<PivotConfig['windowClock']> => {
  const c = w as PivotConfig['windowClock'] | null | undefined
  return !!c && typeof c === 'object' && Number.isFinite(c.fromWallUs) && Number.isFinite(c.toWallUs) && c.toWallUs > c.fromWallUs
}

/** Reads a library file (or the `library` part of an export of everything); invalid entries are counted in `skipped`. */
export function parseLibraryFile(text: string): { pivots: SavedPivot[]; skipped: number } {
  let f: LibraryFile & { library?: LibraryFile }
  try { f = JSON.parse(text) as LibraryFile } catch (e) { throw new Error(`not JSON: ${e instanceof Error ? e.message : String(e)}`) }
  const lib = f && typeof f === 'object' && !Array.isArray(f.pivots) && f.library ? f.library : f
  if (!lib || typeof lib !== 'object' || !Array.isArray(lib.pivots)) throw new Error('not a library file (no "pivots" list)')
  if (lib.version !== 1) throw new Error(`library file version ${String(lib.version)} (this app reads 1)`)
  const pivots: SavedPivot[] = []
  let skipped = 0
  for (const p of lib.pivots) {
    if (!validSaved(p)) { skipped++; continue }
    const config: PivotConfig = { ...p.config, limit: Number(p.config.limit) || 1000, includeIdle: p.config.includeIdle !== false }
    if (!validClock(config.windowClock)) delete config.windowClock
    pivots.push({ ...p, created: typeof p.created === 'number' ? p.created : p.updated, config })
  }
  return { pivots, skipped }
}

/** Import: by id, the newer one wins; sorted by name. */
export function mergeLibrary(cur: SavedPivot[], incoming: SavedPivot[]): SavedPivot[] {
  const m = new Map(cur.map((p) => [p.id, p]))
  for (const p of incoming) {
    const old = m.get(p.id)
    if (!old || p.updated > old.updated) m.set(p.id, p)
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name) || a.created - b.created)
}

/** A one-line summary of a config (the library list). */
export function describePivotConfig(c: PivotConfig): string {
  const parts = [`${c.fact} by ${c.by.join(' → ')}`, `sort ${c.sort}`]
  if (c.window) parts.push(c.windowClock ? 'window (clock time)' : 'window')
  if (c.contexts?.length) parts.push(`${c.contexts.length} context${c.contexts.length === 1 ? '' : 's'}`)
  if (c.stmt) parts.push(`statement ${c.stmt.sqlId || c.stmt.hash}`)
  if (c.event) parts.push(`event ${c.event}`)
  if (c.fact === 'waits' && !c.includeIdle) parts.push('idle hidden')
  return parts.join(' · ')
}
