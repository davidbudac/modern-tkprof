// The system state reading (`sysstate`): the blocker tree first (the forest the dump names itself: final blockers at the top, each session a card), then the process
// table (the dump's Process Summary completed from each process's body), with the idle background processes hidden by default and never a blocked or blocking
// session. A row opens that process's reading. Layout A of docs/mockups/diag-reader/ (shots/sysstate-light.png).
import { useMemo, type KeyboardEvent, type ReactNode } from 'react'
import { fmtInt } from '../../../data/format'
import { normalizeSysState, type SysProc } from '../../../data/diagreadings'
import { initProcSort, nextProcSort, procView, sysForest } from '../../../data/diagsys'
import { secs } from '../../../data/diagstack'
import type { Sort } from '../../../data/diagheap'
import { usePersisted } from '../../../state/persist'
import { TraceMark } from '../../../components/DumpMark'
import { BlockerTree, nodeReach } from './blockers'
import { CopyBlock, LineLink, SessionLink, SortTh, useReadingUi } from './parts'
import { registerReading, type ReadingProps } from './registry'

export interface SysUi {
  sort: Sort
  /** the caller's stack includes the signal handler's own frames */
  incOwn: boolean
}
export const initSysUi = (): SysUi => ({ sort: initProcSort(), incOwn: false })

/** Whether the idle background processes are shown: kept across files and sessions. */
export const SHOW_IDLE_KEY = 'mtkprof.diag.sysstate.showIdle'

const rowKeys = (act: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act() }
}

export function SysStateView({ node, reading, source, goLine, selectNode }: ReadingProps) {
  const r = useMemo(() => normalizeSysState(reading), [reading])
  const [st, patch] = useReadingUi<SysUi>(source, node.id, initSysUi)
  const [showIdle, setShowIdle] = usePersisted<boolean>(SHOW_IDLE_KEY, false)
  const link = (line: number, text?: ReactNode) => <LineLink line={line} text={text} source={source} goLine={goLine} />
  const canOpen = useMemo(() => nodeReach(source), [source])
  const forest = useMemo(() => sysForest(r), [r])
  const view = useMemo(() => procView(r, showIdle, st.sort), [r, showIdle, st.sort])
  const c = r.counts
  const onSort = (col: string) => patch({ sort: nextProcSort(st.sort, col) })
  const stack = r.caller ? (st.incOwn || !r.caller.stackNoOwn ? r.caller.stack : r.caller.stackNoOwn) : ''
  const treeProps = { source, goLine, selectNode, canOpen }

  return (
    <div className="rd" data-reading="sysstate">
      <header className="rd-head">
        <h3 className="rd-title">System state</h3>
        <span className="rd-meta">
          ({r.level}) · {fmtInt(c.processes)} processes · line {link(r.titleLine)}
          {r.summaryLine ? <>, process summary at {link(r.summaryLine)}</> : null}
        </span>
        <span className="rd-meta">
          {r.command ? <>Taken by <span className="rd-mono">oradebug {r.command}</span>{r.commandLine ? <> {link(r.commandLine)}</> : null}</> : <>The dump prints no oradebug command before it</>}
          {r.session ? <> · written by session <SessionLink source={source} self={node.id} session={r.session} selectNode={selectNode} /></> : null}
        </span>
        {r.caller && (
          <details className="rd-caller">
            <summary title={`The short stack of the process that took the dump, printed before the section (line ${r.caller.line})`}>
              <span className="rd-dim">Stack of the process that took the dump</span> <span className="rd-mono rd-clip">{stack}</span>
            </summary>
            <CopyBlock text={stack} label="The stack of the process that took the dump as one line">
              {r.caller.own > 0 && <label className="rd-chk-l"><input type="checkbox" checked={st.incOwn} onChange={(e) => patch({ incOwn: e.target.checked })} /> include the frames of the handler that took it ({r.caller.own})</label>}
              <span className="rd-dim">line {link(r.caller.line)}</span>
            </CopyBlock>
          </details>
        )}
      </header>

      <section className="rd-sec" aria-label="Blocker tree">
        <div className="rd-k">
          Blocker tree <span className="rd-dim">(as the dump names the sessions: <span className="rd-mono">Blocked by</span> and <span className="rd-mono">Final Blocker</span> in the summary, <span className="rd-mono">Dumping direct blocker(s)</span> in the bodies)</span>
        </div>
        {forest.length === 0 ? (
          <p className="rd-p">No session is blocked in this dump: it names no blocker, and no process body says that a session blocks it.</p>
        ) : (
          <>
            <p className="rd-meta">{fmtInt(r.blocked)} {r.blocked === 1 ? 'session is' : 'sessions are'} blocked, behind {fmtInt(r.roots)} final {r.roots === 1 ? 'blocker' : 'blockers'}.</p>
            <BlockerTree forest={forest} props={treeProps} />
            <p className="rd-note">The final blocker is at the top; each session below it is blocked by the one above. A session that waits for several is drawn under the first of them.</p>
            {r.treeOmitted > 0 && <p className="rd-note">and {fmtInt(r.treeOmitted)} more {r.treeOmitted === 1 ? 'session' : 'sessions'} the reading does not list ({fmtInt(r.treeNodes + r.treeOmitted)} in all).</p>}
          </>
        )}
      </section>

      <section className="rd-sec" aria-label="Processes">
        <div className="rd-k">Processes <span className="rd-dim">(the dump&apos;s Process Summary, with the time in wait from each session&apos;s wait stack)</span></div>
        <div className="rd-p">
          <b>{fmtInt(c.processes)}</b> processes: {fmtInt(c.user)} user, {fmtInt(c.background)} background, {fmtInt(c.pseudo)} pseudo
          <span className="rd-dim"> · {fmtInt(c.idle)} idle, {fmtInt(c.withoutSession)} with no session</span>
        </div>
        {view.idleBackground > 0 && (
          <div className="rd-actions">
            <span className="rd-idle-n">{showIdle ? <>{fmtInt(view.idleBackground)} idle background processes shown, dimmed</> : <>{fmtInt(view.hidden)} idle background {view.hidden === 1 ? 'process' : 'processes'} hidden</>}</span>
            <label className="rd-chk-l"><input type="checkbox" checked={showIdle} onChange={(e) => setShowIdle(e.target.checked)} /> show idle background processes</label>
          </div>
        )}
        <div className="rd-tblwrap">
          <table className="rd-tbl rd-procs">
            <thead>
              <tr>
                <SortTh label="Pid" col="pid" sort={st.sort} onSort={onSort} num title="The Oracle process number" />
                <SortTh label="Name" col="name" sort={st.sort} onSort={onSort} />
                <SortTh label="Ospid" col="ospid" sort={st.sort} onSort={onSort} num className="opt-col" />
                <SortTh label="Sid.serial" col="session" sort={st.sort} onSort={onSort} num />
                <SortTh label="Waiting for" col="event" sort={st.sort} onSort={onSort} />
                <SortTh label="Time in wait" col="wait" sort={st.sort} onSort={onSort} num title="The session's wait so far, from its wait stack (total=). Dimmed with the idle ones." />
                <SortTh label="Blocked by" col="blockedBy" sort={st.sort} onSort={onSort} num />
              </tr>
            </thead>
            <tbody>
              {view.rows.map((p) => <ProcRow key={p.pid} p={p} chain={view.chain.has(p.pid)} canOpen={canOpen} selectNode={selectNode} />)}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7}>
                  {fmtInt(view.rows.length)} of {fmtInt(r.processes.length)} listed processes shown
                  {r.processesOmitted > 0 ? <> · {fmtInt(r.processesOmitted)} more the reading does not list</> : null}
                  <span className="rd-dim"> · a rule at the left marks a session in the blocker tree</span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {(r.notes.length > 0 || !r.ended) && (
        <section className="rd-sec">
          {r.notes.map((n, i) => <p key={i} className="rd-note">{n}</p>)}
          {!r.ended && <p className="rd-note">The section stops before <span className="rd-mono">END OF SYSTEM STATE</span>: the dump is cut.</p>}
        </section>
      )}
    </div>
  )
}

/** The cell of what a process waits for: the summary's event with its class quietly, and the body's own event when the dump has moved on since the summary. */
function Waiting({ p }: { p: SysProc }) {
  if (!p.event) {
    return (
      <>
        {p.cmd ? <span className="rd-dim">{p.cmd}</span> : null}
        {p.caller ? <span className="rd-tag rd-tag0" title="The session of this process took the dump">took the dump</span> : null}
      </>
    )
  }
  return (
    <>
      {p.event}
      {p.class ? <span className="rd-dim cls" title={`wait class ${p.class}`}> · {p.class}</span> : null}
      {p.bodyEvent ? <div className="rd-note" title="The summary is written first and the bodies later: this process had moved on between them. The time in wait is the body's.">in its body: <span className="rd-mono">{p.bodyEvent}</span></div> : null}
    </>
  )
}

function ProcRow({ p, chain, canOpen, selectNode }: { p: SysProc; chain: boolean; canOpen(id: string | undefined): boolean; selectNode(id: string): void }) {
  const live = canOpen(p.node)
  const act = () => { if (p.node) selectNode(p.node) }
  return (
    <tr className={[live && 'rd-sel', p.idle && !chain && 'rd-idle', chain && 'rd-chain'].filter(Boolean).join(' ') || undefined} tabIndex={live ? 0 : undefined}
      onClick={live ? act : undefined} onKeyDown={live ? rowKeys(act) : undefined} data-pid={p.pid} title={live ? `Show the reading of process ${p.pid}` : undefined}>
      <td className="num">{p.pid}</td>
      <td className="mono">{p.name}</td>
      <td className="num mono dim opt-col">{p.ospid ?? ''}</td>
      <td className="num mono">{p.session ?? ''}{p.session ? <TraceMark by={{ session: p.session }} /> : null}</td>
      <td className="ev"><Waiting p={p} /></td>
      <td className="num" title={p.bodyEvent ? `Time in wait of '${p.bodyEvent}', the body's event` : undefined}>{p.waitSec !== undefined ? secs(p.waitSec) : ''}</td>
      <td className="num mono">{p.blockedBy.map((b) => b.key).join(', ')}</td>
    </tr>
  )
}

registerReading('sysstate', SysStateView)
