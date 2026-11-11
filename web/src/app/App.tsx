import { useMemo, useState } from 'react'
import {
  useStore, useStoreApi, usePersisted, ResizeHandle, PaneToggle, FilesPane, FilterBar, Inspector, LineDrawer, ViewErrorBoundary,
  baseViews, currentView, useViewKeys, useShellPanes, useEscapeChain, loadFile, RefImportHost,
} from '@lib'
import { TopBar, SubBar } from './TopBar'

export function App() {
  const store = useStoreApi()
  const doc = useStore((s) => s.doc)
  const loading = useStore((s) => s.loading)
  const error = useStore((s) => s.error)
  const view = useStore((s) => s.view)
  // the row of the view table to render (lib/shell/views.tsx); Compare renders from `compare`, so a new comparison re-renders too
  const current = useStore((s) => (s.doc ? currentView(baseViews, s.doc, s) : null))
  useStore((s) => s.compare)
  const lines = useStore((s) => s.lineViewer !== null)
  const [infoBar, setInfoBar] = usePersisted<boolean>('mtkprof.infoBar', true)
  const [inspectorW, setInspectorW] = usePersisted<number | null>('mtkprof.inspectorW', null)
  const [filesW, setFilesW] = usePersisted<number | null>('mtkprof.filesW', null)
  // collapsed, the details pane stays collapsed for the next event too (as in the desktop); its tab is there while an event is selected
  const [inspectorPref, setInspectorPref] = useState(true)
  const panes = useShellPanes({ inspectorOpen: inspectorPref, inspectorW, filesW })
  useEscapeChain()
  useViewKeys(store, baseViews)
  // another document or another view clears a crashed view's error card
  const resetKey = useMemo(() => ({ doc, view }), [doc, view])

  if (loading) return <div className="loading"><p>Loading trace…</p></div>
  if (!doc || !current) return <Landing error={error} />

  const path = doc.file.traceFile || doc.file.path
  return (
    <div className={'shell' + panes.shellClass + (lines ? ' has-lines' : '') + (infoBar ? '' : ' no-subbar')}>
      <TopBar doc={doc} onShowInfo={infoBar ? undefined : () => setInfoBar(true)} />
      {doc.opt ? <div /> : <FilterBar doc={doc} />}{/* a 10053 file has no scope to filter; the row stays (the shell's grid) */}
      {infoBar && <SubBar doc={doc} onClose={() => setInfoBar(false)} />}
      <div className="body" ref={panes.body} style={panes.bodyStyle}>
        {!doc.opt && <FilesPane doc={doc} onWidth={setFilesW} />}
        <ViewErrorBoundary title={path.split(/[\\/]/).pop() ?? path} context={[`path: ${path}`, `view: ${current.id}`]} resetKey={resetKey}>
          <main className={'main' + (current.full ? ' full' : '')}>{current.render(doc, store.getState())}</main>
        </ViewErrorBoundary>
        {panes.inspectorOpen && <Inspector doc={doc} />}
        {panes.inspectorOpen && <ResizeHandle anchor="end" className="resizer-inspector" label="Resize details pane" onChange={setInspectorW} />}
        {panes.eventView && <PaneToggle open={panes.inspectorOpen} onToggle={() => setInspectorPref(!panes.inspectorOpen)} label="details pane" className="inspector-toggle" />}
      </div>
      {lines && <LineDrawer />}
      <RefImportHost />
    </div>
  )
}

function Landing({ error }: { error: string | null }) {
  const store = useStoreApi()
  const onFile = async (f: File | undefined) => {
    if (!f) return
    store.setState({ loading: true })
    try { store.setLoaded(await loadFile(f)) } catch (e) { store.setState({ loading: false, error: String(e) }) }
  }
  return (
    <div className="loading">
      <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onFile(e.dataTransfer.files[0]) }}>
        <h1>mtkprof</h1>
        <p className="muted">Open a document from <code>mtkprof json -packed</code> or <code>mtkprof json a.trc b.trc -compare -packed</code>, or run <code>mtkprof serve trace.trc</code>.</p>
        {error && <p className="muted small">Embedded document load failed: {error}</p>}
        <p><input type="file" accept=".json,application/json" onChange={(e) => void onFile(e.target.files?.[0])} /></p>
      </div>
    </div>
  )
}
