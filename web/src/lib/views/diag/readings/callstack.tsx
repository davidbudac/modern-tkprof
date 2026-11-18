// The call stack reading (`callstack`, on a diagnostic dump, an incident and its "Dump for incident" part): the facts of a dump read for the person who wants
// to know what it was doing and why it was written. The error, the statement, the PL/SQL stack, the stack as one copyable line, the frames with the dump's own
// ones folded into a row, the open and cached cursors with their binds, and the process state and heap dumps nested in it. Every fact links to its line.
// Layout A of docs/mockups/diag-reader/ (shots/errorstack-light.png). No interpretation of function names (docs/PLAN-DIAG.md).
import { Fragment, useMemo, type ReactNode } from 'react'
import { fmtInt } from '../../../data/format'
import { bindsMore, cursorGroups, frameRows, framesSourceText, offsetText, oneLine } from '../../../data/diagstack'
import { normalizeCallStack, type CallStack, type DumpCursor } from '../../../data/diagreadings'
import { TraceMark } from '../../../components/DumpMark'
import { CopyBlock, LineLink, useReadingUi } from './parts'
import { registerReading, type ReadingProps } from './registry'

type Link = (line: number, text?: ReactNode) => ReactNode

export interface CallStackUi {
  /** the stack as one line includes the dump's own frames */
  incOwn: boolean
  /** the row of the dump's own frames is open */
  ownOpen: boolean
  /** the cursors whose binds are shown ("<from line>") */
  open: string[]
  /** how many frames are listed (a stack of hundreds of frames is cut to start with) */
  frames: number
}
export const initCallStackUi = (): CallStackUi => ({ incOwn: false, ownOpen: false, open: [], frames: 120 })

const FRAME_STEP = 200

export function CallStackView({ node, reading, source, goLine, selectNode }: ReadingProps) {
  const r = useMemo(() => normalizeCallStack(reading), [reading])
  const [st, patch] = useReadingUi<CallStackUi>(source, node.id, initCallStackUi)
  const link: Link = (line, text) => <LineLink line={line} text={text} source={source} goLine={goLine} />
  const what = r.start.incident ? 'incident dump' : 'diagnostic dump'
  const one = oneLine(r, st.incOwn)
  const rows = useMemo(() => frameRows(r.frames, st.ownOpen), [r.frames, st.ownOpen])
  const cur = cursorGroups(r)
  const shown = rows.filter((x) => x.t === 'own' || x.frame.n <= st.frames)
  return (
    <div className="rd" data-reading="callstack">
      <header className="rd-head">
        <h3 className="rd-title">Call stack</h3>
        <span className="rd-meta">
          {what}{r.start.line > 0 ? <>, level {r.start.level} · {link(r.start.line, `line ${fmtInt(r.start.line)}`)}</> : null}
          {r.frames.length > 0 ? <> · {fmtInt(r.binaryFrames || r.tableFrames || r.frames.length)} frames</> : null}
          {' '}· lines {link(r.from)}–{link(r.to, fmtInt(r.to))}
        </span>
      </header>

      <ErrorPart r={r} link={link} />

      {r.statement && (
        <section className="rd-sec">
          <div className="rd-k">Statement <span className="rd-dim">(Current SQL Statement for this session)</span></div>
          <div className="rd-p"><span className="rd-mono rd-strong">{r.statement.sqlId}</span> {link(r.statement.title, `line ${fmtInt(r.statement.title)}`)} <TraceMark by={{ sqlId: r.statement.sqlId }} /></div>
          {r.statement.text && <pre className="rd-code">{r.statement.text}</pre>}
          {r.statement.truncated && <p className="rd-note">The statement is cut here; the text of the file has the rest{r.statement.from <= r.statement.to ? <> ({link(r.statement.from, `lines ${fmtInt(r.statement.from)}–${fmtInt(r.statement.to)}`)})</> : null}.</p>}
        </section>
      )}

      {r.plsql.length > 0 && (
        <section className="rd-sec">
          <div className="rd-k">PL/SQL call stack <span className="rd-dim">(innermost first)</span> {r.plsqlLine ? link(r.plsqlLine) : null}</div>
          <table className="rd-tbl rd-narrow">
            <thead><tr><th className="num">#</th><th>Object</th><th className="num">Line</th><th>Handle</th><th className="num">At</th></tr></thead>
            <tbody>
              {r.plsql.map((p) => (
                <tr key={p.at}>
                  <td className="num dim">{p.n}</td>
                  <td className="mono wrap">{p.object}</td>
                  <td className="num">{fmtInt(p.line)}</td>
                  <td className="mono dim">{p.handle}</td>
                  <td className="num">{link(p.at, fmtInt(p.at))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {r.shortStack !== '' && (
        <section className="rd-sec">
          <div className="rd-k">The stack as one line <span className="rd-dim">(the form oradebug short_stack prints)</span></div>
          <CopyBlock text={one.text} label="The stack as one line">
            {ownCount(r) > 0 && (
              <label className="rd-chk-l"><input type="checkbox" checked={st.incOwn} onChange={(e) => patch({ incOwn: e.target.checked })} /> include the dump&apos;s own frames</label>
            )}
            <span className="rd-dim">{fmtInt(one.frames)} {one.frames === 1 ? 'frame' : 'frames'}</span>
          </CopyBlock>
        </section>
      )}

      {r.frames.length > 0 && (
        <section className="rd-sec">
          <div className="rd-k">Frames <span className="rd-dim">(innermost first, {framesSourceText(r)}) {r.framesLine ? link(r.framesLine) : null}</span></div>
          <div className="rd-tblwrap">
            <table className="rd-tbl rd-frames">
              <thead><tr><th className="num">#</th><th>Function</th><th className="comp">Component</th><th className="num">Offset</th><th className="num">Line</th></tr></thead>
              <tbody>
                {shown.map((x) => x.t === 'own' ? (
                  <tr key="own" className="rd-ownrow">
                    <td />
                    <td colSpan={4}>
                      <button type="button" className="rd-foldrow" aria-expanded={x.open} onClick={() => patch({ ownOpen: !x.open })}>
                        <span className="rd-tw-i" aria-hidden="true">{x.open ? '▾' : '▸'}</span> <b>{fmtInt(x.count)}</b> {x.count === 1 ? 'frame' : 'frames'} of the dump itself <span className="rd-mono rd-dim">{x.count === 1 ? x.first : `${x.first} … ${x.last}`}</span>
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={x.frame.n} className={x.frame.own ? 'rd-own' : undefined}>
                    <td className="num dim">{x.frame.n}</td>
                    <td className="mono fn wrap">{x.frame.function}<span className="rd-dim">()</span>{x.frame.errorSignaled ? <span className="rd-tag" title="the dump marks this frame: ERROR SIGNALED: yes">error signaled</span> : null}</td>
                    <td className="comp dim">{x.frame.component ?? ''}</td>
                    <td className="num dim mono">{offsetText(x.frame)}</td>
                    <td className="num">{link(x.frame.line, fmtInt(x.frame.line))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.frames.length > st.frames && (
            <p className="rd-note"><button type="button" className="rd-more" onClick={() => patch({ frames: st.frames + FRAME_STEP })}>Show {fmtInt(Math.min(FRAME_STEP, r.frames.length - st.frames))} more frames</button> · {fmtInt(st.frames)} of {fmtInt(r.frames.length)} shown</p>
          )}
          {r.frames.length < Math.max(r.binaryFrames, r.tableFrames) && <p className="rd-note">The reading lists the first {fmtInt(r.frames.length)} of {fmtInt(Math.max(r.binaryFrames, r.tableFrames))} frames.</p>}
          {r.tableAgrees === false && <p className="rd-note">The Call Stack Trace table of the dump does not list the same frames as the binary stack dump; the frames above are the binary dump&apos;s.</p>}
        </section>
      )}

      {r.cursors.length > 0 && (
        <section className="rd-sec">
          <div className="rd-k">Cursors <span className="rd-dim">(the session&apos;s open and cached cursors, with the binds of each)</span></div>
          {cur.open.length > 0 && <CursorTable title="Open cursors" cursors={cur.open} st={st} patch={patch} link={link} />}
          {cur.cached.length > 0 && <CursorTable title="Cached cursors" cursors={cur.cached} st={st} patch={patch} link={link} />}
          {cur.more > 0 && <p className="rd-note">and {fmtInt(cur.more)} more {cur.more === 1 ? 'cursor' : 'cursors'} the reading does not list ({fmtInt(r.cursorsTotal)} in the dump).</p>}
        </section>
      )}

      {r.links.length > 0 && (
        <section className="rd-sec">
          <div className="rd-k">Dumps inside this one</div>
          <ul className="rd-links">
            {r.links.map((l) => (
              <li key={l.node}>
                <button type="button" className="rd-lnk rd-ui" title="Select it in the outline and show its reading" onClick={() => selectNode(l.node)}>{l.title}</button>
                <span className="rd-dim"> · {l.kind === 'procstate' ? 'process state' : l.kind === 'heap' ? 'heap dump' : l.kind} · lines {fmtInt(l.from)}–{fmtInt(l.to)} ({fmtInt(l.to - l.from + 1)})</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.notes.length > 0 && <section className="rd-sec">{r.notes.map((n, i) => <p key={i} className="rd-note">{n}</p>)}</section>}
    </div>
  )
}

const ownCount = (r: CallStack) => r.frames.filter((f) => f.own).length

/** The dump's error: the ORA- lines, the signal an event-written dump ends with, an incident's problem key; the plain sentence when it names none; the barriers quietly. */
function ErrorPart({ r, link }: { r: CallStack; link: Link }) {
  const e = r.error
  const named = !!e && (e.lines.length > 0 || !!e.signal || !!e.incident)
  return (
    <section className="rd-sec">
      <div className="rd-k">Error</div>
      {named ? (
        <div className="rd-p rd-err-l">
          {e!.lines.map((l) => <div key={l.line} className="rd-mono">{l.text} {link(l.line)}</div>)}
          {e!.signal && (
            <div>about to signal <span className="rd-mono rd-strong">{e!.signal.ora}</span>{e!.signal.name ? <>, name <span className="rd-mono">{e!.signal.name}</span></> : null} {link(e!.signal.line)}</div>
          )}
          {e!.incident && (
            <div>Incident <span className="rd-mono">{e!.incident.id}</span>, problem key <span className="rd-mono rd-strong">{e!.incident.problem}</span>{e!.incident.line > 0 ? <> {link(e!.incident.line)}</> : null}</div>
          )}
        </div>
      ) : (
        <p className="rd-p rd-dim">The dump names no error: it has no ORA- line and no &quot;about to signal&quot; line. It was taken on request{r.start.line > 0 ? ` (level ${r.start.level})` : ''}, not on an error.</p>
      )}
      {r.barriers.map((b) => <div key={b.line} className="rd-note rd-mono" title="the error stack's own barrier line">{b.text} {link(b.line)}</div>)}
    </section>
  )
}

function CursorTable({ title, cursors, st, patch, link }: { title: string; cursors: readonly DumpCursor[]; st: CallStackUi; patch(p: Partial<CallStackUi>): void; link: Link }) {
  const toggle = (c: DumpCursor) => patch({ open: st.open.includes(String(c.from)) ? st.open.filter((x) => x !== String(c.from)) : [...st.open, String(c.from)] })
  return (
    <div className="rd-blk">
      <div className="rd-blk-h"><b>{title}</b> <span className="rd-dim">{fmtInt(cursors.length)}</span></div>
      <div className="rd-tblwrap">
        <table className="rd-tbl rd-cursors">
          <thead><tr><th /><th>sql_id</th><th className="st">State</th><th>Statement</th><th className="num">Binds</th><th className="num">Line</th></tr></thead>
          <tbody>
            {cursors.map((c) => {
              const open = st.open.includes(String(c.from))
              const can = c.binds.length > 0
              return (
                <Fragment key={c.from}>
                  <tr className={open ? 'rd-open' : undefined}>
                    <td className="tw">{can
                      ? <button type="button" className="rd-tw" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the binds of ${c.sqlId}`} onClick={() => toggle(c)}>{open ? '▾' : '▸'}</button>
                      : <span className="rd-tw none" aria-hidden="true" />}</td>
                    <td className="mono nw">{c.sqlId}{c.number ? <span className="rd-dim"> #{c.number}</span> : null} <TraceMark by={{ sqlId: c.sqlId }} /></td>
                    <td className="st dim">{c.state ?? ''}</td>
                    <td className="mono wrap">{c.statement ?? ''}</td>
                    <td className="num">{c.bindCount > 0 ? fmtInt(c.bindCount) : <span className="rd-dim">0</span>}</td>
                    <td className="num">{link(c.from, fmtInt(c.from))}</td>
                  </tr>
                  {open && can && (
                    <tr className="rd-sub">
                      <td />
                      <td colSpan={5}>
                        <table className="rd-tbl rd-binds">
                          <thead><tr><th className="num">Bind</th><th>Type</th><th>Value <span className="rd-dim">(as printed)</span></th><th className="num">Line</th></tr></thead>
                          <tbody>
                            {c.binds.map((b) => (
                              <tr key={b.pos}>
                                <td className="num dim">#{b.pos}</td>
                                <td className="mono dim">{b.type ?? `DTY${b.dty}`}{b.avl !== undefined ? <span className="rd-dim"> · avl {b.avl}</span> : null}</td>
                                <td className="mono wrap">{b.value !== undefined ? b.value : <span className="rd-dim">{b.noDef ? 'no definition' : 'not printed'}</span>}</td>
                                <td className="num">{b.line ? link(b.line, fmtInt(b.line)) : null}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {bindsMore(c) > 0 && <p className="rd-note">and {fmtInt(bindsMore(c))} more {bindsMore(c) === 1 ? 'bind' : 'binds'}; {link(c.from, 'the cursor in the text')}.</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

registerReading('callstack', CallStackView)
