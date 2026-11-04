import { useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '../data/client'
import type { TraceDoc } from '../data/doc'
import { substitute } from '../data/bindsql'
import { copyText } from '../data/clipboard'
import { fmtInt } from '../data/format'
import { ALL_SCOPE, objectsAt, type AtObjects } from '../data/lines'
import { sourceOf } from '../data/source'
import { rememberBinds } from '../data/bindat'

/**
 * The statement of a line's execution as it ran: its text with the values of the execution's BINDS block in place of the
 * placeholders (values the trace cut or did not print are marked, never made up), the binds as a table, the neighbouring executions.
 */
export function AsRun({ doc, client, file, line, onGo, note }: {
  doc: TraceDoc; client: ApiClient; file: number
  /** a line of the execution: its BINDS line, or its EXEC line */
  line: number
  /** show another execution: its EXEC line (the panel follows it) */
  onGo(line: number): void
  note(msg: string, bad?: boolean): void
}) {
  const [at, setAt] = useState<{ line: number; objs: AtObjects } | { line: number; error: string } | null>(null)
  useEffect(() => {
    const ac = new AbortController()
    objectsAt(client, file, line, ac.signal).then(
      (objs) => { rememberBinds(doc, file, objs); if (!ac.signal.aborted) setAt({ line, objs }) },
      (e: unknown) => { if (!ac.signal.aborted) setAt({ line, error: e instanceof Error ? e.message : String(e) }) },
    )
    return () => ac.abort()
  }, [client, doc, file, line])

  const objs = at && at.line === line && 'objs' in at ? at.objs : null
  const st = objs && objs.stmt >= 0 ? doc.statements[objs.stmt] : undefined
  const cur = objs && objs.cursor >= 0 ? doc.cursors[objs.cursor] : undefined
  const sub = useMemo(() => (st && objs?.binds ? substitute(st.text, objs.binds) : null), [st, objs])
  // the statement's executions in this file (by their EXEC lines): the neighbours of this one may be on other cursors
  const sid = st?.id ?? -1
  const [execs, setExecs] = useState<{ stmt: number; lines: number[] } | null>(null)
  useEffect(() => {
    if (sid < 0) return
    const ac = new AbortController()
    Promise.resolve(sourceOf(doc).executions(sid, ALL_SCOPE, ac.signal)).then(
      (p) => { if (!ac.signal.aborted) setExecs({ stmt: sid, lines: p.rows.filter((r) => r.line > 0 && doc.fileOfCtx(r.ctx) === file).map((r) => r.line).sort((a, b) => a - b) }) },
      () => undefined,
    )
    return () => ac.abort()
  }, [doc, file, sid])
  const nav = useMemo(() => {
    if (!objs) return { prev: -1, next: -1 }
    const ls = execs && execs.stmt === sid ? execs.lines : []
    const cur = ls.find((l) => l >= objs.execFrom && l <= objs.execTo) ?? objs.execFrom
    const before = ls.filter((l) => l < cur)
    return { prev: before.length ? before[before.length - 1] : objs.prevExec, next: ls.find((l) => l > cur) ?? objs.nextExec }
  }, [objs, execs, sid])

  if (!at || at.line !== line) return <p className="small muted asrun-note">Loading line {fmtInt(line)}…</p>
  if ('error' in at) return <p className="small lines-error asrun-note">{at.error}</p>
  if (!st) return <p className="small muted asrun-note">Line {fmtInt(line)} belongs to no statement.</p>
  if (!sub) return <p className="small muted asrun-note">This execution of {doc.label(st)} has no bind values (no BINDS block before its EXEC line).</p>
  const cut = sub.binds.some((b) => b.note && /cut/.test(b.note))
  return (
    <div className="asrun">
      <div className="asrun-head">
        <b className="mono" title={cur ? `cursor #${cur.number}` : undefined}>{doc.label(st)}</b>
        {objs!.execNo >= 0 && <span className="muted small">execution {fmtInt(objs!.execNo)}</span>}
        <span className="asrun-nav">
          <button type="button" className="quiet" disabled={nav.prev < 0} onClick={() => onGo(nav.prev)} title="the previous execution of this statement">‹ previous</button>
          <button type="button" className="quiet" disabled={nav.next < 0} onClick={() => onGo(nav.next)} title="the next execution of this statement">next ›</button>
          <button type="button" className="quiet" onClick={() => void copyText(sub.sql).then((ok) => note(ok ? 'Copied the SQL with its values' : 'Could not copy the SQL', !ok))}>Copy SQL</button>
        </span>
      </div>
      {!sub.exact && <p className="small asrun-warn">The placeholders and the Bind# entries do not pair up one to one: they are matched in order.</p>}
      {cut && <p className="small asrun-warn">The trace cut at least one value: only its start is shown, marked “truncated in the trace”.</p>}
      <pre className="asrun-sql">{sub.parts.map((p, i) => (p.pos === undefined ? p.t : <mark key={i} title={`Bind#${p.pos}`}>{p.t}</mark>))}</pre>
      <table className="asrun-binds small">
        <thead><tr><th>#</th><th>name</th><th>value</th><th>type</th></tr></thead>
        <tbody>
          {sub.binds.map((b) => (
            <tr key={b.pos} className={b.missing ? 'muted' : undefined}>
              <td className="mono">{b.pos}</td>
              <td className="mono">:{b.name}</td>
              <td className="mono asrun-val" title={b.note}>{b.sql}{b.note && <small className="muted"> · {b.note}</small>}</td>
              <td className="muted">{b.type}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {objs!.bindLine > 0 && <p className="small muted">BINDS block at line <button type="button" className="link" onClick={() => onGo(objs!.bindLine)}>{fmtInt(objs!.bindLine)}</button></p>}
    </div>
  )
}
