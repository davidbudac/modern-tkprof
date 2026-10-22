import { useStore, actions, type View } from './store'

const views: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'statements', label: 'Statements' },
  { id: 'waits', label: 'Waits' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'pivot', label: 'Pivot' },
]

export function Rail() {
  const view = useStore((s) => s.view)
  const doc = useStore((s) => s.doc)
  const counts: Partial<Record<View, number>> = doc ? {
    statements: doc.statements.length,
    waits: doc.events.length,
    sessions: doc.contexts.length,
  } : {}
  return (
    <nav className="rail" aria-label="Views">
      {views.map((v) => (
        <button key={v.id} aria-current={view === v.id ? 'page' : undefined} onClick={() => actions.setView(v.id)}>
          <span>{v.label}</span>
          {counts[v.id] !== undefined && <small>{counts[v.id]}</small>}
        </button>
      ))}
    </nav>
  )
}
