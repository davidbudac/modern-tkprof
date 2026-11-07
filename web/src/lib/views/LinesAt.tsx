import { useRef, useState, type ReactNode } from 'react'
import type { TraceDoc } from '../data/doc'
import { ALL_SCOPE, stmtLineIn, type AtObjects } from '../data/lines'
import { fmtDur, fmtInt, preview } from '../data/format'
import { sourceOf, type ExecDetail } from '../data/source'
import { previewOfBinds, type BindRow, type Execution } from '../data/derive'
import type { Fold } from '../data/folds'
import { StmtLink } from '../components/StmtLink'
import { MenuItem, ToolbarMenu } from '../components/ToolbarMenu'
import { useActions } from '../state/session'

/** An action of the owner on the line itself (bookmark, note, focus, copy, inspect): the first group of the Actions menu. */
export interface LineAct {
  label: string
  title?: string
  run(): void
  /** a toggle's state (a tick in the menu) */
  on?: boolean
  /** its key, shown at the end */
  kbd?: string
  disabled?: boolean
  /** the menu stays open after it runs (a toggle) */
  keepOpen?: boolean
}

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
  /** the owner's actions on the line (the Actions menu's first group) */
  lineActs?: LineAct[]
}

const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/** `:0=42 (NUMBER) :1=abc (VARCHAR2)`: every bind of a set, value first (`previewOfBinds` renders null, dup and dump values). */
const bindListOf = (binds: BindRow[]): string => binds.map((b) => `${previewOfBinds([b], 1e9)}${b.type ? ` (${b.type})` : ''}`).join(' ')

/** The line's first upper-case words (`FETCH`, `WAIT`, `PARSING IN CURSOR`, `BINDS`), else its kind (`bind line`, `sql text`). */
const wordOf = (text: string, kind: string): string => /^([A-Z]{2,}(?: [A-Z]{2,})*)\b/.exec(text.trimStart())?.[1] ?? kind.replace('-', ' ')

const Sep = () => <span className="crumb-sep" aria-hidden="true">›</span>

/** An entry of the Actions menu. */
type Act = { label: ReactNode; title: string; run: () => void; disabled?: boolean; on?: boolean; kbd?: string; keepOpen?: boolean }

/**
 * The line's context as a breadcrumb: session › statement (its SQL, executions and time) › execution k of n (with the previous and next
 * one) › the line; then what the line names (wait event and object, binds, plan line). One Actions menu, grouped by what each action is
 * about: this line, its statement, its execution, its session.
 */
export function LinesAt({ doc, file, at, text, goTo, note, block, onCopyRange, lineActs }: Props) {
  const actions = useActions()
  const source = sourceOf(doc)
  const details = useRef(new Map<string, ExecDetail>()) // per (stmt, cursor, execNo): a line card is clicked on again and again
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(false)

  if (!at) return <div className="lines-at" aria-live="polite"><span className="muted">Click a line to see the statement, execution and wait it belongs to.</span></div>
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
  // the trace numbers the executions per cursor; "of n" only when the cursor ran more than once (a re-parse starts a new cursor at 1)
  const execOf = o.execNo >= 0 ? `${fmtInt(o.execNo)}${cur && cur.execs > 1 ? ` of ${fmtInt(cur.execs)}` : ''}` : ''
  const sessionTitle = ctx ? [`session ${ctx.sessionId}`, ctx.module && `module ${ctx.module}`, ctx.action && `action ${ctx.action}`].filter(Boolean).join(' · ') : ''
  const openSession = () => { actions.setContexts(new Set([o.ctx])); actions.setView('sessions') }

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

  // ---- the Actions menu: one group per object ----------------------------------------------------------------------
  const groups: { key: string; name: string; head: ReactNode; acts: Act[] }[] = []
  const lineGroup: Act[] = (lineActs ?? []).map((a) => ({ label: a.label, title: a.title ?? '', run: a.run, on: a.on, kbd: a.kbd, disabled: a.disabled, keepOpen: a.keepOpen }))
  if (block && onCopyRange) lineGroup.push({ label: `Copy block (${fmtInt(block.to - block.from + 1)} lines)`, title: `copy lines ${fmtInt(block.from)}–${fmtInt(block.to)}: ${block.summary}`, run: () => onCopyRange(block.from, block.to) })
  if (lineGroup.length > 0) groups.push({ key: 'line', name: 'This line', head: <>Line {fmtInt(at.line)}</>, acts: lineGroup })

  const stmtGroup: Act[] = []
  if (stmt) {
    stmtGroup.push({ label: 'Open in Statements', title: 'open this statement in the Statements view', run: () => actions.selectStmt(stmt.id) })
  }
  if (stmtId >= 0 && cur) stmtGroup.push({ label: 'Plan', title: "open the statement's detail, which has the plan", run: () => actions.selectStmt(stmtId) })
  if (stmt && parsedAt !== undefined) stmtGroup.push({ label: `Parsed at line ${fmtInt(parsedAt)}`, title: `go to line ${fmtInt(parsedAt)}, where the cursor was parsed`, run: () => goTo(parsedAt) })
  if (closeAt !== undefined) stmtGroup.push({ label: `Cursor CLOSE, line ${fmtInt(closeAt)}`, title: `go to line ${fmtInt(closeAt)}, where the cursor is closed`, run: () => goTo(closeAt) })
  if (waitEvent && waitEvent.id >= 0 && stmtId >= 0) stmtGroup.push({ label: 'Its waits of this event', title: 'the Waits view with this event, for the statement', run: () => { actions.pickStmt(stmtId); actions.selectEvent(waitEvent.id); actions.setView('waits') } })
  const stmtLabel = stmt ? doc.label(stmt) : stmtId >= 0 && doc.statements[stmtId] ? doc.label(doc.statements[stmtId]) : ''
  if (stmtGroup.length > 0) groups.push({ key: 'stmt', name: 'Statement', head: <>Statement {stmtLabel && <span className="h4-id mono">{stmtLabel}</span>}</>, acts: stmtGroup })

  const execGroup: Act[] = []
  if (hasExec) {
    execGroup.push({ label: 'Open this execution', title: "open this execution in the statement's detail", run: () => { actions.selectStmt(stmtId); actions.selectExec({ cursor: o.cursor, execNo: o.execNo }) } })
    execGroup.push({ label: 'Binds', title: 'go to the BINDS block of this execution', run: () => void withDetail((d) => (d.bindLine > 0 ? goTo(d.bindLine) : note('no binds for this execution'))), disabled: busy })
    if (!isExecLine && o.execFrom < 0) execGroup.push({ label: 'EXEC line', title: 'go to the EXEC line of this execution', run: () => void withDetail((d) => (d.line > 0 ? goTo(d.line) : note('no EXEC line for this execution'))), disabled: busy })
  }
  if (o.execNo >= 0) {
    if (execFrom !== undefined) execGroup.push({ label: `Start, line ${fmtInt(execFrom)}`, title: `go to line ${fmtInt(execFrom)}, where this execution starts`, run: () => goTo(execFrom) })
    if (execTo !== undefined) execGroup.push({ label: `End, line ${fmtInt(execTo)}`, title: `go to line ${fmtInt(execTo)}, where this execution ends`, run: () => goTo(execTo) })
    if (o.execFrom >= 0 && o.execTo >= 0 && onCopyRange) execGroup.push({ label: `Copy its lines (${fmtInt(o.execFrom)}–${fmtInt(o.execTo)})`, title: 'copy this execution, from its EXEC line to its last line', run: () => onCopyRange(o.execFrom, o.execTo) })
  }
  if (execGroup.length > 0) groups.push({ key: 'exec', name: 'Execution', head: <>Execution {execOf}</>, acts: execGroup })

  if (ctx) groups.push({ key: 'ctx', name: 'Session', head: <>Session <span className="h4-id mono">{ctx.sessionId}</span></>, acts: [{ label: 'Open in Sessions', title: 'the Sessions view, narrowed to this session', run: openSession }] })

  const nothing = o.stmt < 0 && o.wait < 0 && o.bindSet < 0 && o.planLine < 0 && !ctx
  return (
    <div className="lines-at" aria-live="polite">
      <div className="lines-crumbs">
        {ctx && <><button type="button" className="link mono" onClick={openSession} title={`${sessionTitle}: open in Sessions`}>{ctx.sessionId}</button><Sep /></>}
        {stmt && (
          <>
            <StmtLink doc={doc} id={stmt.id} />
            <span className="lines-sql" title={preview(stmt.text, 400)}>{preview(stmt.text, 90)}</span>
            {stats && <span className="muted crumb-fact" title="executions and elapsed time of the statement">{fmtInt(stats.executions)} {stats.executions === 1 ? 'exec' : 'execs'} · {fmtDur(stats.elapsed)}</span>}
            <Sep />
          </>
        )}
        {o.execNo >= 0 && (
          <>
            <span className="crumb-fact" title={cur ? `execution ${fmtInt(o.execNo)} of cursor #${cur.number}, which ran ${fmtInt(cur.execs)} ${cur.execs === 1 ? 'time' : 'times'}` : undefined}>exec {execOf}</span>
            {(prevExec !== undefined || nextExec !== undefined) && <span className="crumb-nav">
              <button type="button" className="quiet" disabled={prevExec === undefined} onClick={() => prevExec !== undefined && goTo(prevExec)} aria-label="Previous execution"
                title={prevExec === undefined ? 'no previous execution of this cursor' : `previous execution of this cursor, line ${fmtInt(prevExec)} (D)`}>‹</button>
              <button type="button" className="quiet" disabled={nextExec === undefined} onClick={() => nextExec !== undefined && goTo(nextExec)} aria-label="Next execution"
                title={nextExec === undefined ? 'no next execution of this cursor' : `next execution of this cursor, line ${fmtInt(nextExec)} (d)`}>›</button>
            </span>}
            <Sep />
          </>
        )}
        <span className="mono crumb-fact">{wordOf(text, o.kind)}</span>
        <span className="muted crumb-fact">line {fmtInt(at.line)}</span>
        {waitEvent && (
          <span className="crumb-fact">
            {waitEvent.id >= 0
              ? <button type="button" className="link" onClick={() => actions.selectEvent(waitEvent.id)} title="open this wait event">{waitEvent.name}</button>
              : <span>{waitEvent.name}</span>}
            {objName && <span className="muted" title={`obj# ${objNo}`}> · {objName}</span>}
          </span>
        )}
        {block && onCopyRange && <span className="muted crumb-fact">{block.summary}</span>}
        {o.bindSet >= 0 && (o.binds && o.binds.length > 0
          ? <span className="muted crumb-fact" title={`bind set #${o.bindSet}: ${bindListOf(o.binds)}`}>binds {preview(bindListOf(o.binds), 60)}</span>
          : <span className="muted crumb-fact">bind set #{o.bindSet}</span>)}
        {planLine && <span className="muted crumb-fact" title={planLine.object}>plan line {planLine.id}: {planLine.op}{planLine.object ? ` ${planLine.object}` : ''}</span>}
        {nothing && <span className="muted crumb-fact">no statement at this line</span>}
      </div>
      {groups.length > 0 && (
        <ToolbarMenu label="Actions" title="this line, its statement, execution and session: bookmark, copy, go to its parse, binds or execution, open it in another view" className="tbmenu-sm" open={menu} onOpenChange={setMenu}>
          <div className="lines-view lines-acts">
            {groups.map((g) => (
              <div key={g.key} role="group" aria-label={g.name}>
                <h4>{g.head}</h4>
                <div className="tb-items">
                  {g.acts.map((a, i) => (
                    <MenuItem key={i} on={a.on} kbd={a.kbd} disabled={a.disabled} title={a.title} onClick={() => { if (!a.keepOpen) setMenu(false); a.run() }}>{a.label}</MenuItem>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ToolbarMenu>
      )}
    </div>
  )
}
