import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TraceDoc } from '../data/doc'
import { stmtLineIn } from '../data/lines'
import { fmtDur, fmtInt } from '../data/format'
import { copyText } from '../data/clipboard'
import { useActions, useStore } from '../state/session'
import { usePopover } from './usePopover'

/** Where a popup opens: the click point and, when the reference is known, its box. */
export interface PopupAnchor { x: number; y: number; rect?: DOMRect }

/** A statement popup asked for by a click on a reference in a row: the statement, the cursor the reference named, where it was clicked and on which line. */
export interface StmtPopup { stmt: number; cursor?: number; anchor: PopupAnchor; line: number }

/**
 * The statement behind a reference in a row (or a sql_id link, see `StmtLink`): its SQL and a summary, with the way on to the Statements view.
 * Without `file` and `goTo` (a link outside the Lines view) there are no line actions.
 * A fixed layer on `document.body` placed and closed by `usePopover`.
 */
export function StmtPopover({ doc, file, popup, onClose, goTo }: { doc: TraceDoc; file?: number; popup: StmtPopup; onClose(): void; goTo?(line: number): void }) {
  const actions = useActions()
  const marked = useStore((s) => s.selection.stmt)
  const [copied, setCopied] = useState(false)
  const st = doc.statements[popup.stmt]
  const cur = popup.cursor !== undefined ? doc.cursors[popup.cursor] : undefined
  const stats = st ? doc.stats.statements[st.id] : undefined

  const root = usePopover(popup.anchor, onClose, [popup])

  const copyTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  if (!st) return null
  const parsedAt = file === undefined || !goTo ? undefined : (() => {
    if (cur && cur.line > 0 && doc.fileOfCursor(cur.id) === file) return cur.line
    return stmtLineIn(doc, file, st.id)
  })()
  const total = stats?.total
  const facts: [string, string][] = stats ? [
    ['Executions', fmtInt(stats.executions)],
    ['Elapsed', fmtDur(stats.elapsed)],
    ['CPU', fmtDur(stats.cpu)],
    ['Waits', fmtDur(stats.waitUs)],
    ['Rows', fmtInt(total?.rows ?? 0)],
    ['Disk reads', fmtInt(total?.disk ?? 0)],
    ['Buffer gets', fmtInt((total?.query ?? 0) + (total?.current ?? 0))],
    ['Hard parses', fmtInt(stats.hardParses)],
    ['Cursors', fmtInt(stats.cursors)],
    ...(stats.errors > 0 ? [['Errors', fmtInt(stats.errors)] as [string, string]] : []),
  ] : []
  const done = (f: () => void) => () => { f(); onClose() }
  const label = doc.label(st)

  return createPortal(
    <div className="stmt-pop" ref={root} role="dialog" aria-label={`Statement ${label}`} onKeyDown={(e) => e.stopPropagation()}>
      <div className="stmt-pop-h">
        <b className="mono">{label}</b>
        {cur && <span className="muted">cursor #{cur.number} · dep {cur.depth}</span>}
        {st.commandName && <span className="stmt-pop-cmd">{st.commandName}</span>}
        <button type="button" className="quiet stmt-pop-x" onClick={onClose} aria-label="Close" title="close (Esc)">×</button>
      </div>
      {facts.length > 0 && (
        <dl className="stmt-pop-facts">
          {facts.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
        </dl>
      )}
      <pre className="sql stmt-pop-sql" tabIndex={0}>{st.text || '(no SQL text)'}</pre>
      <div className="stmt-pop-acts">
        <button type="button" data-first onClick={done(() => actions.selectStmt(st.id))} title="open this statement in the Statements view">Open in Statements</button>
        {goTo && marked !== st.id && <button type="button" onClick={done(() => actions.pickStmt(st.id))} title="mark this statement: its calls and waits get gutter marks">Mark</button>}
        {goTo && parsedAt !== undefined && <button type="button" onClick={done(() => goTo(parsedAt))} title={`go to line ${fmtInt(parsedAt)}, where ${cur ? 'this cursor' : 'the statement'} was parsed`}>Parsed at line {fmtInt(parsedAt)}</button>}
        <button type="button" onClick={() => {
          void copyText(st.text).then((ok) => {
            if (!ok) return
            setCopied(true)
            window.clearTimeout(copyTimer.current)
            copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
          })
        }}>{copied ? 'Copied' : 'Copy SQL'}</button>
      </div>
    </div>,
    document.body,
  )
}
