import type { TraceDoc } from '../data/doc'
import { fmtDur, fmtWall, fmtTz, fmtBytes } from '../data/format'
import { useStore, actions } from './store'

export function TopBar({ doc }: { doc: TraceDoc }) {
  const win = useStore((s) => s.window)
  const ctxs = useStore((s) => s.contexts)
  const theme = useStore((s) => s.theme)
  const c0 = doc.contexts[0]
  const name = (doc.file.traceFile || doc.file.path).split(/[\\/]/).pop()
  return (
    <header className="topbar">
      <span className="brand">mtkprof</span>
      <span className="fact mono" title={doc.file.traceFile}><b>{name}</b></span>
      {doc.file.version && <span className="fact">Oracle <b>{doc.file.version}</b></span>}
      {doc.file.instance && <span className="fact">instance <b>{doc.file.instance}</b> on {doc.file.node}</span>}
      {c0?.sessionId && <span className="fact">session <b>{c0.sessionId}</b></span>}
      {c0?.module && <span className="fact">module <b>{c0.module}</b></span>}
      <span className="fact">
        {doc.span.firstWallUs
          ? <>{fmtWall(doc.span.firstWallUs, doc.tzOffsetMin, { date: true })} → {fmtWall(doc.span.lastWallUs, doc.tzOffsetMin)} {fmtTz(doc.tzOffsetMin)}</>
          : <>no wall clock</>}
        {' '}<b>{fmtDur(doc.spanUs())}</b>
      </span>
      <span className="fact">{fmtBytes(doc.diag.bytes)}</span>
      <span className="spacer" />
      {win && <span className="chip">time window {fmtDur(win.endTim - win.startTim)} <button onClick={() => actions.setWindow(null)} aria-label="Clear time window">×</button></span>}
      {ctxs && <span className="chip">{ctxs.size} session context{ctxs.size === 1 ? '' : 's'} <button onClick={() => actions.setContexts(null)} aria-label="Clear context filter">×</button></span>}
      <span className="seg" role="group" aria-label="Theme">
        {(['auto', 'light', 'dark'] as const).map((t) => (
          <button key={t} aria-pressed={theme === t} onClick={() => actions.setTheme(t)}>{t}</button>
        ))}
      </span>
    </header>
  )
}
