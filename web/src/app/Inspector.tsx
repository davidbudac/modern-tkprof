import type { TraceDoc } from '../data/doc'
import { useStore, actions } from './store'
import { StatementDetail } from '../views/StatementDetail'
import { EventDetail } from '../views/EventDetail'

export function Inspector({ doc }: { doc: TraceDoc }) {
  const stmt = useStore((s) => s.selection.stmt)
  const event = useStore((s) => s.selection.event)
  const close = () => { actions.selectStmt(null); actions.selectEvent(null) }
  let title = '', body = null
  if (stmt !== null) {
    const s = doc.statements[stmt]
    title = s ? doc.label(s) : 'Statement'
    body = <StatementDetail doc={doc} id={stmt} />
  } else if (event !== null) {
    title = doc.events[event]?.name ?? 'Event'
    body = <EventDetail doc={doc} id={event} />
  }
  return (
    <aside className="inspector" aria-label="Details">
      <div className="inspector-head">
        <h2 className="mono">{title}</h2>
        <button onClick={close} aria-label="Close details">Close</button>
      </div>
      <div className="inspector-body">{body}</div>
    </aside>
  )
}
