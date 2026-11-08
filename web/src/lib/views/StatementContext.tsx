import type { TraceDoc } from '../data/doc'
import { isBlockIO } from '../data/iomap'
import { StmtLink, LinkText } from '../components/StmtLink'
import { Fragment, useState } from 'react'
import type { ID, StmtStats } from '../data/types'
import { fmtDur, fmtInt, fmtPct, fmtWall, preview } from '../data/format'
import { useActions } from '../state/session'
import { LineRef } from '../components/LineRef'
import { sourceOf, useSourceQuery } from '../data/source'
import { scopeKey, useScope } from '../data/scopedstmts'
import type { Scope } from '../state/store'
import { ToolbarMenu } from '../components/ToolbarMenu'
import { findingText } from './Findings'
import { ImportNames } from './RefImport'
import { useScopedFindings } from '../data/scopedfindings'

const WHOLE: Scope = { window: null, files: null, contexts: null, includeIdle: true }

/**
 * The context sections of the statement detail: where the statement ran, its waits, its relatives. `stats` are the numbers
 * of the scope when `narrowed` (first and last call come from them, the cursors are those in scope, the waits are the scope's).
 */
export function StatementContext({ doc, id, stats: scoped, narrowed = false }: { doc: TraceDoc; id: ID; stats?: StmtStats; narrowed?: boolean }) {
  const actions = useActions()
  const st = doc.statements[id]
  const stats = scoped ?? doc.stats.statements[id]
  const source = sourceOf(doc)
  const stateScope = useScope(doc)
  const scope = narrowed ? stateScope : WHOLE
  const waitsQ = useSourceQuery(source, `waits:${id}:${scopeKey(scope)}`, (signal) => (source.ready ? source.stmtWaits([id], 6, scope, signal) : null), 'waits')
  if (!st || !stats) return null
  const cursorsIn = narrowed ? st.cursors.filter((c) => inScopeCursor(doc, c, stateScope)) : st.cursors
  const ctx = cursorsIn.length ? doc.contexts[doc.cursors[cursorsIn[0]].context] : undefined
  const waits = waitsQ.data?.get(id) ?? []
  const children = stats.children ?? [], parents = stats.parents ?? []
  const assumed = cursorsIn.some((c) => doc.cursors[c].assumed)
  return (
    <>
      <div className="ctx-sec">
        <h3>Context</h3>
        <dl className="kv">
          {stats.firstWallUs ? <><dt>first call</dt><dd>{fmtWall(stats.firstWallUs, doc.tzOffsetMin)}</dd><dt>last call</dt><dd>{fmtWall(stats.lastWallUs, doc.tzOffsetMin)}</dd></> : null}
          <dt>cursors</dt><dd>{narrowed ? stats.cursors : st.cursors.length}{assumed ? ' · one opened before trace start' : ''}</dd>
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
              <small>{w.obj > 0 && (w.role === 'userio' || w.role === 'sysio') ? `obj# ${w.obj}${doc.objectName(w.obj) ? ` ${doc.objectName(w.obj)}` : ''} · ` : ''}{fmtInt(w.count)} wait{w.count === 1 ? '' : 's'} · avg {fmtDur(w.us / w.count)} · max {fmtDur(w.maxUs)}{w.maxLine > 0 && <> at <LineRef line={w.maxLine} file={w.maxFile ?? doc.fileOfStmt(id)} /></>}
                {source.ready && doc.events[w.event] && isBlockIO(doc.events[w.event]) && (
                  <button type="button" className="link to-blocks" title="the file blocks these waits touched (the I/O map, filtered to this statement and event)"
                    onClick={(e) => { e.stopPropagation(); actions.showBlocks({ stmt: id, event: w.event }) }}>in I/O map</button>
                )}</small>
            </div>
          ))}
          {waits.some((w) => w.obj > 0 && (w.role === 'userio' || w.role === 'sysio') && !doc.objectName(w.obj)) && <p className="faint xs">obj# without a name: <ImportNames doc={doc} /></p>}
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
    </>
  )
}

/** The statement's findings (the scope's when `narrowed`); placed after its plans in the statement detail. */
export function StatementFindings({ doc, id, narrowed = false }: { doc: TraceDoc; id: ID; narrowed?: boolean }) {
  const actions = useActions()
  const sf = useScopedFindings(doc)
  const findings = (narrowed ? sf.findings : doc.stats.findings).filter((f) => f.statement === id)
  if (findings.length === 0) return null
  return (
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
  )
}

/** The trace line a statement was parsed at: its first cursor in scope when narrowed, else the statement's first line. */
function parsedAt(doc: TraceDoc, id: ID, narrowed: boolean, scope: Scope): { line: number; file: number } {
  const st = doc.statements[id]
  const c = narrowed ? st.cursors.find((x) => inScopeCursor(doc, x, scope)) : undefined
  return c !== undefined ? { line: doc.cursors[c].line, file: doc.fileOfCursor(c) } : { line: st.firstLine, file: doc.fileOfStmt(id) }
}

/** `Lines ▾` in the action row of the statement detail: the trace lines this statement is at (where it was parsed, each plan's STAT lines). */
export function StatementLinesMenu({ doc, id, narrowed = false }: { doc: TraceDoc; id: ID; narrowed?: boolean }) {
  const [open, setOpen] = useState(false)
  const scope = useScope(doc)
  const at = parsedAt(doc, id, narrowed, scope)
  const plans = doc.plansOf(id).filter((p) => p.line > 0)
  const byHash = new Map<number, (typeof plans)[number]>()
  for (const p of plans) byHash.set(p.planHash, p) // the latest dump of each plan
  if (at.line <= 0 && byHash.size === 0) return null
  return (
    <ToolbarMenu label="Lines" title="trace lines of this statement" className="tbmenu-sm tbmenu-start" open={open} onOpenChange={setOpen}>
      <dl className="kv stmt-lines" onClick={() => setOpen(false)}>
        {at.line > 0 && <><dt>parsed at</dt><dd><LineRef line={at.line} file={at.file} /></dd></>}
        {[...byHash.values()].map((p) => <Fragment key={p.id}><dt>plan {p.planHash || ''} (STAT)</dt><dd><LineRef line={p.line} file={doc.fileOfCursor(p.cursor)} /></dd></Fragment>)}
      </dl>
    </ToolbarMenu>
  )
}

/** A cursor of the scope: opened in one of its contexts (the window is applied through `StmtStats.cursors`, which counts those called in it). */
function inScopeCursor(doc: TraceDoc, cursor: ID, scope: Scope): boolean {
  return !scope.contexts || scope.contexts.has(doc.cursors[cursor].context)
}

function RelRow({ doc, id, text, right }: { doc: TraceDoc; id: ID; text: string; right: string }) {
  const actions = useActions()
  return (
    <div className="relrow row-click" onClick={() => actions.pickStmt(id)}>
      <StmtLink doc={doc} id={id} direct /><span className="dim clip">{text}</span><span className="r">{right}</span>
    </div>
  )
}
