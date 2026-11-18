// The deadlock reading (`deadlock`): the headline (ORA-00060, its type, the session that wrote the trace), the cycle drawn as sessions with arrows "waits for
// <resource> held by", the graph as the dump's own table, each waiting session's block and the rows waited on, and the way to the diagnostic dump that follows.
import { Fragment, useMemo, type CSSProperties, type ReactNode } from 'react'
import { fmtInt } from '../../../data/format'
import { normalizeDeadlock, type Deadlock, type DeadlockParty, type DeadlockSession } from '../../../data/diagreadings'
import { cycleLayout, sessionRoles, type BlockCard, type CycleItem, type CycleLayout } from '../../../data/diagsys'
import { secs } from '../../../data/diagstack'
import { SessionCard, nodeReach } from './blockers'
import { LineLink, SessionLink } from './parts'
import { registerReading, type ReadingProps } from './registry'

type Link = (line: number, text?: ReactNode) => ReactNode

const where = (s: Pick<DeadlockSession, 'module' | 'action'> | undefined): string | undefined => [s?.module, s?.action].filter(Boolean).join(' / ') || undefined

/** What a card of the ring says: who, what it runs; the resource it holds and waits for are on the arrows. */
function ringCard(it: CycleItem): BlockCard {
  const s = it.session
  return { key: it.key, user: s?.user, where: where(s), tag: it.victim ? 'victim' : undefined, noWait: true, sqlText: s?.sqlText, line: s?.line }
}

export function DeadlockView({ node, reading, source, goLine, selectNode }: ReadingProps) {
  const r = useMemo(() => normalizeDeadlock(reading), [reading])
  const link: Link = (line, text) => <LineLink line={line} text={text} source={source} goLine={goLine} />
  const canOpen = useMemo(() => nodeReach(source), [source])
  const layout = useMemo(() => cycleLayout(r), [r])
  const sess = (key: string) => <SessionLink source={source} self={node.id} session={key} selectNode={selectNode} />
  const props = { source, goLine, selectNode, canOpen }
  return (
    <div className="rd" data-reading="deadlock">
      <header className="rd-head">
        <h3 className="rd-title">Deadlock detected <span className="rd-mono">{r.ora}</span></h3>
        <span className="rd-meta">
          {r.type ? <>{r.type} · </> : null}{r.graph.rowsTotal} {r.graph.rowsTotal === 1 ? 'resource' : 'resources'} in the graph · line {link(r.line)}
          {r.sessionsLine ? <>, waiting sessions at {link(r.sessionsLine)}</> : null}
        </span>
        <span className="rd-meta">
          {r.victim
            ? <>The trace was written by session {sess(r.victim.session)} <span className="rd-dim">(marker at line</span> {link(r.victim.line)}<span className="rd-dim">)</span>: the session in which ORA-00060 was raised{r.victim.inGraph ? '' : ', which is not in the graph'}.</>
            : <>The file has no session marker before the section, so the session that wrote the trace is not known.</>}
        </span>
      </header>

      {layout.items.length > 0 && (
        <section className="rd-sec" aria-label="The cycle">
          <div className="rd-k">
            The cycle <span className="rd-dim">({layout.closed ? `${layout.items.length} sessions, each waits for a resource the next one holds, the last for one the first holds` : 'the rows of the graph do not close into a cycle; the chain they make is drawn'})</span>
          </div>
          <Ring layout={layout} props={props} link={link} />
        </section>
      )}

      <section className="rd-sec" aria-label="Deadlock graph">
        <div className="rd-k">Deadlock graph <span className="rd-dim">(as the dump prints it) {r.graph.line ? link(r.graph.line) : null}</span></div>
        {r.graph.rows.length === 0 ? <p className="rd-p rd-dim">The dump prints no row under &quot;Deadlock graph:&quot;.</p> : <GraphTable r={r} link={link} />}
        {r.graph.rowsTotal > r.graph.rows.length && <p className="rd-note">and {fmtInt(r.graph.rowsTotal - r.graph.rows.length)} more rows the reading does not list.</p>}
      </section>

      {r.sessions.length > 0 && (
        <section className="rd-sec" aria-label="Waiting sessions">
          <div className="rd-k">Information for waiting sessions {r.sessionsLine ? link(r.sessionsLine) : null}</div>
          {r.sessions.map((s) => <SessionBlock key={s.line} s={s} r={r} link={link} sess={sess} />)}
          {r.sessionsTotal > r.sessions.length && <p className="rd-note">and {fmtInt(r.sessionsTotal - r.sessions.length)} more sessions the reading does not list.</p>}
          {!r.sessionsEnded && <p className="rd-note">The block ends before <span className="rd-mono">End of information for waiting sessions</span>.</p>}
        </section>
      )}

      {r.rowsWaited && r.rowsWaited.rows.length > 0 && (
        <section className="rd-sec" aria-label="Rows waited on">
          <div className="rd-k">Rows waited on <span className="rd-dim">(in the dump that follows the graph) {link(r.rowsWaited.line)}</span></div>
          <div className="rd-tblwrap">
            <table className="rd-tbl rd-narrow">
              <thead><tr><th className="num">Session</th><th className="num">Object id</th><th>Rowid</th><th className="num">File</th><th className="num">Block</th><th className="num">Slot</th><th className="num">Line</th></tr></thead>
              <tbody>
                {r.rowsWaited.rows.map((x) => (
                  <tr key={x.line}>
                    <td className="num mono">{x.session}</td>
                    {x.noRow ? <td colSpan={5} className="dim">no row: the session waits for a lock that is not on a row</td> : (
                      <>
                        <td className="num mono" title={x.obj ? `obj ${x.obj} as printed` : undefined}>{x.objn !== undefined ? fmtInt(x.objn) : x.obj ?? ''}</td>
                        <td className="mono">{x.rowid ?? ''}</td>
                        <td className="num mono">{x.file !== undefined ? fmtInt(x.file) : ''}</td>
                        <td className="num mono">{x.block !== undefined ? fmtInt(x.block) : ''}</td>
                        <td className="num mono">{x.slot ?? ''}</td>
                      </>
                    )}
                    <td className="num">{link(x.line, fmtInt(x.line))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.rowsWaited.total > r.rowsWaited.rows.length && <p className="rd-note">and {fmtInt(r.rowsWaited.total - r.rowsWaited.rows.length)} more rows the reading does not list.</p>}
        </section>
      )}

      {r.dump && (
        <section className="rd-sec" aria-label="The diagnostic dump that follows">
          <div className="rd-k">The dump that follows</div>
          <p className="rd-p">After the graph the instance writes a whole diagnostic dump: <b>{r.dump.title}</b>, lines {link(r.dump.from, fmtInt(r.dump.from))}–{link(r.dump.to, fmtInt(r.dump.to))}.</p>
          <p className="rd-p">
            {canOpen(r.dump.node)
              ? <button type="button" className="rd-more" onClick={() => selectNode(r.dump!.node)}>Show its call stack reading</button>
              : <span className="rd-dim">Its reading is not in this report.</span>}
          </p>
        </section>
      )}

      {r.notes.length > 0 && <section className="rd-sec">{r.notes.map((n, i) => <p key={i} className="rd-note">{n}</p>)}</section>}
    </div>
  )
}

/** "waits for TX-… (X) held by", the text on an arrow. */
function EdgeLabel({ it }: { it: CycleItem }) {
  return (
    <>
      <span className="dl-e-t">waits for</span>{' '}
      <span className="rd-mono dl-e-r">{it.out!.resource}</span>{' '}
      {it.out!.mode ? <span className="dl-e-t">mode {it.out!.mode}</span> : null}
    </>
  )
}

/** The sessions of the cycle as cards with arrows between them (in a row up to three, stacked beyond), the way back from the last to the first under or after them. */
function Ring({ layout, props, link }: { layout: CycleLayout; props: Omit<Parameters<typeof SessionCard>[0], 'card'>; link: Link }) {
  const { items } = layout
  const last = items[items.length - 1]
  return (
    <div className={`dl-ring ${layout.mode}`} style={{ '--n': items.length } as CSSProperties}>
      <ol className="dl-row">
        {items.map((it, i) => (
          <Fragment key={it.key}>
            <li className="dl-s"><SessionCard card={ringCard(it)} {...props} more={it.session?.heldResource ? <div className="bt-w rd-dim">holds <span className="rd-mono">{it.session.heldResource.split('-')[0]}</span>{it.session.acquiredSec !== undefined ? <>, acquired {secs(it.session.acquiredSec)} ago</> : null}</div> : undefined} /></li>
            {it.out && i < items.length - 1 ? (
              <li className="dl-e" aria-label={`${it.key} waits for ${it.out.resource}, held by ${it.to}`}>
                <EdgeLabel it={it} />
                <span className="dl-arrow" aria-hidden="true" />
                <span className="dl-sep"> · </span><span className="dl-e-t">held by {it.to}</span>{' '}
                <span className="rd-note">{link(it.out.line)}</span>
              </li>
            ) : null}
          </Fragment>
        ))}
      </ol>
      {layout.closed && last?.out ? (
        <div className="dl-back" aria-label={`${last.key} waits for ${last.out.resource}, held by ${last.to}`}>
          <span className="dl-e-t">{last.key} waits for</span> <span className="rd-mono dl-e-r">{last.out.resource}</span>{last.out.mode ? <span className="dl-e-t"> mode {last.out.mode}</span> : null}
          <span className="dl-e-t"> · held by {last.to}, the first session of the cycle</span> <span className="rd-note">{link(last.out.line)}</span>
        </div>
      ) : null}
    </div>
  )
}

const cell = (n: number | undefined) => (n === undefined ? '' : String(n))

function Party({ p }: { p: DeadlockParty }) {
  return (
    <>
      <td className="num mono">{cell(p.process)}</td>
      <td className="num mono">{cell(p.session)}</td>
      <td className="mono ctr">{p.holds ?? ''}</td>
      <td className="mono ctr">{p.waits ?? ''}</td>
      <td className="num mono">{cell(p.serial)}</td>
    </>
  )
}

/** The graph's own table: a resource and, on each side, the process, the session, the mode it holds and the one it waits for, and its serial. */
function GraphTable({ r, link }: { r: Deadlock; link: Link }) {
  return (
    <div className="rd-tblwrap">
      <table className="rd-tbl rd-graph">
        <thead>
          <tr>
            <th rowSpan={2}>Resource</th>
            <th colSpan={5} className="grp">Blocker(s)</th>
            <th colSpan={5} className="grp">Waiter(s)</th>
            <th rowSpan={2} className="num">Line</th>
          </tr>
          <tr>
            {['Process', 'Session', 'Holds', 'Waits', 'Serial', 'Process', 'Session', 'Holds', 'Waits', 'Serial'].map((h, i) => <th key={i} className={h === 'Holds' || h === 'Waits' ? 'ctr' : 'num'}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {r.graph.rows.map((row) => (
            <tr key={row.line}>
              <td className="mono wrap">{row.resource}</td>
              <Party p={row.blocker} />
              <Party p={row.waiter} />
              <td className="num">{link(row.line, fmtInt(row.line))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One session's block of "Information for waiting sessions", with what the graph says it holds and waits for. */
function SessionBlock({ s, r, link, sess }: { s: DeadlockSession; r: Deadlock; link: Link; sess(key: string): ReactNode }) {
  const roles = sessionRoles(r, s)
  const victim = r.victim?.session === s.key
  return (
    <div className="rd-blk dl-block" data-session={s.key}>
      <div className="rd-blk-h">
        <b>Session {s.number}</b>
        <span>{sess(s.key)}</span>
        {victim ? <span className="bt-tag acc" title="The session that wrote this trace: ORA-00060 is raised in one of the sessions of the cycle, and its process writes the dump.">victim</span> : null}
        {!s.inGraph ? <span className="rd-tag" title="No row of the graph names this session">not in the graph</span> : null}
        <span className="rd-meta">lines {link(s.from, fmtInt(s.from))}–{link(s.to, fmtInt(s.to))}</span>
      </div>
      <dl className="rd-kv">
        {s.user ? <><dt>User</dt><dd>{s.user}{s.userId !== undefined ? <span className="rd-dim"> · id {s.userId}</span> : null}</dd></> : null}
        {s.container ? <><dt>Container</dt><dd>{s.container}</dd></> : null}
        {s.program || s.machine ? <><dt>Program</dt><dd>{s.program ?? ''}{s.machine ? <span className="rd-dim"> on {s.machine}</span> : null}</dd></> : null}
        {s.module || s.action ? <><dt>Module / action</dt><dd>{s.module ?? ''} <span className="rd-dim">/</span> {s.action ?? ''}</dd></> : null}
        {s.pid !== undefined || s.ospid ? <><dt>Process</dt><dd>{s.pid !== undefined ? <>pid <span className="rd-mono">{s.pid}</span></> : null}{s.ospid ? <> · OS pid <span className="rd-mono">{s.ospid}</span></> : null}{s.osUser ? <> · OS user {s.osUser}</> : null}{s.image ? <span className="rd-dim"> · {s.image}</span> : null}</dd></> : null}
        {s.clientOspid || s.clientOsUser ? <><dt>Client</dt><dd>{[s.clientOsUser && `OS user ${s.clientOsUser}`, s.clientOspid && `OS pid ${s.clientOspid}`].filter(Boolean).join(' · ')}</dd></> : null}
        {s.audsid !== undefined ? <><dt>Audit session id</dt><dd className="rd-mono">{s.audsid}</dd></> : null}
        {roles.holds ? <><dt>Holds</dt><dd><span className="rd-mono">{roles.holds}</span>{s.acquired ? <span className="rd-dim"> · acquired {s.acquired}</span> : null}</dd></> : null}
        {roles.waitsFor ? (
          <><dt>Waits for</dt><dd><span className="rd-mono">{roles.waitsFor.resource}</span><span className="rd-dim">{roles.waitsFor.mode ? ` · mode ${roles.waitsFor.mode}` : ''}{roles.heldBy ? ` · held by ${roles.heldBy}` : ''}</span></dd></>
        ) : null}
      </dl>
      {s.sqlText ? (
        <>
          <div className="rd-p"><span className="rd-dim">Current SQL</span> {s.sqlLine ? link(s.sqlLine) : null}</div>
          <pre className="rd-code">{s.sqlText}</pre>
          {s.sqlCut && <p className="rd-note">The statement is cut by the reading.</p>}
        </>
      ) : <p className="rd-p rd-dim">The dump prints no current SQL for this session.</p>}
    </div>
  )
}

registerReading('deadlock', DeadlockView)
