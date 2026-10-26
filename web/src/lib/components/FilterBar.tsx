import { useMemo } from 'react'
import type { TraceDoc } from '../data/doc'
import { activeFilters, type FilterKind } from '../data/filters'
import { useAxis } from '../data/scopedstmts'
import { useActions, useStore } from '../state/session'

/** What each filter is called in the label of its remove button. */
const what: Record<FilterKind, string> = { files: 'file selection', sessions: 'session selection', window: 'time window', idle: 'hidden idle waits' }

/**
 * The global filters in force (file selection, session selection, time window, hidden idle waits) as one row under the top bar: a
 * chip each, whose text goes to where the filter is set and whose × removes it, and *Clear all* for several. An empty element
 * (no room) when nothing is filtered, so the shell's grid keeps its row.
 */
export function FilterBar({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  const files = useStore((s) => s.files)
  const contexts = useStore((s) => s.contexts)
  const win = useStore((s) => s.window)
  const block = useStore((s) => s.block)
  const includeIdle = useStore((s) => s.includeIdle)
  const { base } = useAxis(doc) // +offsets count from the axis start, as the window bar's
  const list = useMemo(() => activeFilters(doc, { files, contexts, window: win, block, includeIdle }, base), [doc, files, contexts, win, block, includeIdle, base])
  const go: Record<FilterKind, () => void> = {
    files: () => actions.setFilesOpen(true),
    sessions: () => actions.setView('sessions'),
    window: () => actions.setView('overview'),
    idle: () => actions.setView('waits'),
  }
  const remove: Record<FilterKind, () => void> = {
    files: () => actions.setFiles(null),
    sessions: () => actions.setContexts(null),
    window: () => actions.setWindow(null),
    idle: () => actions.toggleIdle(),
  }
  return (
    <div className="filterbar" role="region" aria-label="Active filters">
      {list.length > 0 && (
        <>
          <span className="dim filterbar-label">Filters</span>
          {list.map((f) => (
            <span className={`chip filter-${f.kind}`} key={f.kind}>
              <button onClick={go[f.kind]} title={f.title}><b>{f.label}</b> {f.text}</button>
              <button onClick={remove[f.kind]} aria-label={`Remove filter: ${what[f.kind]}`} title="remove this filter">×</button>
            </span>
          ))}
          {list.length > 1 && <button className="quiet" onClick={() => list.forEach((f) => remove[f.kind]())} title="remove every filter">Clear all</button>}
        </>
      )}
    </div>
  )
}
