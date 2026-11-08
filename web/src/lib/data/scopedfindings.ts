// The findings the views show: `doc.stats.findings` for the whole trace, the findings of the scope when a time window, a
// context selection or a file selection narrows it (asked from the source: the engine's `api/findings`, or computed from the
// fact columns by findings.ts).
import type { TraceDoc } from './doc'
import type { Finding } from './types'
import { scopeNarrows } from '../state/store'
import { scopeKey, useScope } from './scopedstmts'
import { sourceOf, useSourceQuery, type QueryState } from './source'

export interface ScopedFindings {
  /** the scope's findings when `narrowed`, else the whole trace's */
  findings: Finding[]
  narrowed: boolean
  /** the scope narrows the trace but its findings are on their way (`findings` are the whole trace's until then) */
  loading: boolean
  /** why the whole-trace findings are shown although the scope narrows it */
  notice: string | null
}

export function useScopedFindings(doc: TraceDoc): ScopedFindings {
  const scope = useScope(doc)
  const narrows = scopeNarrows(scope)
  const source = sourceOf(doc)
  const q = useSourceQuery(source, narrows ? `findings:${scopeKey(scope)}` : 'findings:all', (signal) => (narrows ? source.findings(scope, signal) : null), 'findings')
  return scopedFindingsView(doc.stats.findings, narrows, q)
}

/**
 * What `useScopedFindings` shows (pure): the scope's answer is `narrowed` only when it is this scope's; another scope's
 * (retained while this one loads, `stale`) would be labelled with this selection, so the whole set is shown with `loading`
 * until it arrives. Statements counts findings per row from `.findings`: they are the whole set's until then too.
 */
export function scopedFindingsView(all: Finding[], narrows: boolean, q: QueryState<Finding[] | null>): ScopedFindings {
  if (!narrows) return { findings: all, narrowed: false, loading: false, notice: null }
  if (q.data && !q.stale) return { findings: q.data, narrowed: true, loading: q.loading, notice: null }
  const notice = q.loading ? null
    : q.error ? `Findings of the selection unavailable (${q.error}): the findings are for the whole set.`
    : 'This engine does not answer findings for a selection: the findings are for the whole set.'
  return { findings: all, narrowed: false, loading: q.loading, notice }
}
