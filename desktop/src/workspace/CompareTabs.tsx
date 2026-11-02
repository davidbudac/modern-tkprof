import { useEffect, useRef, useState } from 'react'
import './compareTabs.css'
import { Compare, SessionProvider } from '@lib'
import { useWorkspace, useWorkspaceState } from './WorkspaceProvider'
import { canCompare, type Tab } from './workspace'
import { comparisonSource } from './comparisonSource'

/** The `Compare tabs…` button and its picker for the two ordered full-trace inputs (B against baseline A); the open screen's card holds it. */
export function CompareTabsButton() {
  const { tabs } = useWorkspaceState()
  const [request, setRequest] = useState<CompareRequest | null>(null)
  return <>
    <button disabled={tabs.filter(canCompare).length < 2} onClick={() => setRequest({})} title="Compare these two tabs: choose baseline A and trace B">Compare tabs…</button>
    <CompareTabsDialog request={request} onClose={() => setRequest(null)} />
  </>
}

/** `a`: the tab to preselect as baseline A (a tab's context menu); B starts as another ready tab. */
export interface CompareRequest { a?: string }

/** The picker for baseline A and trace B; open while `request` is set. */
export function CompareTabsDialog({ request, onClose }: { request: CompareRequest | null; onClose: () => void }) {
  const ws = useWorkspace()
  const { tabs } = useWorkspaceState()
  const ready = tabs.filter(canCompare)
  const dialog = useRef<HTMLDialogElement>(null)
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const open = request !== null
  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (!request) { if (d.open) d.close(); return }
    const first = request.a && ready.some((t) => t.key === request.a) ? request.a : ready[0]?.key ?? ''
    setA(first); setB(ready.find((t) => t.key !== first)?.key ?? ''); setError('')
    if (!d.open) d.showModal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])
  const submit = async () => {
    setBusy(true); setError('')
    try { await ws.compare(a, b); onClose() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return (
    <dialog ref={dialog} className="compare-picker" aria-labelledby="compare-tabs-title" onClose={() => open && onClose()} onCancel={(e) => { if (busy) e.preventDefault() }}>
      <section className="blocker-card">
        <h2 id="compare-tabs-title">Compare these two tabs</h2>
        <p>Choose a baseline (A) and trace (B). Deltas are B − A.</p>
        <p className="muted">Compares whole traces, ignoring tab filters. Live and opening tabs cannot be compared.</p>
        <p><label>Baseline A <select autoFocus value={a} onChange={(e) => setA(e.target.value)} disabled={busy}>{ready.map((t) => <option key={t.key} value={t.key}>{label(t, tabs)}</option>)}</select></label></p>
        <p><label>Trace B <select value={b} onChange={(e) => setB(e.target.value)} disabled={busy}>{ready.map((t) => <option key={t.key} value={t.key}>{label(t, tabs)}</option>)}</select></label></p>
        {error && <p role="alert">{error}</p>}
        <p><button disabled={busy || a === b || !ready.some((t) => t.key === a) || !ready.some((t) => t.key === b)} onClick={() => void submit()}>{busy ? 'Comparing…' : 'Compare'}</button> <button disabled={busy} onClick={onClose}>Cancel</button></p>
      </section>
    </dialog>
  )
}

const label = (t: Tab, tabs: Tab[]) => `${tabs.findIndex((x) => x.key === t.key) + 1}. ${t.title} · ${t.set.paths.join(', ')}`

/** Fixed comparison has no server mount; statement links return to original tabs. */
export function ComparisonTab({ tab }: { tab: Tab }) {
  const ws = useWorkspace()
  const { tabs } = useWorkspaceState()
  const [error, setError] = useState('')
  const data = tab.session?.store.getState().compare
  if (!data || !tab.session || !tab.comparison) return null
  return <SessionProvider session={tab.session}>
    <div className="comparison-snapshot">
      <div className="tab-banner" role="note">Fixed snapshot of whole traces. Source filters are ignored. Comparison tabs are not restored when the app closes. Open A or B to inspect a statement in its original tab, keeping that tab’s filters.</div>
      {error && <div className="tab-banner bad" role="alert">{error}</div>}
      <main className="main">
        <p className="small muted">A: {tab.comparison.labelA}<br />B: {tab.comparison.labelB}</p>
        <Compare data={data} onOpenStatement={(side, id) => {
          let source: Tab
          try { source = comparisonSource(tab, side, tabs) } catch (e) { setError(e instanceof Error ? e.message : String(e)); return }
          setError('')
          source.session!.store.actions.selectStmt(id)
          source.session!.store.actions.setView('statements')
          ws.go({ kind: 'tab', key: source.key })
        }} />
      </main>
    </div>
  </SessionProvider>
}
