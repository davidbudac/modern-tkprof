import type { TraceDoc } from '../data/doc'
import { useStore, actions } from './store'
import { EventDetail } from '../views/EventDetail'

/** Right-hand panel for a selected wait event (statements open in the Statements workbench instead). */
export function Inspector({ doc }: { doc: TraceDoc }) {
  const event = useStore((s) => s.selection.event)
  if (event === null) return null
  const title = doc.events[event]?.name ?? 'Event'
  return (
    <aside className="inspector" aria-label="Details">
      <div className="inspector-head">
        <h2>{title}</h2>
        <button onClick={() => actions.selectEvent(null)} aria-label="Close details">Close</button>
      </div>
      <div className="inspector-body"><EventDetail doc={doc} id={event} /></div>
    </aside>
  )
}
