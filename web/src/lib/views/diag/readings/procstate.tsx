// The process reading (`procstate`, on a process state dump, one nested in a diagnostic dump, and a `PROCESS n: name` of a system state): the state object
// tree of one Oracle process read for who it and its session are, what it runs, what it waits for and who blocks it, and what it holds. Every fact links to its
// line; a session the dump names is a link to its process where that process is in the file. Layout A of docs/mockups/diag-reader/ (shots/process-light.png).
import { Fragment, useMemo, type ReactNode } from 'react'
import { fmtInt } from '../../../data/format'
import { libLabel, modeCounts, secs } from '../../../data/diagstack'
import { normalizeProcState, type ProcSession, type ProcState, type ProcWait, type SessionRef } from '../../../data/diagreadings'
import { TraceMark } from '../../../components/DumpMark'
import { CopyBlock, LineLink, SessionLink, useReadingUi } from './parts'
import { registerReading, type ReadingProps } from './registry'

type Link = (line: number, text?: ReactNode) => ReactNode

export interface ProcUi {
  /** the short stack includes the handler's own frames */
  incOwn: boolean
  /** the sessions whose whole wait history is shown (their keys) */
  histAll: string[]
}
export const initProcUi = (): ProcUi => ({ incOwn: false, histAll: [] })

const HISTORY_SHOWN = 10

export function ProcStateView({ node, reading, source, goLine, selectNode }: ReadingProps) {
  const r = useMemo(() => normalizeProcState(reading), [reading])
  const [st, patch] = useReadingUi<ProcUi>(source, node.id, initProcUi)
  const link: Link = (line, text) => <LineLink line={line} text={text} source={source} goLine={goLine} />
  const p = r.process
  const sess = (key: string) => <SessionLink source={source} self={node.id} session={key} selectNode={selectNode} />
  const one = r.sessions.length === 1 ? r.sessions[0] : undefined
  const title = (
    <>
      Process {p?.pid !== undefined ? <span className="rd-mono">{p.pid}</span> : null}{p?.name ? <>: <span className="rd-mono">{p.name}</span></> : null}
      {one ? <> · session <span className="rd-mono">{one.key}</span></> : r.sessions.length > 1 ? <> · {fmtInt(r.sessionsTotal)} sessions</> : null}
    </>
  )
  return (
    <div className="rd" data-reading="procstate">
      <header className="rd-head">
        <h3 className="rd-title">{title}</h3>
        <span className="rd-meta">
          {fmtInt(r.objects.total)} state objects · lines {link(r.from, fmtInt(r.from))}–{link(r.to, fmtInt(r.to))}
          {p ? <>, process at {link(p.line, fmtInt(p.line))}</> : null}
          {one ? <>, session at {link(one.line, fmtInt(one.line))}</> : null}
        </span>
      </header>

      {p && (
        <section className="rd-sec">
          <div className="rd-k">Process</div>
          <dl className="rd-kv">
            <dt>Oracle process</dt>
            <dd>
              {p.pid !== undefined ? <>pid <span className="rd-mono">{p.pid}</span>{p.serial !== undefined ? <>, ser <span className="rd-mono">{p.serial}</span></> : null}</> : <span className="rd-dim">no pid printed</span>}
              {p.ospid ? <> · server OS pid <span className="rd-mono">{p.ospid}</span></> : null}
              {p.osUser ? <> · OS user {p.osUser}</> : null}
              {p.flags && p.flags !== '-' ? <> · flags <span className="rd-mono">{p.flags}</span></> : null}
            </dd>
            {p.program ? <><dt>Program</dt><dd>{p.program}</dd></> : null}
          </dl>
        </section>
      )}

      {r.sessions.map((s) => (
        <Fragment key={s.address}>
          {r.sessions.length > 1 && <h4 className="rd-sess-h">Session {sess(s.key)} <span className="rd-dim">{s.user ?? ''}</span></h4>}
          <SessionParts s={s} st={st} patch={patch} link={link} sess={sess} />
        </Fragment>
      ))}
      {r.sessionsTotal > r.sessions.length && <p className="rd-note">and {fmtInt(r.sessionsTotal - r.sessions.length)} more {r.sessionsTotal - r.sessions.length === 1 ? 'session' : 'sessions'} the reading does not list.</p>}
      {r.sessions.length === 0 && (
        <section className="rd-sec"><p className="rd-p rd-dim">This process owns no session object in the dump.</p></section>
      )}

      <Holds r={r} link={link} />

      {r.shortStack && (
        <section className="rd-sec">
          <div className="rd-k">Short stack <span className="rd-dim">(innermost first, as the dump prints it)</span> {r.shortStackLine ? link(r.shortStackLine) : null}</div>
          <CopyBlock text={st.incOwn || !r.shortStackNoOwn ? r.shortStack : r.shortStackNoOwn} label="The short stack as one line">
            {(r.shortStackOwn ?? 0) > 0 && <label className="rd-chk-l"><input type="checkbox" checked={st.incOwn} onChange={(e) => patch({ incOwn: e.target.checked })} /> include the frames of the handler that took it ({r.shortStackOwn})</label>}
            <span className="rd-dim">{fmtInt(frameCount(st.incOwn || !r.shortStackNoOwn ? r.shortStack : r.shortStackNoOwn))} frames</span>
          </CopyBlock>
        </section>
      )}

      {r.notes.length > 0 && <section className="rd-sec">{r.notes.map((n, i) => <p key={i} className="rd-note">{n}</p>)}</section>}
    </div>
  )
}

const frameCount = (stack: string) => (stack === '' ? 0 : stack.split('<-').length)

function SessionParts({ s, st, patch, link, sess }: { s: ProcSession; st: ProcUi; patch(p: Partial<ProcUi>): void; link: Link; sess(key: string): ReactNode }) {
  const cmd = s.commandName ? `${s.commandName}` : s.command !== undefined ? `command ${s.command}` : ''
  return (
    <>
      <section className="rd-sec">
        <div className="rd-k">Who <span className="rd-dim">(the session object)</span></div>
        <dl className="rd-kv">
          <dt>Session</dt>
          <dd>{sess(s.key)}{s.user ? <> {s.user}</> : null}{s.container ? <> <span className="rd-dim">in {s.container}</span></> : null}</dd>
          {s.program || s.machine ? <><dt>Program</dt><dd>{s.program ?? ''}{s.machine ? <> <span className="rd-dim">on {s.machine}</span></> : null}</dd></> : null}
          {s.module || s.action ? <><dt>Module / action</dt><dd>{s.module ?? ''} <span className="rd-dim">/</span> {s.action ?? ''}</dd></> : null}
          {s.clientOspid || s.clientOsUser || s.service ? (
            <><dt>Client</dt><dd>{[s.clientOsUser && `OS user ${s.clientOsUser}`, s.clientOspid && `client OS pid ${s.clientOspid}`, s.service && `service ${s.service}`].filter(Boolean).join(' · ')}</dd></>
          ) : null}
        </dl>
      </section>

      <section className="rd-sec">
        <div className="rd-k">Runs</div>
        {cmd && <p className="rd-p">Command <b className="rd-strong">{cmd}</b>{s.command !== undefined && s.commandName ? <span className="rd-dim"> ({s.command})</span> : null} {s.commandLine ? link(s.commandLine) : null}</p>}
        <Statement what="Top-level call" text={s.sqlText} sqlId={s.sqlId} line={s.sqlLine} handle={s.sql} link={link} none="The session is not running a statement (its sql: is nil)." />
        {(s.prevSql || s.prevSqlText) && <Statement what="Previous statement" text={s.prevSqlText} sqlId={s.prevSqlId} line={s.prevSqlLine} handle={s.prevSql} link={link} />}
      </section>

      <section className="rd-sec">
        <div className="rd-k">Waits</div>
        {s.wait ? <Waits w={s.wait} link={link} sess={sess} /> : <p className="rd-p rd-dim">The dump prints no wait information for this session.</p>}
      </section>

      {s.wait && s.wait.history.length > 0 && <History w={s.wait} open={st.histAll.includes(s.key)} onAll={() => patch({ histAll: [...st.histAll, s.key] })} link={link} />}
    </>
  )
}

/** A statement: its sql_id with the "10046" link, the line, the first line of its text; or, where the dump's level has no text, the handle it names and why there is no text. */
function Statement({ what, text, sqlId, line, handle, link, none }: { what: string; text?: string; sqlId?: string; line?: number; handle?: string; link: Link; none?: string }) {
  if (text || sqlId) {
    return (
      <>
        <div className="rd-p"><span className="rd-dim">{what}</span> {sqlId ? <span className="rd-mono rd-strong">{sqlId}</span> : null}{line ? <> {link(line)}</> : null} {sqlId ? <TraceMark by={{ sqlId }} /> : null}</div>
        {text && <pre className="rd-code">{text}</pre>}
      </>
    )
  }
  if (handle) {
    return <p className="rd-note">{what}: the statement at library handle <span className="rd-mono">{handle}</span>. The dump holds no library object lock of the session on that handle, which is where it prints a statement&apos;s text, so the text is not in it.</p>
  }
  return none ? <p className="rd-p rd-dim">{none}</p> : null
}

function Waits({ w, link, sess }: { w: ProcWait; link: Link; sess(key: string): ReactNode }) {
  const e0 = w.stack[0]
  const finalSame = w.finalBlocker && w.blockers.some((b) => b.key === w.finalBlocker!.key)
  const refs = (xs: readonly SessionRef[]) => xs.map((b, i) => <Fragment key={b.key}>{i > 0 ? ', ' : null}{sess(b.key)} {link(b.line)}</Fragment>)
  return (
    <>
      <div className="rd-p">
        {w.inWait && e0 ? (
          <>
            <b>Waiting for</b> <span className="rd-mono">&apos;{e0.event}&apos;</span>
            {e0.seconds !== undefined ? <span className="rd-dim"> · {secs(e0.seconds)} so far</span> : null} {link(e0.line)}
            {e0.params ? <div className="rd-mono rd-dim rd-params">{e0.params}</div> : null}
            {w.stack.length > 1 && (
              <div className="rd-note">{w.stack.slice(1).map((x) => <div key={x.line}>then, inside it: <span className="rd-mono">&apos;{x.event}&apos;</span>{x.seconds !== undefined ? ` · ${secs(x.seconds)}` : ''} {link(x.line)}</div>)}</div>
            )}
          </>
        ) : (
          <>
            <b>Not in wait</b>{w.lastEndedSec !== undefined ? <span className="rd-dim"> · last wait ended {secs(w.lastEndedSec)} ago</span> : null} {w.line ? link(w.line) : null}
          </>
        )}
      </div>
      {w.blocked && (
        <div className="rd-p">
          Blocked by {w.blockers.length > 0 ? refs(w.blockers) : <span className="rd-dim">at least one session (the dump names none)</span>}
          {w.blockersCount && w.blockersCount > w.blockers.length ? <span className="rd-dim"> · {fmtInt(w.blockersCount)} direct blockers, {fmtInt(w.blockers.length)} listed</span> : null}
          {w.finalBlocker ? (finalSame ? <span className="rd-dim"> (also the final blocker)</span> : <>, final blocker {refs([w.finalBlocker])}</>) : null}
        </div>
      )}
      {w.blockedCount > 0 && (
        <div className="rd-p">
          Blocks <b className="rd-strong">{fmtInt(w.blockedCount)}</b> {w.blockedCount === 1 ? 'session' : 'sessions'} {w.blockedLine ? link(w.blockedLine) : null}
          {w.waiters.map((x) => (
            <div key={x.key} className="rd-waiter">
              {sess(x.key)} {link(x.line)} waits for {x.event ? <span className="rd-mono">&apos;{x.event}&apos;</span> : 'an event the dump does not name'}
              {x.rowWait ? <>, row {fmtInt(x.rowWait.row)} of block {fmtInt(x.rowWait.block)} in file {fmtInt(x.rowWait.file)} <span className="rd-dim">(object {fmtInt(x.rowWait.obj)})</span> {link(x.rowWait.line)}</> : null}
              {x.minBlockedSec !== undefined ? <span className="rd-dim"> · blocked for at least {fmtInt(x.minBlockedSec)} s</span> : null}
            </div>
          ))}
          {w.blockedCount > w.waiters.length && w.waiters.length > 0 && <div className="rd-note">The dump describes one waiter however many there are.</div>}
        </div>
      )}
    </>
  )
}

function History({ w, open, onAll, link }: { w: ProcWait; open: boolean; onAll(): void; link: Link }) {
  const list = open ? w.history : w.history.slice(0, HISTORY_SHOWN)
  const max = Math.max(0, ...w.history.map((h) => h.seconds ?? 0))
  return (
    <section className="rd-sec">
      <div className="rd-k">Wait history <span className="rd-dim">(latest first, the waits that ended{w.elapsedSec !== undefined ? `; ${secs(w.elapsedSec)} since the last one` : ''})</span> {w.historyLine ? link(w.historyLine) : null}</div>
      <ol className="rd-wh">
        {list.map((h) => (
          <li key={h.line}>
            <span className="num rd-dim">{h.n}</span>
            <span className="rd-mono ev" title={h.params}>{h.event}</span>
            <span className="num">{h.seconds !== undefined ? secs(h.seconds) : ''}</span>
            <span className="bc">{h.seconds !== undefined && max > 0 ? <i style={{ inlineSize: `${Math.max(1, (100 * h.seconds) / max)}%` }} /> : null}</span>
            <span className="num">{link(h.line, fmtInt(h.line))}</span>
          </li>
        ))}
      </ol>
      {w.history.length > list.length && <p className="rd-note"><button type="button" className="rd-more" onClick={onAll}>Show the other {fmtInt(w.history.length - list.length)}</button></p>}
      {w.historyTotal > w.history.length && <p className="rd-note">and {fmtInt(w.historyTotal - w.history.length)} older {w.historyTotal - w.history.length === 1 ? 'entry' : 'entries'} the reading does not list.</p>}
    </section>
  )
}

const more = (total: number, n: number, what: string) => (total > n ? <p className="rd-note">and {fmtInt(total - n)} more {what} the reading does not list ({fmtInt(total)} in all).</p> : null)

function Holds({ r, link }: { r: ProcState; link: Link }) {
  const types = r.objects.byType.filter((t) => t.type !== 'process' && t.type !== 'session')
  const detail = (type: string): ReactNode => {
    const t = type.toLowerCase()
    if (t === 'library object lock' && r.locks.length) return <>{modeCounts(r.locks)}{r.locksTotal > r.locks.length ? <span className="rd-dim"> (of the {r.locks.length} listed)</span> : null}</>
    if (t === 'library object pin' && r.pins.length) return <>{r.pins.slice(0, 3).map((x) => x.name ?? libLabel(x)).join(', ')}{r.pins.length > 3 ? ', …' : ''}<span className="rd-dim"> · {modeCounts(r.pins)}</span></>
    if (t === 'enqueue' && r.enqueues.length) return <>{r.enqueues.slice(0, 2).map((e) => <div key={e.line}>{e.resource} <span className="rd-dim">{e.requested ? 'requested' : 'held'} {e.mode}</span></div>)}{r.enqueues.length > 2 ? <span className="rd-dim">…</span> : null}</>
    if (t === 'transaction' && r.transactions.length) return <>{r.transactions.map((x) => x.xid).filter(Boolean).join(', ')}</>
    return null
  }
  return (
    <>
      <section className="rd-sec">
        <div className="rd-k">Holds <span className="rd-dim">(state objects under the process, by type, with the count the dump prints)</span></div>
        <table className="rd-tbl">
          <thead><tr><th>Type</th><th className="num">Count</th><th>Detail</th></tr></thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.type}>
                <td className="mono">{t.type} <span className="rd-dim">({t.number})</span></td>
                <td className="num">{fmtInt(t.count)}</td>
                <td className="wrap mono">{detail(t.type)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td>{fmtInt(r.objects.total)} state objects</td><td /><td className="rd-dim">tree {r.objects.depth} deep{r.objects.typesOther ? ` · ${fmtInt(r.objects.typesOther)} more types not listed` : ''}</td></tr></tfoot>
        </table>
      </section>

      {r.enqueuesTotal > 0 && (
        <section className="rd-sec">
          <div className="rd-k">Enqueues <span className="rd-dim">(held or requested)</span></div>
          <div className="rd-tblwrap"><table className="rd-tbl">
            <thead><tr><th>Resource</th><th>Mode</th><th>Flag</th><th>In</th><th>Session</th><th className="num">Line</th></tr></thead>
            <tbody>{r.enqueues.map((e) => (
              <tr key={e.line}>
                <td className="mono">{e.resource}</td>
                <td className="mono nw">{e.mode}{e.requested ? <span className="rd-tag" title="requested, not held">requested</span> : null}</td>
                <td className="mono dim">{e.flag ?? ''}</td>
                <td className="dim">{e.in ?? ''}</td>
                <td className="mono dim">{e.session ?? ''}</td>
                <td className="num">{link(e.line, fmtInt(e.line))}</td>
              </tr>
            ))}</tbody>
          </table></div>
          {more(r.enqueuesTotal, r.enqueues.length, 'enqueues')}
          {r.enqueuesOther ? <p className="rd-note">{fmtInt(r.enqueuesOther)} more &quot;Enqueue Dump&quot; {r.enqueuesOther === 1 ? 'line names' : 'lines name'} no resource (released, or in flux).</p> : null}
        </section>
      )}

      {r.transactionsTotal > 0 && (
        <section className="rd-sec">
          <div className="rd-k">Transactions</div>
          {r.transactions.map((t) => (
            <div className="rd-blk" key={t.line}>
              <div className="rd-blk-h">
                <b className="rd-mono">{t.xid ?? t.address}</b> {link(t.line)}
                <span className="rd-meta">{t.begin ? `begun ${t.begin}` : ''}{t.undoBlocks !== undefined ? ` · undo ${fmtInt(t.undoBlocks)} blocks, ${fmtInt(t.undoRecords ?? 0)} records` : ''}{t.session ? ` · session ${t.session}` : ''}</span>
              </div>
              {t.blocks.length > 0 && (
                <table className="rd-tbl rd-narrow">
                  <thead><tr><th>Block List</th><th className="num">itli</th><th>rdba</th><th>sql_id</th><th className="num">obj#</th><th className="num">Line</th></tr></thead>
                  <tbody>{t.blocks.map((b) => <tr key={b.line}><td /><td className="num">{b.itli}</td><td className="mono">{b.rdba}</td><td className="mono">{b.sqlId} <TraceMark by={{ sqlId: b.sqlId }} /></td><td className="num">{fmtInt(b.obj)}</td><td className="num">{link(b.line, fmtInt(b.line))}</td></tr>)}</tbody>
                </table>
              )}
              {more(t.blocksTotal, t.blocks.length, 'block list rows')}
            </div>
          ))}
          {more(r.transactionsTotal, r.transactions.length, 'transactions')}
        </section>
      )}

      {r.dmlLocksTotal > 0 && (
        <section className="rd-sec">
          <div className="rd-k">DML locks</div>
          <table className="rd-tbl rd-narrow">
            <thead><tr><th className="num">Table (object id)</th><th>Mode</th><th>Flags</th><th>Session</th><th className="num">Line</th></tr></thead>
            <tbody>{r.dmlLocks.map((d) => (
              <tr key={d.line}>
                <td className="num">{fmtInt(d.table)}</td>
                <td className="mono">{d.modeName ?? (d.mode !== undefined ? `mod=${d.mode}` : '')}</td>
                <td className="mono dim">{d.flags ?? ''}</td>
                <td className="mono dim">{d.session ?? ''}</td>
                <td className="num">{link(d.line, fmtInt(d.line))}</td>
              </tr>
            ))}</tbody>
          </table>
          {more(r.dmlLocksTotal, r.dmlLocks.length, 'DML locks')}
        </section>
      )}

      {r.locksTotal > 0 && <LibList title="Library object locks" list={r.locks} total={r.locksTotal} link={link} />}
      {r.pinsTotal > 0 && <LibList title="Library object pins" list={r.pins} total={r.pinsTotal} link={link} pins />}
    </>
  )
}

function LibList({ title, list, total, link, pins }: { title: string; list: ProcState['locks']; total: number; link: Link; pins?: boolean }) {
  return (
    <section className="rd-sec">
      <details className="rd-details" open={list.length <= 8}>
        <summary>{title} ({fmtInt(total)})</summary>
        <div className="rd-tblwrap"><table className="rd-tbl">
          <thead><tr><th>Object</th><th>Kind</th><th>Mode</th>{pins ? <th className="num">Count</th> : null}<th>sql_id</th><th className="num">Line</th></tr></thead>
          <tbody>{list.map((l) => (
            <tr key={l.line}>
              <td className="mono wrap">{l.name ?? <span className="rd-dim">handle {l.handle}</span>}</td>
              <td className="dim">{[l.namespace, l.type].filter(Boolean).join(' · ')}</td>
              <td className="mono">{l.mode}</td>
              {pins ? <td className="num">{l.count ?? ''}</td> : null}
              <td className="mono nw">{l.sqlId ?? ''} {l.sqlId ? <TraceMark by={{ sqlId: l.sqlId }} /> : null}</td>
              <td className="num">{link(l.line, fmtInt(l.line))}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {more(total, list.length, title.toLowerCase())}
      </details>
    </section>
  )
}

registerReading('procstate', ProcStateView)
