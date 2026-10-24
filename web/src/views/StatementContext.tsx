import type { TraceDoc } from '../data/doc'
import { StmtLink, LinkText } from '../components/StmtLink'
import type { ID } from '../data/types'
import { fmtDur, fmtInt, fmtPct, fmtWall, preview } from '../data/format'
import { actions } from '../app/store'
import { LineRef } from '../components/LineRef'
import { sourceOf, useSourceQuery } from '../data/source'
import { findingText } from './Findings'

/** The right-hand column of the workbench: where the statement ran, its waits, its relatives, its findings. */
export function StatementContext({ doc, id }: { doc: TraceDoc; id: ID }) {
  const st = doc.statements[id]
  const stats = doc.stats.statements[id]
  const source = sourceOf(doc)
  const waitsQ = useSourceQuery(source, `waits:${id}`, (signal) => (source.ready ? source.stmtWaits([id], 6, signal) : null), 'waits')
  if (!st || !stats) return null
  const ctx = st.cursors.length ? doc.contexts[doc.cursors[st.cursors[0]].context] : undefined
  const waits = waitsQ.data?.get(id) ?? []
  const children = stats.children ?? [], parents = stats.parents ?? []
  const findings = doc.stats.findings.filter((f) => f.statement === id)
  const assumed = st.cursors.some((c) => doc.cursors[c].assumed)
  return (
    <>
      <div className="ctx-sec">
        <h3>Context</h3>
        <dl className="kv">
          {stats.firstWallUs ? <><dt>first call</dt><dd>{fmtWall(stats.firstWallUs, doc.tzOffsetMin)}</dd><dt>last call</dt><dd>{fmtWall(stats.lastWallUs, doc.tzOffsetMin)}</dd></> : null}
          <dt>trace line</dt><dd><LineRef line={st.firstLine} file={doc.fileOfStmt(id)} bare /></dd>
          <dt>cursors</dt><dd>{st.cursors.length}{assumed ? ' · one opened before trace start' : ''}</dd>
          {ctx?.module && <><dt>module</dt><dd>{ctx.module}</dd></>}
          {ctx?.action && <><dt>action</dt><dd>{ctx.action}</dd></>}
          {ctx?.sessionId && <><dt>session</dt><dd>{ctx.sessionId}{ctx.service ? ` · ${ctx.service}` : ''}</dd></>}
          <dt>parsed by</dt><dd>user id {st.parsingUserId}{doc.userName(st.parsingUserId) ? ` · ${doc.userName(st.parsingUserId)}` : ''}</dd>
        </dl>
      </div>
      {waits.length > 0 && (
        <div className="ctx-sec">
          <h3>Waits</h3>
          {waits.map((w) => (
            <div key={w.event} className="wobj row-click" onClick={() => actions.selectEvent(w.event)}>
              <span className="nm"><i className="swatch" style={{ background: `var(--c-${w.role})` }} />{w.name}</span><span className="n">{fmtDur(w.us)}</span>
              <small>{w.obj > 0 && (w.role === 'userio' || w.role === 'sysio') ? `obj# ${w.obj}${doc.objectName(w.obj) ? ` ${doc.objectName(w.obj)}` : ''} · ` : ''}{fmtInt(w.count)} wait{w.count === 1 ? '' : 's'} · avg {fmtDur(w.us / w.count)} · max {fmtDur(w.maxUs)}{w.maxLine > 0 && <> at <LineRef line={w.maxLine} file={w.maxFile ?? doc.fileOfStmt(id)} /></>}</small>
            </div>
          ))}
          {waits.some((w) => w.obj > 0 && (w.role === 'userio' || w.role === 'sysio')) && <p className="faint xs">obj# names need a ref bundle (<code>mtkprof refscript</code>, <code>-ref</code>)</p>}
        </div>
      )}
      {(children.length > 0 || parents.length > 0) && (
        <div className="ctx-sec">
          <h3>Recursive statements</h3>
          {children.length > 0 && <p className="xs dim">children: {fmtPct(stats.childUs, stats.elapsed)} of elapsed</p>}
          <div className="rel">
            {children.map((l) => { const s = doc.statements[l.statement]; return <RelRow key={'c' + l.statement} doc={doc} id={l.statement} text={preview(s.text, 40)} right={`${fmtInt(l.calls)} call${l.calls === 1 ? '' : 's'} · ${fmtDur(l.elapsed)}`} /> })}
          </div>
          {parents.length > 0 && <p className="xs dim" style={{ marginTop: children.length ? '0.6rem' : 0 }}>called from</p>}
          <div className="rel">
            {parents.map((l) => { const s = doc.statements[l.statement]; return <RelRow key={'p' + l.statement} doc={doc} id={l.statement} text={preview(s.text, 40)} right={`${fmtInt(l.calls)} call${l.calls === 1 ? '' : 's'}`} /> })}
          </div>
        </div>
      )}
      {findings.length > 0 && (
        <div className="ctx-sec">
          <h3>Findings</h3>
          {findings.map((f, i) => (
            <div key={i} className="cfind">
              <div><span className={`badge ${f.severity}`}>{f.severity}</span> <b>{f.title}</b></div>
              <p className="small"><LinkText doc={doc} text={findingText(doc, f)} /></p>
              {f.evidence.length > 0 && (
                <table className="tbl evidence">
                  <tbody>{f.evidence.map((r, j) => (
                    <tr key={j} className={r.statement >= 0 && r.cursor >= 0 && r.execNo ? 'row-click' : undefined}
                      onClick={r.statement >= 0 && r.cursor >= 0 && r.execNo ? () => { actions.pickStmt(r.statement); actions.selectExec({ cursor: r.cursor, execNo: r.execNo! }) } : undefined}>
                      <td className="ev-label">{r.label}</td><td className="text"><LinkText doc={doc} text={r.value} /></td>
                    </tr>))}</tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function RelRow({ doc, id, text, right }: { doc: TraceDoc; id: ID; text: string; right: string }) {
  return (
    <div className="relrow row-click" onClick={() => actions.pickStmt(id)}>
      <StmtLink doc={doc} id={id} /><span className="dim clip">{text}</span><span className="r">{right}</span>
    </div>
  )
}
