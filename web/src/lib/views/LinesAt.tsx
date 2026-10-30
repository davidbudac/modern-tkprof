import { useRef, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import { ALL_SCOPE, stmtLineIn, type AtObjects } from '../data/lines'
import { fmtDur, fmtInt, preview } from '../data/format'
import { sourceOf, type ExecDetail } from '../data/source'
import { previewOfBinds, type BindRow, type Execution } from '../data/derive'
import type { Fold } from '../data/folds'
import { StmtLink } from '../components/StmtLink'
import { useActions, useStore } from '../state/session'

interface Props {
  doc: TraceDoc
  file: number
  at: { line: number; objs: AtObjects } | null
  /** the text of the line (named waits and objects come from it); '' while its page is on its way */
  text: string
  /** a jump (it keeps the jump history) */
  goTo: (line: number) => void
  /** a short status note (the status bar) */
  note: (msg: string) => void
  /** the foldable block this line starts (BINDS, STAT dump, long SQL text), null for none */
  block?: Fold | null
  /** copy lines `from..to` */
  onCopyRange?: (from: number, to: number) => void
  /** a vertical, wrapping list (the inspector) instead of the one fixed row */
  stack?: boolean
}

const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/** `:0=42 (NUMBER) :1=abc (VARCHAR2)`: every bind of a set, value first (`previewOfBinds` renders null, dup and dump values). */
const bindListOf = (binds: BindRow[]): string => binds.map((b) => `${previewOfBinds([b], 1e9)}${b.type ? ` (${b.type})` : ''}`).join(' ')

/** The line card: what is at the selected line (statement, execution, cursor, wait, session) with an action for each object. */
export function LinesAt({ doc, file, at, text, goTo, note, block, onCopyRange, stack }: Props) {
  const cls = 'lines-at' + (stack ? ' lines-at-stack' : '')
  const actions = useActions()
  const markedStmt = useStore((s) => s.selection.stmt)
  const source = sourceOf(doc)
  const details = useRef(new Map<string, ExecDetail>()) // per (stmt, cursor, execNo): a line card is clicked on again and again
  const [busy, setBusy] = useState(false)

  if (!at) return <div className={cls} aria-live="polite"><span className="muted">Click a line to see the statement, execution and wait it belongs to.</span></div>
  const o = at.objs
  const stmtId = o.stmt >= 0 ? o.stmt : (doc.cursors[o.cursor]?.statement ?? -1)
  const stmt = o.stmt >= 0 ? doc.statements[o.stmt] : undefined
  const cur = o.cursor >= 0 ? doc.cursors[o.cursor] : undefined
  const planLine = o.planLine >= 0 ? doc.planLines[o.planLine] : undefined
  const ctx = o.ctx >= 0 ? doc.contexts[o.ctx] : undefined
  const stats = stmt ? doc.stats.statements[stmt.id] : undefined
  const waitEvent = (() => {
    if (o.wait < 0) return undefined
    const name = /nam='([^']*)'/.exec(text)?.[1]
    if (name === undefined) return undefined
    return { id: doc.events.findIndex((e) => e.name === name), name }
  })()
  const objNo = o.wait >= 0 ? Number(/\bobj#=(\d+)/.exec(text)?.[1] ?? 0) : 0
  const objName = o.object !== '' ? o.object : objNo > 0 ? doc.objectName(objNo) : undefined
  const parsedAt = (() => {
    if (!stmt) return undefined
    const line = o.cursorLine >= 0 ? o.cursorLine : cur && doc.fileOfCursor(cur.id) === file && cur.line > 0 ? cur.line : stmtLineIn(doc, file, stmt.id)
    return line !== undefined && line !== at.line ? line : undefined
  })()
  /** a neighbour line of the engine's answer: only when there is one and it is not where we are */
  const other = (line: number) => (line >= 0 && line !== at.line ? line : undefined)
  const execFrom = other(o.execFrom), execTo = other(o.execTo), prevExec = other(o.prevExec), nextExec = other(o.nextExec), closeAt = other(o.closeLine)
  const hasExec = o.execNo >= 0 && o.cursor >= 0 && stmtId >= 0
  const isExecLine = o.kind === 'call' && /^EXEC/.test(text)

  /** The detail of the line's execution: the row comes from the statement's executions (any scope), the detail from the row. */
  const detailOf = async (): Promise<ExecDetail | null> => {
    const key = `${stmtId}:${o.cursor}:${o.execNo}`
    const hit = details.current.get(key)
    if (hit) return hit
    const page = await source.executions(stmtId, ALL_SCOPE)
    const row: Execution | undefined = page.rows.find((r) => r.cursor === o.cursor && r.execNo === o.execNo)
    if (!row) { note(`execution #${o.execNo} is not in the listed executions${page.partial ? ' (only the slowest are listed)' : ''}`); return null }
    const d = await source.executionDetail(stmtId, row)
    details.current.set(key, d)
    return d
  }
  const withDetail = async (use: (d: ExecDetail) => void) => {
    setBusy(true)
    try { const d = await detailOf(); if (d) use(d) } catch (e) { if (!aborted(e)) note(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <div className={cls} aria-live="polite">
      <span className="mono">line {fmtInt(at.line)}</span>
      <span className="lines-kind">{o.kind}</span>
      {stmt && (
        <span className="lines-at-obj">
          <StmtLink doc={doc} id={stmt.id} />
          <span className="muted lines-sql">{preview(stmt.text, 90)}</span>
          <button className="link" onClick={() => actions.selectStmt(stmt.id)} title="open this statement in the Statements view">Open</button>
          {markedStmt !== stmt.id && <button className="link" onClick={() => actions.pickStmt(stmt.id)} title="mark this statement: its calls and waits get gutter marks">Mark</button>}
          {parsedAt !== undefined && <button className="link" onClick={() => goTo(parsedAt)} title={`go to line ${fmtInt(parsedAt)}, where the cursor was parsed`}>Parsed at</button>}
          {stats && <span className="muted" title="executions and elapsed time of the statement">{fmtInt(stats.executions)} {stats.executions === 1 ? 'exec' : 'execs'} · {fmtDur(stats.elapsed)}</span>}
        </span>
      )}
      {o.execNo >= 0 && (
        <span className="lines-at-obj">
          <span>exec #{o.execNo}</span>
          {hasExec && <>
            <button className="link" onClick={() => { actions.selectStmt(stmtId); actions.selectExec({ cursor: o.cursor, execNo: o.execNo }) }} title="open this execution in the statement's detail">Open</button>
            <button className="link" disabled={busy} title="go to the BINDS block of this execution"
              onClick={() => void withDetail((d) => (d.bindLine > 0 ? goTo(d.bindLine) : note('no binds for this execution')))}>Binds</button>
            {!isExecLine && o.execFrom < 0 && <button className="link" disabled={busy} title="go to the EXEC line of this execution"
              onClick={() => void withDetail((d) => (d.line > 0 ? goTo(d.line) : note('no EXEC line for this execution')))}>EXEC line</button>}
          </>}
          {prevExec !== undefined && <button className="link" onClick={() => goTo(prevExec)} title={`go to line ${fmtInt(prevExec)}, the previous execution of this cursor (D)`}>‹ prev exec</button>}
          {execFrom !== undefined && <button className="link" onClick={() => goTo(execFrom)} title={`go to line ${fmtInt(execFrom)}, where this execution starts`}>⇤ exec start</button>}
          {execTo !== undefined && <button className="link" onClick={() => goTo(execTo)} title={`go to line ${fmtInt(execTo)}, where this execution ends`}>exec end ⇥</button>}
          {o.execFrom >= 0 && o.execTo >= 0 && onCopyRange && <button className="link" onClick={() => onCopyRange(o.execFrom, o.execTo)} aria-label="Copy the lines of this execution" title={`copy lines ${fmtInt(o.execFrom)}–${fmtInt(o.execTo)}: this execution, from its EXEC line to its last line`}>Copy block</button>}
          {nextExec !== undefined && <button className="link" onClick={() => goTo(nextExec)} title={`go to line ${fmtInt(nextExec)}, the next execution of this cursor (d)`}>next exec ›</button>}
        </span>
      )}
      {cur && (
        <span className="lines-at-obj muted">
          <span>cursor #{cur.number}</span>
          <span>dep {cur.depth}</span>
          {cur.planHash > 0 && <span title="plan hash value">plan hash {cur.planHash}</span>}
          <span>{fmtInt(cur.execs)} {cur.execs === 1 ? 'exec' : 'execs'}</span>
          {stmtId >= 0 && <button className="link" onClick={() => actions.selectStmt(stmtId)} title="open the statement's detail, which has the plan">Plan</button>}
          {closeAt !== undefined && <button className="link" onClick={() => goTo(closeAt)} title={`go to line ${fmtInt(closeAt)}, where the cursor is closed`}>CLOSE</button>}
        </span>
      )}
      {o.cursor >= 0 && !cur && <span className="muted">cursor #{o.cursor}</span>}
      {waitEvent && (
        <span className="lines-at-obj">
          {waitEvent.id >= 0
            ? <button className="link" onClick={() => actions.selectEvent(waitEvent.id)} title="open this wait event">{waitEvent.name}</button>
            : <span>{waitEvent.name}</span>}
          {waitEvent.id >= 0 && stmtId >= 0 && <button className="link" title="the Waits view with this event, for the statement"
            onClick={() => { actions.pickStmt(stmtId); actions.selectEvent(waitEvent.id); actions.setView('waits') }}>Waits of this statement</button>}
          {objName && <span className="muted" title={`obj# ${objNo}`}>{objName}</span>}
        </span>
      )}
      {block && onCopyRange && (
        <span className="lines-at-obj">
          <span className="muted">{block.summary}</span>
          <button className="link" onClick={() => onCopyRange(block.from, block.to)} aria-label={`Copy the block: ${block.summary}`} title={`copy lines ${fmtInt(block.from)}–${fmtInt(block.to)}: ${block.summary}`}>Copy block</button>
        </span>
      )}
      {o.bindSet >= 0 && (o.binds && o.binds.length > 0
        ? <span title={`bind set #${o.bindSet}: ${bindListOf(o.binds)}`}>binds: {preview(bindListOf(o.binds), 60)}</span>
        : <span>bind set #{o.bindSet}</span>)}
      {planLine && <span title={planLine.object}>plan line {planLine.id}: {planLine.op}{planLine.object ? ` ${planLine.object}` : ''}</span>}
      {ctx && (
        <span className="lines-at-obj muted">
          <span title="session id">session {ctx.sessionId}</span>
          {ctx.module && <span>module {ctx.module}</span>}
          {ctx.action && <span>action {ctx.action}</span>}
          <button className="link" onClick={() => { actions.setContexts(new Set([o.ctx])); actions.setView('sessions') }} title="the Sessions view, narrowed to this session">Open session</button>
        </span>
      )}
      {o.stmt < 0 && o.wait < 0 && o.bindSet < 0 && o.planLine < 0 && <span className="muted">no statement at this line</span>}
    </div>
  )
}
