// The statement table the views show: `doc.stats.statements` for the whole trace, the statistics of the scope when a time window,
// a context selection or a file selection narrows it (asked from the source: the engine's `api/statements`, or computed from
// the fact columns).
import { useMemo } from 'react'
import { ctxKey } from './fileset'
import type { TraceDoc } from './doc'
import type { StmtStats } from './types'
import { scopeNarrows, scopeOf, type Scope } from '../state/store'
import { useStore } from '../state/session'
import { sourceOf, useSourceQuery } from './source'

/** The window and context filter as a cache key (the idle toggle is not part of it: calls and statement lists ignore it). */
export function scopeKey(scope: Pick<Scope, 'window' | 'contexts'>): string {
  return `${scope.window ? `${scope.window.startTim}:${scope.window.endTim}` : ''}|${ctxKey(scope.contexts)}`
}

/**
 * The scope the views query the source with: the store's window, the effective contexts (explicit selection and selected
 * files), the idle toggle. `withWindow: false` leaves the window out (the lanes).
 */
export function useScope(doc: TraceDoc, opts: { withWindow?: boolean } = {}): Scope {
  const stateWindow = useStore((s) => s.window)
  const window = opts.withWindow === false ? null : stateWindow
  const files = useStore((s) => s.files)
  const contexts = useStore((s) => s.contexts)
  const includeIdle = useStore((s) => s.includeIdle)
  return useMemo(() => scopeOf({ doc, window, files, contexts, includeIdle }), [doc, window, files, contexts, includeIdle])
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
 * contexts only: dragging a window there must not change the rows).
 */
export function useScopedStatements(doc: TraceDoc, opts: { withWindow?: boolean } = {}): ScopedStatements {
  const scope = useScope(doc, opts)
  const narrows = scopeNarrows(scope)
  const source = sourceOf(doc)
  const key = `stmts:${scopeKey(scope)}`
  const q = useSourceQuery(source, narrows ? key : 'stmts:all', (signal) => (narrows ? source.statements(scope, signal) : null), 'stmts')
  const base = doc.stats.statements
  const total = useMemo(() => base.filter(hasWork).length, [base])
  if (!narrows) return { stats: base, narrowed: false, loading: false, pending: false, notice: null, inScope: total, total }
  if (q.data) return { stats: q.data, narrowed: true, loading: q.loading, pending: false, notice: null, inScope: q.data.filter((s) => s.allCalls.count > 0).length, total }
  const notice = q.loading ? null
    : q.error ? `Statistics of the selection unavailable (${q.error}): the numbers are for the whole set.`
    : 'This engine does not answer statistics for a selection: the numbers are for the whole set.'
  return { stats: base, narrowed: false, loading: q.loading, pending: q.loading, notice, inScope: total, total }
}
