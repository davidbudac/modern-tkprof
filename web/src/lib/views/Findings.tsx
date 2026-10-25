import type { TraceDoc } from '../data/doc'
import type { EvidenceRow, Finding } from '../data/types'
import { useActions } from '../state/session'
import { StmtLink, LinkText } from '../components/StmtLink'
import { LineRef } from '../components/LineRef'

/** Rule hits from the Go analyzer (configurable thresholds), most severe first. */
export function Findings({ doc }: { doc: TraceDoc }) {
  const findings = doc.stats.findings
  const cfg = Object.entries(doc.stats.findingsConfig)
  if (!findings.length && !cfg.length) return null
  const counts = { serious: 0, notable: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  const hint = (['serious', 'notable', 'info'] as const).filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ')
  return (
    <section className="section">
      <header><h2>Findings</h2><span className="hint">{hint} · whole trace, window not applied</span></header>
      <ul className="findings">
        {findings.map((f, i) => <FindingItem key={`${f.rule}-${f.statement}-${i}`} doc={doc} f={f} />)}
      </ul>
      {cfg.length > 0 && (
        <details className="thresholds">
          <summary className="muted">thresholds ({cfg.length}, <code>-findings-config</code>)</summary>
          <table className="tbl evidence">
            <tbody>
              {cfg.map(([k, v]) => <tr key={k}><td className="ev-label">{k}</td><td className="tabular">{v}</td></tr>)}
            </tbody>
          </table>
        </details>
      )}
    </section>
  )
}

/** The summary without the leading sql_id (the UI shows the statement separately). */
export function findingText(doc: TraceDoc, f: Finding): string {
  const lbl = f.statement >= 0 && doc.statements[f.statement] ? doc.label(doc.statements[f.statement]) : ''
  return lbl && f.summary.startsWith(lbl) ? f.summary.slice(lbl.length).replace(/^[:\s]+/, '') : f.summary
}

function FindingItem({ doc, f }: { doc: TraceDoc; f: Finding }) {
  const summary = findingText(doc, f)
  return (
    <li className={`finding sev-${f.severity}`}>
      <details open={f.severity === 'serious'}>
        <summary>
          <span className="sev">{f.severity}</span>
          <span className="finding-text">
            <b>{f.title}</b>
            {f.statement >= 0 && <> <StmtLink doc={doc} id={f.statement} /></>}
            <span className="muted"> <LinkText doc={doc} text={summary} /></span>
          </span>
        </summary>
        {f.evidence.length > 0 && (
          <table className="tbl evidence">
            <tbody>
              {f.evidence.map((r, j) => <Evidence key={j} doc={doc} f={f} r={r} />)}
            </tbody>
          </table>
        )}
      </details>
    </li>
  )
}

function Evidence({ doc, f, r }: { doc: TraceDoc; f: Finding; r: EvidenceRow }) {
  const actions = useActions()
  const own = r.statement >= 0 && r.statement !== f.statement
  const exec = r.statement >= 0 && r.cursor >= 0 && r.execNo
  const open = () => {
    if (r.statement < 0) return
    actions.selectStmt(r.statement)
    if (exec) actions.selectExec({ cursor: r.cursor, execNo: r.execNo! })
  }
  const label = own && r.label === doc.label(doc.statements[r.statement]) ? null : r.label
  return (
    <tr className={r.statement >= 0 ? 'row-click' : undefined} onClick={r.statement >= 0 ? open : undefined}>
      <td className="ev-label">{own && <StmtLink doc={doc} id={r.statement} />}{own && label ? ' ' : null}{label}</td>
      <td className="text"><LinkText doc={doc} text={r.value} /></td>
      <td className="dim tabular"><LineRef line={r.line ?? 0} file={r.cursor >= 0 ? doc.fileOfCursor(r.cursor) : r.statement >= 0 ? doc.fileOfStmt(r.statement) : 0} /></td>
    </tr>
  )
}
