import type { TraceDoc } from '../data/doc'
import type { EvidenceRow, Finding, ID } from '../data/types'
import { actions } from '../app/store'

/** Rule hits from the Go analyzer (fixed thresholds), most severe first. */
export function Findings({ doc }: { doc: TraceDoc }) {
  const findings = doc.stats.findings
  if (!findings.length) return null
  const counts = { serious: 0, notable: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  const hint = (['serious', 'notable', 'info'] as const).filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ')
  return (
    <section className="section">
      <header><h2>Findings</h2><span className="hint">{hint}; fixed thresholds, whole trace (the time window does not apply)</span></header>
      <ul className="findings">
        {findings.map((f, i) => <FindingItem key={`${f.rule}-${f.statement}-${i}`} doc={doc} f={f} />)}
      </ul>
    </section>
  )
}

function StmtLink({ doc, id }: { doc: TraceDoc; id: ID }) {
  const st = doc.statements[id]
  if (!st) return null
  return (
    <button className="link mono"
      onClick={(e) => { e.preventDefault(); actions.selectStmt(id) }} title="inspect this statement">
      {doc.label(st)}
    </button>
  )
}

function FindingItem({ doc, f }: { doc: TraceDoc; f: Finding }) {
  // statement findings start with the sql_id, which the link already shows
  const lbl = f.statement >= 0 && doc.statements[f.statement] ? doc.label(doc.statements[f.statement]) : ''
  const summary = lbl && f.summary.startsWith(lbl) ? f.summary.slice(lbl.length).replace(/^[:\s]+/, '') : f.summary
  return (
    <li className={`finding sev-${f.severity}`}>
      <details open={f.severity !== 'info'}>
        <summary>
          <span className="sev">{f.severity}</span>
          <span className="finding-text">
            <b>{f.title}</b>
            {f.statement >= 0 && <> <StmtLink doc={doc} id={f.statement} /></>}
            <span className="muted"> {summary}</span>
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
      <td className="text">{r.value}</td>
      <td className="dim tabular">{r.line ? `line ${r.line}` : ''}</td>
    </tr>
  )
}
