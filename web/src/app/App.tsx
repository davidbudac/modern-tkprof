import { useEffect } from 'react'
import { useStore, actions, setState } from './store'
import { TopBar } from './TopBar'
import { Rail } from './Rail'
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
  const stmt = useStore((s) => s.selection.stmt)
  const event = useStore((s) => s.selection.event)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { actions.selectStmt(null); actions.selectEvent(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (loading) return <div className="loading"><p>Loading trace…</p></div>
  if (!doc) return <Landing error={error} />

  const hasInspector = stmt !== null || event !== null
  return (
    <div className={'shell' + (hasInspector ? ' has-inspector' : '')}>
      <TopBar doc={doc} />
      <Rail />
      <main className="main">
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
      <h1>mtkprof</h1>
      <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]) }}>
        <p>No trace document found. Drop a <code>mtkprof json</code> file here, or run <code>mtkprof serve trace.trc</code> and open the address it prints.</p>
        <p style={{ marginBlockStart: '1rem' }}><input type="file" accept=".json,application/json" onChange={(e) => onFile(e.target.files?.[0])} /></p>
        {error && <p className="callout" style={{ marginBlockStart: '1rem' }}>{error}</p>}
      </div>
    </div>
  )
}
