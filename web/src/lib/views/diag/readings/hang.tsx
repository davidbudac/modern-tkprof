// The hang analysis reading (`hang`): the chains of sessions that wait for one another, as the dump prints them, each drawn as the same tree of session cards as a
// system state's blocker tree with the head of the chain (the last session the dump prints, the one the others wait for) on top; the list of the chains most
// likely to have caused the hang; the "State of ALL nodes" table, closed. Layout A of docs/mockups/diag-reader/ (shots/hang-light.png).
import { Fragment, useMemo, useRef, type ReactNode } from 'react'
import { fmtInt } from '../../../data/format'
import { normalizeHang, type HangChain, type HangNodes, type HangReading, type HangSession } from '../../../data/diagreadings'
import { chainTree, hex32 } from '../../../data/diagsys'
import { secs } from '../../../data/diagstack'
import { BlockerTree, nodeReach } from './blockers'
import { CopyBlock, LineLink, useReadingUi } from './parts'
import { registerReading, type ReadingProps } from './registry'

export interface HangUi {
  /** the sessions (their keys, per chain) whose details are open */
  open: string[]
  /** the "State of ALL nodes" table is open */
  nodes: boolean
  /** the short stacks include the signal handler's own frames */
  incOwn: boolean
}
export const initHangUi = (): HangUi => ({ open: [], nodes: false, incOwn: false })

const HISTORY_SHOWN = 10

/** What the dump's "current sql_id" is, for the tooltip next to the number. */
export const SQLID_HIGH_NOTE = 'The dump prints a number here, not the 13-character sql_id: the high 32 bits of the number the sql_id spells (bytes 9 to 12 of the statement\'s FullHashValue). It is not the hash value either, so it cannot be matched to the hv= of a SQL trace.'

export function HangView({ node, reading, source, goLine, selectNode }: ReadingProps) {
  const r = useMemo(() => normalizeHang(reading), [reading])
  const [st, patch] = useReadingUi<HangUi>(source, node.id, initHangUi)
  const root = useRef<HTMLDivElement>(null)
  const link = (line: number, text?: ReactNode) => <LineLink line={line} text={text} source={source} goLine={goLine} />
  const canOpen = useMemo(() => nodeReach(source), [source])
  const sessions = r.chains.reduce((n, c) => n + c.sessionsTotal, 0)
  const showChain = (n: number) => root.current?.querySelector(`[data-chain="${n}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  return (
    <div className="rd" data-reading="hang" ref={root}>
      <header className="rd-head">
        <h3 className="rd-title">Hang analysis</h3>
        <span className="rd-meta">
          {r.level !== undefined ? <>level {r.level} · </> : null}{fmtInt(r.chainsTotal)} {r.chainsTotal === 1 ? 'chain' : 'chains'} · {fmtInt(sessions)} {sessions === 1 ? 'session' : 'sessions'} · line {link(r.headerLine)}
          {r.chains.length < r.chainsTotal ? <> · the first {fmtInt(r.chains.length)} chains are listed</> : null}
        </span>
        <dl className="rd-kv rd-facts">
          <dt>Instances</dt><dd>{r.instances.length > 0 ? <span className="rd-mono">{r.instances.join(', ')}</span> : <span className="rd-dim">none named</span>}</dd>
          <dt>Initiated by</dt><dd>{r.initiatedBy ? <span className="rd-mono">{r.initiatedBy}</span> : <span className="rd-dim">not said (the event form of the dump prints no &quot;analysis initiated by&quot; line)</span>}</dd>
          {r.level !== undefined ? <><dt>Node dump level</dt><dd><span className="rd-mono">oradebug_node_dump_level: {r.level}</span></dd></> : null}
        </dl>
        {r.delays.length > 0 && (
          <details className="rd-details rd-quiet">
            <summary>OS thread scheduling delay history</summary>
            <div className="rd-lines">{r.delays.map((d, i) => <div key={i} className="rd-mono">{d}</div>)}</div>
          </details>
        )}
      </header>

      {r.listed.length > 0 && (
        <section className="rd-sec" aria-label="Chains most likely to have caused the hang">
          <div className="rd-k">Chains most likely to have caused the hang <span className="rd-dim">(the dump lists the event of the head first)</span></div>
          <div className="rd-tblwrap">
            <table className="rd-tbl rd-listed">
              <thead><tr><th>Chain</th><th>Signature</th><th>Hash</th><th className="num">Line</th></tr></thead>
              <tbody>
                {r.listed.map((l) => (
                  <tr key={l.chain + l.letter}>
                    <td className="nw">[{l.letter}] <button type="button" className="rd-lnk rd-ui" title={`Go to chain ${l.chain}`} onClick={() => showChain(l.chain)}>Chain {l.chain}</button></td>
                    <td className="mono wrap">{l.signature}</td>
                    <td className="mono dim nw">{l.hash ?? ''}</td>
                    <td className="num">{link(l.line, fmtInt(l.line))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {r.chains.map((c) => <Chain key={c.n} c={c} st={st} patch={patch} source={source} goLine={goLine} selectNode={selectNode} canOpen={canOpen} link={link} />)}
      {r.chainsTotal > r.chains.length && <p className="rd-note">and {fmtInt(r.chainsTotal - r.chains.length)} more {r.chainsTotal - r.chains.length === 1 ? 'chain' : 'chains'} the reading does not list ({fmtInt(r.chainsTotal)} in all).</p>}
      {r.chains.length === 0 && <section className="rd-sec"><p className="rd-p">The dump prints no chain: no session waits for another, or none is in a hang the analysis reports.</p></section>}

      {r.nodes && (
        <section className="rd-sec" aria-label="State of ALL nodes">
          <details className="rd-details" open={st.nodes} onToggle={(e) => { if (e.currentTarget.open !== st.nodes) patch({ nodes: e.currentTarget.open }) }}>
            <summary>State of ALL nodes ({fmtInt(r.nodes.total)}) {link(r.nodes.line)}</summary>
            <NodesTable nodes={r.nodes} link={link} />
          </details>
        </section>
      )}

      {(r.extra.length > 0 || r.dumps) && (
        <section className="rd-sec">
          <details className="rd-details">
            <summary>Extra information and the analysis dumps</summary>
            {r.extra.length > 0 && (
              <>
                <div className="rd-k">Extra information that will be dumped at higher levels</div>
                <div className="rd-lines">{r.extra.map((x, i) => <div key={i} className="rd-mono">{x}</div>)}</div>
              </>
            )}
            {r.dumps && <Dumps d={r.dumps} link={link} />}
          </details>
        </section>
      )}

      {(r.notes.length > 0 || !r.ended) && (
        <section className="rd-sec">
          {r.notes.map((n, i) => <p key={i} className="rd-note">{n}</p>)}
          {!r.ended && <p className="rd-note">The section stops before <span className="rd-mono">END OF HANG ANALYSIS</span>: the dump is cut.</p>}
        </section>
      )}
    </div>
  )
}

function Dumps({ d, link }: { d: NonNullable<HangReading['dumps']>; link(line: number, text?: ReactNode): ReactNode }) {
  return (
    <>
      <div className="rd-k">HANG ANALYSIS DUMPS {link(d.line)}{d.level !== undefined ? <span className="rd-dim"> · oradebug_node_dump_level: {d.level}</span> : null}</div>
      {d.lines.length > 0 && <div className="rd-lines">{d.lines.map((x, i) => <div key={i} className="rd-mono">{x}</div>)}</div>}
      {d.local && <><div className="rd-k">State of LOCAL nodes ({fmtInt(d.local.total)})</div><NodesTable nodes={d.local} link={link} /></>}
    </>
  )
}

/** "State of ALL nodes": the adjacency list is the node the session is blocked by; it is resolved to that node's session where the table has it. */
function NodesTable({ nodes, link }: { nodes: HangNodes; link(line: number, text?: ReactNode): ReactNode }) {
  const keyOf = new Map(nodes.rows.map((n) => [n.num, n.key] as const))
  return (
    <div className="rd-tblwrap">
      <table className="rd-tbl rd-narrow">
        <thead><tr><th className="num" title="nodenum">Node</th><th className="num">Sid.serial</th><th className="num">Ospid</th><th>State</th><th className="num" title="The adjacency list: the node the session is blocked by">Blocked by node</th><th className="num">Line</th></tr></thead>
        <tbody>
          {nodes.rows.map((n) => (
            <tr key={n.line}>
              <td className="num">{n.num}</td>
              <td className="num mono">{n.key}</td>
              <td className="num mono dim">{n.ospid}</td>
              <td className="mono">{n.state}</td>
              <td className="num mono dim">{n.adj.map((a, i) => <span key={a}>{i > 0 ? ', ' : ''}{a}{keyOf.has(a) ? <span title={`session ${keyOf.get(a)}`}> ({keyOf.get(a)})</span> : null}</span>)}</td>
              <td className="num">{link(n.line, fmtInt(n.line))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {nodes.total > nodes.rows.length && <p className="rd-note">and {fmtInt(nodes.total - nodes.rows.length)} more rows the reading does not list.</p>}
    </div>
  )
}

interface ChainProps {
  c: HangChain
  st: HangUi
  patch(p: Partial<HangUi>): void
  source: ReadingProps['source']
  goLine(line: number): void
  selectNode(id: string): void
  canOpen(id: string | undefined): boolean
  link(line: number, text?: ReactNode): ReactNode
}

const openKey = (c: HangChain, s: HangSession) => `${c.n}:${s.key}`

function Chain({ c, st, patch, source, goLine, selectNode, canOpen, link }: ChainProps) {
  const tree = useMemo(() => chainTree(c), [c])
  const whole = c.sessionsTotal <= c.sessions.length
  const waiterFirst = c.sessions.map((s) => s.key)
  return (
    <section className="rd-sec" data-chain={c.n} aria-label={`Chain ${c.n}`}>
      <div className="rd-k">
        Chain {c.n}{' '}
        <span className="rd-dim">
          {fmtInt(c.sessionsTotal)} {c.sessionsTotal === 1 ? 'session' : 'sessions'} · lines {link(c.from, fmtInt(c.from))}–{link(c.to, fmtInt(c.to))}
          {c.letter ? <> · listed as [{c.letter}]</> : null}
          {c.group ? <> · {c.group.toLowerCase()}</> : null}
        </span>
      </div>
      {c.signature && <div className="rd-p rd-mono rd-sig" title="The events the chain waits for, the head's first">{c.signature}{c.hash ? <span className="rd-dim rd-nw"> · hash {c.hash}</span> : null}</div>}
      {tree && (
        <BlockerTree
          forest={[tree]}
          props={{ source, goLine, selectNode, canOpen }}
          extra={(n) => ({
            wait: <HangWaitInfo s={n.ref} />,
            more: <HangMore s={n.ref} open={st.open.includes(openKey(c, n.ref))} incOwn={st.incOwn} link={link}
              onOpen={(open) => patch({ open: open ? [...st.open, openKey(c, n.ref)] : st.open.filter((k) => k !== openKey(c, n.ref)) })} onOwn={(incOwn) => patch({ incOwn })} />,
          })}
        />
      )}
      {c.sessions.length > 1 && whole && (
        <p className="rd-note">In the dump&apos;s order the waiter comes first: {waiterFirst.map((k, i) => <Fragment key={k}>{i > 0 ? ', blocked by ' : ''}<span className="rd-mono">{k}</span></Fragment>)}. The last one is the head of the chain, the session the others wait for.</p>
      )}
      {!whole && <p className="rd-note">The chain has {fmtInt(c.sessionsTotal)} sessions and the reading lists the first {fmtInt(c.sessions.length)}: the head of the chain, the last one the dump prints, is not among them.</p>}
    </section>
  )
}

/** After the card's wait line: the timeout, or the state of a session that is not waiting. */
function HangWaitInfo({ s }: { s: HangSession }) {
  if (!s.waiting) {
    return <span className="rd-dim"> · {s.lastWaitText ? <>last wait: {s.lastWaitText}</> : (s.state ?? 'not waiting')}</span>
  }
  if (s.timeoutText === undefined) return null
  return <span className="rd-dim"> · {s.timeoutText === 'never' ? 'no timeout' : <>times out in {s.timeoutSec !== undefined ? secs(s.timeoutSec) : s.timeoutText}</>}</span>
}

interface MoreProps { s: HangSession; open: boolean; incOwn: boolean; link(line: number, text?: ReactNode): ReactNode; onOpen(open: boolean): void; onOwn(v: boolean): void }

/** The details a card opens: the wait parameters, the statement and the number the dump prints for it, the short stack, the wait history. */
function HangMore({ s, open, incOwn, link, onOpen, onOwn }: MoreProps) {
  const stack = incOwn || !s.shortStackNoOwn ? s.shortStack : s.shortStackNoOwn
  const hist = s.history.slice(0, HISTORY_SHOWN)
  const max = Math.max(0, ...s.history.map((h) => h.waitedSec ?? 0))
  const any = s.params.length > 0 || s.sqlText || s.sqlIdHigh !== undefined || stack || s.history.length > 0 || s.process || s.osId
  if (!any) return null
  return (
    <details className="bt-more" open={open} onToggle={(e) => { if (e.currentTarget.open !== open) onOpen(e.currentTarget.open) }}>
      <summary>Wait parameters, short stack and wait history</summary>
      <div className="bt-more-body">
        <dl className="rd-kv">
          {s.process || s.osId ? <><dt>Process</dt><dd>{s.processId !== undefined ? <>pid <span className="rd-mono">{s.processId}</span></> : null}{s.osId ? <> · OS pid <span className="rd-mono">{s.osId}</span></> : null}{s.process ? <> · <span className="rd-mono">{s.process}</span></> : null}</dd></> : null}
          {s.module ? <><dt>Module</dt><dd className="rd-mono" title="As the dump prints it: it joins the module with what follows it in its buffer">{s.module}</dd></> : null}
          {s.waiting && s.event ? (
            <>
              <dt>Wait</dt>
              <dd>
                <span className="rd-mono">&apos;{s.event}&apos;</span>
                {s.timeInWaitSec !== undefined ? <> · {secs(s.timeInWaitSec)} so far</> : null}
                {s.heurTimeInWaitSec !== undefined ? <span className="rd-dim"> · heuristic {secs(s.heurTimeInWaitSec)}</span> : null}
                {s.timeoutText ? <span className="rd-dim"> · timeout after {s.timeoutText}</span> : null}
                {s.waitId !== undefined ? <span className="rd-dim"> · wait id {s.waitId}</span> : null}
                {s.params.length > 0 ? <div className="rd-mono rd-dim rd-params">{s.params.map((p, i) => <div key={i}>{p}</div>)}</div> : null}
              </dd>
            </>
          ) : null}
          {s.sqlIdHigh !== undefined ? (
            <>
              <dt title={SQLID_HIGH_NOTE}>Statement id</dt>
              <dd title={SQLID_HIGH_NOTE}>
                {s.sqlIdHigh === 0 ? <span className="rd-dim">0: no statement</span> : <><span className="rd-mono">{s.sqlIdHigh}</span> <span className="rd-mono rd-dim">{hex32(s.sqlIdHigh)}</span></>}
                <span className="rd-dim"> · high half of the sql_id, not the sql_id itself</span>
              </dd>
            </>
          ) : null}
        </dl>
        {s.sqlText ? <><div className="rd-k">Statement <span className="rd-dim">(current sql{s.sqlCut ? ', cut by the reading' : ''})</span></div><pre className="rd-code">{s.sqlText}</pre></> : null}
        {stack ? (
          <>
            <div className="rd-k">Short stack <span className="rd-dim">(innermost first)</span></div>
            <CopyBlock text={stack} label={`The short stack of session ${s.key} as one line`}>
              {(s.shortStackOwn ?? 0) > 0 && <label className="rd-chk-l"><input type="checkbox" checked={incOwn} onChange={(e) => onOwn(e.target.checked)} /> include the frames of the handler that took it ({s.shortStackOwn})</label>}
            </CopyBlock>
          </>
        ) : null}
        {s.history.length > 0 ? (
          <>
            <div className="rd-k">Wait history <span className="rd-dim">(latest first) {s.historyLine ? link(s.historyLine) : null}</span></div>
            <ol className="rd-wh">
              {hist.map((h) => (
                <li key={h.line}>
                  <span className="num rd-dim">{h.n}</span>
                  <span className="rd-mono ev" title={h.params.join('\n')}>{h.event}</span>
                  <span className="num">{h.waitedSec !== undefined ? secs(h.waitedSec) : ''}</span>
                  <span className="bc">{h.waitedSec !== undefined && max > 0 ? <i style={{ inlineSize: `${Math.max(1, (100 * h.waitedSec) / max)}%` }} /> : null}</span>
                  <span className="num">{link(h.line, fmtInt(h.line))}</span>
                </li>
              ))}
            </ol>
            {s.historyTotal > hist.length && <p className="rd-note">and {fmtInt(s.historyTotal - hist.length)} older {s.historyTotal - hist.length === 1 ? 'entry' : 'entries'} the reading does not list.</p>}
          </>
        ) : null}
        <p className="rd-note">Session identified at line {link(s.line)}.</p>
      </div>
    </details>
  )
}

registerReading('hang', HangView)
