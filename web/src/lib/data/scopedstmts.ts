// The statement table the views show: `doc.stats.statements` for the whole trace, the statistics of the scope when a time window,
// a context selection or a file selection narrows it (asked from the source: the engine's `api/statements`, or computed from
// the fact columns).
import { useMemo } from 'react'
import { ctxKey } from './fileset'
import type { TraceDoc } from './doc'
import type { StmtStats } from './types'
import { scopeNarrows, scopeOf } from '../state/store'
import { useStore } from '../state/session'
import { sourceOf, useSourceQuery } from './source'

export interface ScopedStatements {
  /** per statement id, in id order: the scope's numbers when `narrowed`, else the whole trace's */
  stats: StmtStats[]
  /** `stats` are the numbers of the scope (statements with no call in scope have `allCalls.count` 0) */
  narrowed: boolean
  /** the scope narrows the trace but its numbers are on their way (`stats` are the whole trace's until then) */
  loading: boolean
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
  const stateWindow = useStore((s) => s.window)
  const window = opts.withWindow === false ? null : stateWindow
  const files = useStore((s) => s.files)
  const contexts = useStore((s) => s.contexts)
  const scope = scopeOf({ doc, window, files, contexts, includeIdle: true })
  const narrows = scopeNarrows(scope)
  const source = sourceOf(doc)
  const key = `stmts:${scope.window ? `${scope.window.startTim}:${scope.window.endTim}` : ''}|${ctxKey(scope.contexts)}`
  const q = useSourceQuery(source, narrows ? key : 'stmts:all', (signal) => (narrows ? source.statements(scope, signal) : null), 'stmts')
  const base = doc.stats.statements
  const total = useMemo(() => base.filter(hasWork).length, [base])
  if (!narrows) return { stats: base, narrowed: false, loading: false, notice: null, inScope: total, total }
  if (q.data) return { stats: q.data, narrowed: true, loading: q.loading, notice: null, inScope: q.data.filter((s) => s.allCalls.count > 0).length, total }
  const notice = q.loading ? null
    : q.error ? `Statistics of the selection unavailable (${q.error}): the numbers are for the whole set.`
    : 'This engine does not answer statistics for a selection: the numbers are for the whole set.'
  return { stats: base, narrowed: false, loading: q.loading, notice, inScope: total, total }
}
