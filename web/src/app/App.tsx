import { useEffect } from 'react'
import { useStore, actions, getState, setState } from './store'
import { TopBar, SubBar } from './TopBar'
import { Inspector } from './Inspector'
import { Overview } from '../views/Overview'
import { Statements } from '../views/Statements'
import { Waits } from '../views/Waits'
import { Timeline } from '../views/Timeline'
import { Sessions } from '../views/Sessions'
import { Pivot } from '../views/Pivot'
import { loadFile } from '../data/load'

export function App() {
  const doc = useStore((s) => s.doc)
  const loading = useStore((s) => s.loading)
  const error = useStore((s) => s.error)
  const view = useStore((s) => s.view)
  const event = useStore((s) => s.selection.event)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Esc closes the inspector first, then clears the time window
      const s = getState()
      if (s.selection.event !== null) actions.selectEvent(null)
      else if (s.window) actions.setWindow(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (loading) return <div className="loading"><p>Loading trace…</p></div>
  if (!doc) return <Landing error={error} />

  const hasInspector = event !== null
  const full = view === 'statements'
  return (
    <div className={'shell' + (hasInspector ? ' has-inspector' : '')}>
      <TopBar doc={doc} />
      <SubBar doc={doc} />
      <main className={'main' + (full ? ' full' : '')}>
        {view === 'overview' && <Overview doc={doc} />}
        {view === 'statements' && <Statements doc={doc} />}
        {view === 'waits' && <Waits doc={doc} />}
        {view === 'timeline' && <Timeline doc={doc} />}
        {view === 'sessions' && <Sessions doc={doc} />}
        {view === 'pivot' && <Pivot doc={doc} />}
      </main>
      {hasInspector && <Inspector doc={doc} />}
    </div>
  )
}

function Landing({ error }: { error: string | null }) {
  const onFile = async (f: File | undefined) => {
    if (!f) return
    setState({ loading: true })
    try { setState({ doc: await loadFile(f), loading: false, error: null }) } catch (e) { setState({ loading: false, error: String(e) }) }
  }
  return (
    <div className="loading">
      <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onFile(e.dataTransfer.files[0]) }}>
        <h1>mtkprof</h1>
        <p className="muted">Open a trace document (<code>mtkprof json -packed</code>) to explore it, or run <code>mtkprof serve trace.trc</code>.</p>
        {error && <p className="muted small">Could not load the embedded document: {error}</p>}
        <p><input type="file" accept=".json,application/json" onChange={(e) => void onFile(e.target.files?.[0])} /></p>
      </div>
    </div>
  )
}
