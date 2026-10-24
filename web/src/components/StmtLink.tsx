import { Fragment, type ReactNode } from 'react'
import type { TraceDoc } from '../data/doc'
import type { ID } from '../data/types'
import { actions } from '../app/store'

/** A statement's sql_id (or synthetic label) as a link to its detail in the Statements workbench. */
export function StmtLink({ doc, id, className }: { doc: TraceDoc; id: ID; className?: string }) {
  const st = doc.statements[id]
  if (!st) return null
  return (
    <button className={'link mono sqlid' + (className ? ' ' + className : '')} title="open this statement"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); actions.selectStmt(id) }}>
      {doc.label(st)}
    </button>
  )
}

const sqlIdRe = /\b[0-9a-z]{13}\b/g
const byDoc = new WeakMap<TraceDoc, Map<string, ID>>()
function sqlIds(doc: TraceDoc): Map<string, ID> {
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
