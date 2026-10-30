// The statement table the views show: `doc.stats.statements` for the whole trace, the statistics of the scope when a time window,
// a context selection or a file selection narrows it (asked from the source: the engine's `api/statements`, or computed from
// the fact columns).
import { useMemo } from 'react'
import { ctxKey, selectionSpan } from './fileset'
import type { TraceDoc } from './doc'
import type { StmtStats } from './types'
import { scopeNarrows, scopeOf, type Scope, type TimeWindow } from '../state/store'
import { useStore } from '../state/session'
import { sourceOf, useSourceQuery } from './source'

/** The window and context filter as a cache key (the idle toggle is not part of it: calls and statement lists ignore it). */
export function scopeKey(scope: Pick<Scope, 'window' | 'contexts'>): string {
  return `${scope.window ? `${scope.window.startTim}:${scope.window.endTim}` : ''}|${ctxKey(scope.contexts)}`
}

/** `withWindow: false` leaves the store's window out (the lanes); `window` replaces it (null = none; keep the object stable: it is a memo key). */
export interface ScopeOpts { withWindow?: boolean; window?: TimeWindow | null }

/**
 * The scope the views query the source with: the store's window, the effective contexts (explicit selection and selected
 * files), the idle toggle. `withWindow: false` leaves the window out (the lanes), `window` replaces it (the zoomed lanes).
 */
export function useScope(doc: TraceDoc, opts: ScopeOpts = {}): Scope {
  const stateWindow = useStore((s) => s.window)
  const window = opts.window !== undefined ? opts.window : opts.withWindow === false ? null : stateWindow
  const files = useStore((s) => s.files)
  const contexts = useStore((s) => s.contexts)
  const includeIdle = useStore((s) => s.includeIdle)
  return useMemo(() => scopeOf({ doc, window, files, contexts, includeIdle }), [doc, window, files, contexts, includeIdle])
}

/**
 * The time axis of the lanes and the chart: the range of the selected files / sessions (`selectionSpan`), else the whole trace.
 * `base` is the first tim, `span` the length in µs; `narrowed` says the axis is shorter than the trace's (the minimap then shades it).
 */
export function useAxis(doc: TraceDoc): { base: number; span: number; narrowed: boolean } {
  const files = useStore((s) => s.files)
  const contexts = useStore((s) => s.contexts)
  return useMemo(() => {
    const r = selectionSpan(doc, files, contexts)
    const span = Math.max(0, r.lastTim - r.firstTim)
    return { base: r.firstTim, span, narrowed: r.firstTim > doc.span.firstTim || r.lastTim < doc.span.lastTim }
  }, [doc, files, contexts])
}

export interface ScopedStatements {
  /** per statement id, in id order: the scope's numbers when `narrowed`, else the whole trace's */
  stats: StmtStats[]
  /** `stats` are the numbers of the scope (statements with no call in scope have `allCalls.count` 0) */
  narrowed: boolean
  /** the scope narrows the trace but its numbers are on their way (`stats` are the whole trace's until then) */
  loading: boolean
  /** `loading` with nothing of the scope to show yet: a view that lists statements should list none rather than the whole trace's */
  pending: boolean
  /** why the whole-trace table is shown although the scope narrows it */
  notice: string | null
  /** statements with calls in scope / in the trace */
  inScope: number
  total: number
}

/** Statements with calls (or errors) in the whole trace. */
const hasWork = (s: StmtStats) => s.allCalls.count > 0 || s.errors > 0

/**
 * `withWindow: false` leaves the time window out (the Overview lanes and the Timeline pick their statements by the files and
 * contexts only: dragging a window there must not change the rows); `window` picks them over that range instead (the zoomed lanes).
 */
export function useScopedStatements(doc: TraceDoc, opts: ScopeOpts = {}): ScopedStatements {
  const scope = useScope(doc, opts)
  const narrows = scopeNarrows(scope)
  const source = sourceOf(doc)
  const key = `stmts:${scopeKey(scope)}`
  // Never retain another scope's totals: its numerator would be paired with this scope's response-time base.
  // useSourceQuery still retains the same key across live snapshots of the same lineage.
  const q = useSourceQuery(source, narrows ? key : 'stmts:all', (signal) => (narrows ? source.statements(scope, signal) : null))
  const base = doc.stats.statements
  const total = useMemo(() => base.filter(hasWork).length, [base])
  if (!narrows) return { stats: base, narrowed: false, loading: false, pending: false, notice: null, inScope: total, total }
  if (q.data) return { stats: q.data, narrowed: true, loading: q.loading, pending: false, notice: null, inScope: q.data.filter((s) => s.allCalls.count > 0).length, total }
  const notice = q.loading ? null
    : q.error ? `Statistics of the selection unavailable (${q.error}): the numbers are for the whole set.`
    : 'This engine does not answer statistics for a selection: the numbers are for the whole set.'
  return { stats: base, narrowed: false, loading: q.loading, pending: q.loading, notice, inScope: total, total }
}
