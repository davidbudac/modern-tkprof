import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { TraceDoc } from '../data/doc'
import type { ID } from '../data/types'
import { useActions } from '../state/session'
import { StmtPopover, type PopupAnchor } from './StmtPopover'

/** The one open sql_id popover: opening another closes it (the links stop pointer events, so the popover's own outside-press close does not see them). */
let closeOpen: (() => void) | null = null

/**
 * A statement's sql_id (or synthetic label). A click peeks: it opens the statement's popover under the link, which has `Open in Statements`.
 * Ctrl/⌘-click and middle click go straight to the Statements view; `direct` (the Statements list itself) always does.
 */
export function StmtLink({ doc, id, className, direct }: { doc: TraceDoc; id: ID; className?: string; direct?: boolean }) {
  const actions = useActions()
  const [anchor, setAnchor] = useState<PopupAnchor | null>(null)
  const close = useRef(() => setAnchor(null))
  useEffect(() => { const c = close.current; return () => { if (closeOpen === c) closeOpen = null } }, [])
  const st = doc.statements[id]
  if (!st) return null
  const open = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    if (anchor) { setAnchor(null); return }
    closeOpen?.()
    closeOpen = close.current
    setAnchor({ x: e.clientX, y: e.clientY, rect: e.currentTarget.getBoundingClientRect() })
  }
  return (
    <>
      <button className={'link mono sqlid' + (className ? ' ' + className : '')} aria-haspopup={direct ? undefined : 'dialog'} aria-expanded={direct ? undefined : anchor !== null}
        title={direct ? 'open this statement' : 'peek at this statement (Ctrl/⌘-click: open it in Statements)'}
        onPointerDown={(e) => e.stopPropagation()}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); actions.selectStmt(id) } }}
        onClick={(e) => {
          e.preventDefault(); e.stopPropagation()
          if (direct || e.metaKey || e.ctrlKey) actions.selectStmt(id)
          else open(e)
        }}>
        {doc.label(st)}
      </button>
      {anchor && (
        // the popover is a portal, but React events still bubble through the tree: keep its clicks from reaching the row that holds the link
        <span style={{ display: 'contents' }} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <StmtPopover doc={doc} popup={{ stmt: id, anchor, line: 0 }} onClose={() => setAnchor(null)} />
        </span>
      )}
    </>
  )
}

const sqlIdRe = /\b[0-9a-z]{13}\b/g
const byDoc = new WeakMap<TraceDoc, Map<string, ID>>()
/** sql_id → the first statement with it. */
export function sqlIds(doc: TraceDoc): Map<string, ID> {
  let m = byDoc.get(doc)
  if (!m) {
    m = new Map()
    for (const s of doc.statements) if (s.sqlId && !m.has(s.sqlId)) m.set(s.sqlId, s.id)
    byDoc.set(doc, m)
  }
  return m
}

/** Free text with every sql_id of a statement in this trace turned into a StmtLink. */
export function LinkText({ doc, text }: { doc: TraceDoc; text: string }) {
  const ids = sqlIds(doc)
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(sqlIdRe)) {
    const id = ids.get(m[0])
    if (id === undefined) continue
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(<StmtLink key={m.index} doc={doc} id={id} />)
    last = m.index + m[0].length
  }
  if (last === 0) return <>{text}</>
  out.push(text.slice(last))
  return <>{out.map((x, i) => <Fragment key={i}>{x}</Fragment>)}</>
}
