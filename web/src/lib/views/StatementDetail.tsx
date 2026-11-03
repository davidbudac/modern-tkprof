import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TraceDoc } from '../data/doc'
import type { ID, StmtStats, CallStats, Plan } from '../data/types'
import { fmtDur, fmtInt, fmtPct, fmtWall, fmtCompact, oraErr } from '../data/format'
import { useStore, useActions } from '../state/session'
import { SqlText } from '../components/SqlText'
import { ProfileBar } from '../components/ProfileBar'
import { DataTable, type Column } from '../components/DataTable'
import { bindsOf, previewOfBinds, type Execution } from '../data/derive'
import { sourceOf, useSourceQuery } from '../data/source'
import type { Segment } from '../components/ProfileBar'
import { LineRef } from '../components/LineRef'
import { ColumnChooser } from '../components/ColumnChooser'
import { usePersisted } from '../state/persist'
import { scopeKey, useScope } from '../data/scopedstmts'
import { responseBaseUs, responseShare, responseUs, shareNote } from '../data/response'
import type { Scope } from '../state/store'
import { ExecCompare } from './ExecCompare'
import { Dialogue } from './Dialogue'
import { planFindings, type Finding as PlanFinding } from '../data/advisor'
import { NoteEditor, NoteBox } from '../components/Note'
import { stmtRef, stmtNote, execNotes, execKey, makeAnnotation, type StmtRef } from '../data/annotations'
import { planRows, planVizUrl, planVizOverride, setPlanVizOverride, canGzip, DEFAULT_PLAN_VIZ, MAX_LINK_CHARS } from '../data/planviz'
import { StatementContext, StatementFindings, StatementLinesMenu } from './StatementContext'
import { MenuItem, ToolbarMenu } from '../components/ToolbarMenu'
import { kindGroups, type KindGroup } from '../data/callkinds'
import { CheckIcon, CopyIcon } from '../components/icons'
import { RowFlow } from './RowFlow'
import { NO_STATS_NOTE, type FlowScale } from '../data/rowflow'
import { isBlockIO } from '../data/iomap'
import { Shimmer } from '../components/motion'

/** A request from the statement's view buttons: show the plan as a Row flow, or the slowest execution's Dialogue (`seq` repeats a click). */
type Jump = { to: 'flow' | 'dialogue'; seq: number }

/** Scroll `el` into view once `seq` changes to a non-zero value (the jump that asked for it), and again while what it
 *  shows loads and grows (a Dialogue, a flow), for a second at most: the first scroll stops short when the page is still too short. */
function useScrollOn(seq: number, el: { current: HTMLElement | null }) {
  useEffect(() => {
    const node = el.current
    if (!seq || !node) return
    const go = () => node.scrollIntoView({ block: 'start', behavior: 'smooth' })
    go()
    const ro = new ResizeObserver(go)
    ro.observe(node)
    const stop = setTimeout(() => ro.disconnect(), 1000)
    return () => { clearTimeout(stop); ro.disconnect() }
  }, [seq, el])
}

/** What the lists below are asked for when the statistics are the whole trace's (no scope, or an engine that cannot answer for one). */
const WHOLE: Scope = { window: null, files: null, contexts: null, includeIdle: true }

/** `stats` are the numbers to show (the scope's when `narrowed`, else the document's); the waits, executions and plans below follow them. */
export function StatementDetail({ doc, id, stats: scoped, narrowed = false }: { doc: TraceDoc; id: ID; stats?: StmtStats; narrowed?: boolean }) {
  const st = doc.statements[id]
  const stats = scoped ?? doc.stats.statements[id]
  if (!st || !stats) return <p className="muted">Unknown statement</p>
  const planHashes = stats.planHashes ?? []
  const stateScope = useScope(doc)
  const scope = narrowed ? stateScope : WHOLE
  const [copied, setCopied] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  useEffect(() => setNoteOpen(false), [id])
  const notesOn = useStore((s) => s.annotationsEnabled)
  const ref = useMemo(() => stmtRef(st), [st])
  const note = stmtNote(useStore((s) => s.annotations), ref)
  const actions = useActions()
  const [jump, setJump] = useState<Jump | null>(null)
  useEffect(() => setJump(null), [id])
  const go = (to: Jump['to']) => setJump((j) => ({ to, seq: (j?.seq ?? 0) + 1 }))
  const plansHere = doc.plansOf(id)
  const flowOk = plansHere.some((p) => doc.planLines.slice(p.first, p.first + p.n).some((l) => l.hasStats))
  const anyBlockIO = useMemo(() => doc.events.some(isBlockIO), [doc])
  const ready = sourceOf(doc).ready
  const copy = async () => {
    try { await navigator.clipboard.writeText(st.text); setCopied(true); setTimeout(() => setCopied(false), 1200) } catch { /* clipboard unavailable */ }
  }
  const facts: ReactNode[] = [
    st.kind === 0 ? st.commandName || 'SQL' : kindName(st.kind),
    <span key="d" className="mono">depth {stats.minDepth}{stats.maxDepth !== stats.minDepth ? `–${stats.maxDepth}` : ''}</span>,
    ...planHashes.map((h) => <span key={'p' + h} className="mono">plan {h}</span>),
    ...(st.kind === 0 ? [<span key="hv" className="mono" title="hash value">hv {st.hashValue}</span>] : []),
    ...(note ? [<span key="n" className="note-chip" title={note.note}>✎ note</span>] : []),
  ]
  return (
    <>
      <div className="title"><h1 className="mono">{doc.label(st)}</h1></div>
      <p className="stmt-facts dim" aria-label="Statement facts">
        {facts.map((f, i) => <Fragment key={i}>{i > 0 && ' · '}{f}</Fragment>)}
      </p>
      <div className="stmt-acts" role="group" aria-label="Statement actions">
        {notesOn && !note && !noteOpen && <button onClick={() => setNoteOpen(true)} title="a note on this statement, kept with the trace">✎ Add note</button>}
        <button className="icon-btn" onClick={copy} aria-label={copied ? 'Copied' : 'Copy SQL'} title={copied ? 'Copied' : 'Copy SQL'}>{copied ? <CheckIcon /> : <CopyIcon />}</button>
        <StatementLinesMenu doc={doc} id={id} narrowed={narrowed} />
        <span className="stmt-views" role="group" aria-label="Show this statement as">
          {plansHere.length > 0 && (
            <button onClick={() => go('flow')} disabled={!flowOk}
              title={flowOk ? 'Row flow: the rows moving through the plan, leaves to the client' : 'Row flow needs row-source statistics (STAT lines with rows), which this plan has none of'}>
              <FlowIcon /> Row flow</button>
          )}
          {ready && stats.exec.count > 0 && (
            <button onClick={() => go('dialogue')} title="Dialogue: the slowest execution as a sequence diagram between the client, the server and what it waited on">
              <DialogueIcon /> Dialogue</button>
          )}
          {ready && anyBlockIO && stats.waitUs > 0 && (
            <button onClick={() => actions.showBlocks({ stmt: id })} title="Blocks: the file blocks this statement read and wrote (opens the Blocks view, filtered to it)">
              <BlocksIcon /> Blocks</button>
          )}
        </span>
      </div>
      <StmtNote stmt={ref} open={noteOpen} setOpen={setNoteOpen} title={doc.label(st)} />
      <SqlText text={st.text} />
      {narrowed && stats.allCalls.count === 0 && <p className="callout">No calls of this statement in the selection.</p>}
      <ResponseTime doc={doc} stats={stats} narrowed={narrowed} scope={scope} />
      <StatementContext doc={doc} id={id} stats={stats} narrowed={narrowed} />
      <Plans doc={doc} id={id} inScope={narrowed ? stats.plans ?? [] : null} jump={jump?.to === 'flow' ? jump.seq : 0} />
      {st.refPlan && (
        <section className="section">
          <details>
            <summary><b>DBMS_XPLAN from ref bundle</b> <span className="hint">plans/{st.sqlId}.txt</span></summary>
            <pre className="mono small" style={{ overflowX: 'auto' }}>{st.refPlan}</pre>
          </details>
        </section>
      )}
      <StatementFindings doc={doc} id={id} narrowed={narrowed} />
      <CallTable stats={stats} />
      {ready && <Executions key={id} doc={doc} id={id} scope={scope} jump={jump?.to === 'dialogue' ? jump.seq : 0} />}
      <Errors doc={doc} id={id} />
    </>
  )
}

/** The statement's note (or its editor). */
function StmtNote({ stmt, open, setOpen, title }: { stmt: StmtRef; open: boolean; setOpen(o: boolean): void; title: string }) {
  const actions = useActions()
  const notesOn = useStore((s) => s.annotationsEnabled)
  const note = stmtNote(useStore((s) => s.annotations), stmt)
  if (open) {
    return (
      <NoteEditor label={`Note on statement ${title}`} text={note?.note}
        onSave={(t) => { if (note) actions.updateAnnotation(note.id, { note: t }); else actions.addAnnotation(makeAnnotation({ kind: 'statement', note: t, stmt })); setOpen(false) }}
        onCancel={() => setOpen(false)}
        onDelete={note ? () => { actions.removeAnnotation(note.id); setOpen(false) } : undefined} />
    )
  }
  return note ? <NoteBox text={note.note} when={note.updated} onEdit={notesOn ? () => setOpen(true) : undefined} /> : null
}

function kindName(k: number): string { return ['SQL', 'unknown statement', 'commit', 'rollback', 'LOB operation', 'RPC call', 'parse error'][k] ?? '?' }

/** The response time and its share of the scope's response time: `response.ts` has the one definition the Overview ledger shares. */
function ResponseTime({ doc, stats, narrowed, scope }: { doc: TraceDoc; stats: StmtStats; narrowed: boolean; scope: Scope }) {
  const total = responseUs(stats)
  const base = responseBaseUs(doc, scope, narrowed)
  const source = sourceOf(doc)
  const waitsQ = useSourceQuery(source, `waits:${stats.id}:${scopeKey(scope)}`, (signal) => (source.ready ? source.stmtWaits([stats.id], 4, scope, signal) : null), 'waits')
  const waits = useMemo(() => waitsQ.data?.get(stats.id) ?? [], [waitsQ.data, stats.id])
  const segs = useMemo<Segment[]>(() => {
    const out: Segment[] = [{ role: 'cpu', label: 'CPU', us: stats.cpu }]
    let shown = 0
    for (const w of waits) { out.push({ role: w.role, label: w.name, us: w.us, count: w.count }); shown += w.us }
    const rest = stats.waitUs + stats.idleUs - shown
    if (rest > 0) out.push({ role: 'other', label: 'other waits', us: rest })
    return out
  }, [stats, waits])
  const top = waits[0]
  const trips = waits.find((w) => /message from client/.test(w.name))
  const notes: string[] = []
  if (top && top.role !== 'idle') notes.push(`${fmtInt(top.count)} × ${top.name}, avg ${fmtDur(top.us / top.count)}, max ${fmtDur(top.maxUs)}${top.obj > 0 && (top.role === 'userio' || top.role === 'sysio') ? `, all on obj# ${top.obj}${doc.objectName(top.obj) ? ` (${doc.objectName(top.obj)})` : ''}` : ''}`)
  if (trips) notes.push(`${fmtInt(trips.count)} round trip${trips.count === 1 ? '' : 's'}, ${fmtDur(trips.us)} idle`)
  if (stats.pxSessions) notes.push(`PX slaves: ${stats.pxSessions} session${stats.pxSessions === 1 ? '' : 's'}, ${fmtDur(stats.pxEla ?? 0)} (not included)`)
  if (stats.childUs > 0) notes.push(`recursive ${fmtDur(stats.childUs)} (${fmtPct(stats.childUs, stats.elapsed)})`)
  return (
    <section className="section">
      <header><h2>Response time {fmtDur(total)}</h2><span className="hint"><span title={shareNote(responseShare(stats, base))}>{fmtPct(total, base)} of {narrowed ? 'selection' : 'trace'}</span> · calls {fmtDur(stats.elapsed)} + idle {fmtDur(stats.idleUs)}</span></header>
      {source.ready && waitsQ.data ? <ProfileBar segments={segs} totalUs={total} /> : <ProfileBar segments={[{ role: 'cpu', label: 'CPU', us: stats.cpu }, { role: 'other', label: 'Waits', us: stats.waitUs }, { role: 'idle', label: 'Idle', us: stats.idleUs }]} totalUs={total} />}
      {notes.length > 0 && <p className="small muted">{notes.join(' · ')}</p>}
    </section>
  )
}

function CallTable({ stats }: { stats: StmtStats }) {
  const actions = useActions()
  const inclusive = useStore((s) => s.inclusive)
  const callTypes = useStore((s) => s.statementCallTypes)
  const [callsOpen, setCallsOpen] = useState(false)
  const calls: { kind: KindGroup | 'total'; name: string; c: CallStats; res: boolean }[] = [
    { kind: 'parse', name: 'Parse', c: stats.parse, res: true },
    { kind: 'exec', name: 'Execute', c: stats.exec, res: true },
    { kind: 'fetch', name: 'Fetch', c: stats.fetch, res: true },
    { kind: 'close', name: 'Close', c: stats.close, res: false },
    { kind: 'other', name: 'Other', c: stats.other, res: true },
    { kind: 'total', name: 'Total', c: stats.total, res: true },
  ]
  // Selected kinds show their own counters, including zeros when they have no calls.
  // The all-call total belongs only to the unfiltered view.
  const rows = calls.filter((r) => callTypes ? r.kind !== 'total' && callTypes.has(r.kind) : r.c.count > 0 || r.kind === 'total')
  const v = (c: CallStats, inc: keyof CallStats, self: keyof CallStats) => (inclusive ? c[inc] : c[self]) as number
  return (
    <section className="section">
      <header><h2>Database calls</h2>
        <span className="hint" aria-live="polite">{callTypes ? kindGroups.filter((k) => callTypes.has(k.id)).map((k) => k.label).join(', ') : 'All calls'}</span>
        <span className="tools">
          <ToolbarMenu label="Calls" badge={callTypes ? String(callTypes.size) : undefined} title="which call types the table shows" className="tbmenu-sm" open={callsOpen} onOpenChange={setCallsOpen}>
            <div className="tb-items" role="group" aria-label="Filter database call types">
              <MenuItem on={callTypes === null} onClick={() => actions.setStatementCallTypes(null)}>All calls</MenuItem>
              <div className="tb-sep" role="separator" />
              {kindGroups.map((k) => (
                <MenuItem key={k.id} on={callTypes?.has(k.id) ?? false} onClick={() => actions.toggleStatementCallType(k.id)}>{k.label}</MenuItem>
              ))}
            </div>
          </ToolbarMenu>
          <span className="seg" role="group" aria-label="Statistics mode">
          <button aria-pressed={!inclusive} onClick={() => actions.setInclusive(false)} title="exclude recursive children, like tkprof">self</button>
          <button aria-pressed={inclusive} onClick={() => actions.setInclusive(true)} title="include recursive children">inclusive</button>
        </span></span></header>
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th>call</th><th className="num">count</th><th className="num">misses</th><th className="num">cpu</th><th className="num">elapsed</th><th className="num">disk</th><th className="num">query</th><th className="num">current</th><th className="num">rows</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} style={r.name === 'Total' ? { fontWeight: 600 } : undefined}>
              <td>{r.name}</td>
              <td className="num">{fmtInt(r.c.count)}</td>
              <td className="num">{r.res ? fmtInt(r.c.misses) : ''}</td>
              <td className="num">{fmtDur(v(r.c, 'cpu', 'selfCpu'))}</td>
              <td className="num">{fmtDur(v(r.c, 'elapsed', 'selfElapsed'))}</td>
              <td className="num">{r.res ? fmtInt(v(r.c, 'disk', 'selfDisk')) : ''}</td>
              <td className="num">{r.res ? fmtInt(v(r.c, 'query', 'selfQuery')) : ''}</td>
              <td className="num">{r.res ? fmtInt(v(r.c, 'current', 'selfCurrent')) : ''}</td>
              <td className="num">{r.res ? fmtInt(r.c.rows) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  )
}

/** `jump`: a new value opens the slowest execution's Dialogue and scrolls to it. A statement of one execution opens it. */
function Executions({ doc, id, scope, jump }: { doc: TraceDoc; id: ID; scope: Scope; jump: number }) {
  const actions = useActions()
  const source = sourceOf(doc)
  const page = useSourceQuery(source, `executions:${id}:${scopeKey(scope)}`, (signal) => source.executions(id, scope, signal), 'executions')
  const exs = useMemo(() => page.data?.rows ?? [], [page.data])
  const [hidden, setHidden] = usePersisted<string[]>('mtkprof.cols.executions', [])
  const wanted = useStore((s) => s.selection.exec)
  const [sel, setSel] = useState<Execution | null>(null)
  const [picked, setPicked] = useState<string[]>([]) // up to two execution keys: A (older pick) and B
  const notesOn = useStore((s) => s.annotationsEnabled)
  const ref = useMemo(() => stmtRef(doc.statements[id]), [doc, id])
  const notes = execNotes(useStore((s) => s.annotations), ref)
  const [noteFor, setNoteFor] = useState<Execution | null>(null)
  // another document (the other side of a comparison): drop the open and picked executions; before the `wanted`
  // effect, so an execution named by a link still opens. Another statement remounts this (key = id), so no render
  // pairs the new statement with the previous one's execution (its Binds or Dialogue would query that pair).
  useEffect(() => { setNoteFor(null); setSel(null); setPicked([]) }, [id, doc])
  useEffect(() => { if (wanted) { const e = exs.find((x) => x.cursor === wanted.cursor && x.execNo === wanted.execNo); if (e) setSel(e) } }, [wanted, exs])
  // one execution: nothing to choose, so its detail is open (its Binds | Dialogue switch in sight)
  useEffect(() => { if (exs.length === 1 && !wanted) setSel(exs[0]) }, [exs, wanted])
  const [mode, setMode] = usePersisted<'binds' | 'dialogue'>('mtkprof.exec.detail', 'binds')
  const slowestEx = useMemo(() => exs.reduce<Execution | null>((m, e) => (!m || e.e > m.e ? e : m), null), [exs])
  const detailRef = useRef<HTMLDivElement>(null)
  const [scrollSeq, setScrollSeq] = useState(0)
  useScrollOn(scrollSeq, detailRef)
  const openSlowest = (dialogue: boolean) => {
    if (!slowestEx) return
    setPicked([]); setSel(slowestEx)
    if (dialogue) setMode('dialogue')
    setScrollSeq((n) => n + 1)
  }
  const done = useRef(0) // the last jump handled: one arriving before the page loaded is handled once it has
  useEffect(() => { if (jump && jump !== done.current && slowestEx) { done.current = jump; openSlowest(true) } }) // eslint-disable-line react-hooks/exhaustive-deps
  if (!page.data) {
    return page.error ? <section className="section"><header><h2>Executions</h2></header><p className="callout">{page.error}</p></section>
      : page.loading ? <section className="section"><header><h2>Executions</h2><span className="hint"><Shimmer>loading…</Shimmer></span></header></section> : null
  }
  if (exs.length === 0) return null
  const bindsFor = (e: Execution) => e.binds ?? bindsOf(doc, e.bindSet)
  const keyOf = (e: Execution) => `${e.cursor}:${e.execNo}`
  const togglePick = (e: Execution) => setPicked((p) => (p.includes(keyOf(e)) ? p.filter((k) => k !== keyOf(e)) : [...p.slice(-1), keyOf(e)]))
  const pa = exs.find((e) => keyOf(e) === picked[0]), pb = exs.find((e) => keyOf(e) === picked[1])
  const pickCol: Column<Execution> = {
    key: 'pick', header: '', className: 'pick', title: 'tick two executions to compare them (or shift-click rows)',
    render: (e) => <input type="checkbox" checked={picked.includes(keyOf(e))} aria-label={`Compare execution #${e.execNo}`} onClick={(ev) => ev.stopPropagation()} onChange={() => togglePick(e)} />,
  }
  const all: Column<Execution>[] = [
    { key: 'n', header: '#', align: 'end', render: (e) => e.execNo, sort: (e) => e.execNo },
    { key: 't', header: 'Start', render: (e) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(e.startTim), doc.tzOffsetMin) : `+${fmtDur(e.startTim - doc.span.firstTim)}`), sort: (e) => e.startTim },
    { key: 'e', header: 'Elapsed', align: 'end', render: (e) => fmtDur(e.e), sort: (e) => e.e, bar: true },
    { key: 'c', header: 'CPU', align: 'end', render: (e) => fmtDur(e.c), sort: (e) => e.c },
    { key: 'w', header: 'Waits', align: 'end', render: (e) => fmtDur(e.waitEla), sort: (e) => e.waitEla },
    { key: 'r', header: 'Rows', align: 'end', render: (e) => fmtCompact(e.r), sort: (e) => e.r },
    { key: 'p', header: 'Disk', align: 'end', render: (e) => fmtCompact(e.p), sort: (e) => e.p },
    { key: 'cr', header: 'Query', align: 'end', render: (e) => fmtCompact(e.cr), sort: (e) => e.cr },
    { key: 'f', header: 'Fetches', align: 'end', render: (e) => e.fetches, sort: (e) => e.fetches },
    { key: 'b', header: 'Binds', className: 'clip mono', render: (e) => previewOfBinds(bindsFor(e)), sort: (e) => previewOfBinds(bindsFor(e)) },
    { key: 'l', header: 'Line', align: 'end', title: 'trace line of the EXEC call', render: (e) => <LineRef line={e.line} file={e.ctx !== undefined ? doc.fileOfCtx(e.ctx) : doc.fileOfCursor(e.cursor)} bare />, sort: (e) => e.line },
  ]
  const noteCol: Column<Execution> = {
    key: 'note', header: '', className: 'pick', title: 'notes on executions',
    render: (e) => {
      const n = notes.get(execKey(doc.cursors[e.cursor]?.line, e.execNo))
      if (!n && !notesOn) return null
      return <button className={'quiet note-btn' + (n ? ' on' : '')} title={n ? n.note : 'add a note on this execution'} aria-label={`${n ? 'Edit the note' : 'Add a note'} on execution #${e.execNo}`}
        onClick={(ev) => { ev.stopPropagation(); setNoteFor(noteFor && keyOf(noteFor) === keyOf(e) ? null : e) }}>✎</button>
    },
  }
  const cols = [pickCol, ...(notesOn || notes.size ? [noteCol] : []), ...all.filter((c) => c.key === 'n' || !hidden.includes(c.key))]
  const editing = noteFor ? notes.get(execKey(doc.cursors[noteFor.cursor]?.line, noteFor.execNo)) : undefined
  const { total, avgE: avg, slowest: slow } = page.data
  return (
    <section className="section">
      <header><h2>Executions</h2><span className="hint">{page.data.partial ? `${exs.length} slowest of ${total}` : total} · avg {fmtDur(avg)} · max {fmtDur(slow?.e ?? 0)}{' '}
        {exs.length > 1 && slowestEx ? <button className="link" onClick={() => openSlowest(false)} title="open the slowest execution">(#{slow?.execNo})</button> : `(#${slow?.execNo})`}
        {exs.length > 1 && ' · click a row for its binds and Dialogue · tick two to compare'}</span>
        <span className="tools"><ColumnChooser all={all.filter((c) => c.key !== 'n').map((c) => ({ key: c.key, label: c.header }))} hidden={hidden} onChange={setHidden} /></span></header>
      <DataTable columns={cols} rows={exs} rowKey={(e) => `${e.cursor}:${e.execNo}`} maxHeight="22rem" rowHeight={28}
        selectedKey={sel ? `${sel.cursor}:${sel.execNo}` : null} onRowClick={(e, ev) => (ev?.shiftKey ? togglePick(e) : setSel(sel && sel.exec === e.exec ? null : e))} />
      {noteFor && (notesOn ? (
        <NoteEditor key={keyOf(noteFor)} label={`Note on execution #${noteFor.execNo}`} title={`Note on execution #${noteFor.execNo}`} text={editing?.note}
          onSave={(t) => {
            if (editing) actions.updateAnnotation(editing.id, { note: t })
            else actions.addAnnotation(makeAnnotation({ kind: 'execution', note: t, stmt: ref, execNo: noteFor.execNo, cursorLine: doc.cursors[noteFor.cursor]?.line }))
            setNoteFor(null)
          }}
          onCancel={() => setNoteFor(null)}
          onDelete={editing ? () => { actions.removeAnnotation(editing.id); setNoteFor(null) } : undefined} />
      ) : editing && <NoteBox text={editing.note} when={editing.updated} />)}
      <div ref={detailRef} className="exec-detail">
        {pa && pb ? <ExecCompare doc={doc} stmt={id} a={pa} b={pb} onClear={() => setPicked([])} /> : sel && <Binds doc={doc} stmt={id} ex={sel} mode={mode} setMode={setMode} />}
      </div>
    </section>
  )
}

/** One picked execution: its binds, or its Dialogue (the sequence diagram of its calls and waits). */
function Binds({ doc, stmt, ex, mode, setMode }: { doc: TraceDoc; stmt: ID; ex: Execution; mode: 'binds' | 'dialogue'; setMode(m: 'binds' | 'dialogue'): void }) {
  const source = sourceOf(doc)
  const detail = useSourceQuery(source, `detail:${stmt}:${ex.cursor}:${ex.execNo}`, (signal) => source.executionDetail(stmt, ex, signal), 'detail')
  const d = detail.data
  const binds = d?.binds ?? []
  const file = ex.ctx !== undefined ? doc.fileOfCtx(ex.ctx) : doc.fileOfCursor(ex.cursor)
  return (
    <div className="section">
      <header><h3>Execution #{ex.execNo}</h3><span className="hint">cursor at <LineRef line={doc.cursors[ex.cursor]?.line ?? 0} file={file} /> · EXEC at <LineRef line={ex.line} file={file} />{d && d.bindLine > 0 && <> · binds at <LineRef line={d.bindLine} file={file} /></>}{d ? ` · ${d.execWaits} waits on the EXEC` : detail.loading ? ' · loading…' : ''}</span>
        <span className="tools">
          <span className="seg" role="group" aria-label="Execution detail">
            <button type="button" aria-pressed={mode === 'binds'} onClick={() => setMode('binds')}>Binds</button>
            <button type="button" aria-pressed={mode === 'dialogue'} onClick={() => setMode('dialogue')} title="Dialogue: the execution as a sequence diagram between the client, the server and what it waited on">Dialogue</button>
          </span>
        </span></header>
      {mode === 'dialogue' ? <Dialogue doc={doc} stmt={stmt} exec={ex} /> : detail.error ? <p className="callout">{detail.error}</p> : !d ? null : binds.length === 0 ? <p className="small muted">No binds captured.</p> : (
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th className="num">pos</th><th>type</th><th>value</th></tr></thead>
          <tbody>{binds.map((b) => (
            <tr key={b.pos}><td className="num">{b.pos}</td><td className="dim">{b.type}{b.mal > 0 ? `[${b.mal}]` : ''}</td>
              <td className="mono text" title={b.typed}>{b.noDef ? <span className="dim">dup</span> : b.isNull ? <span className="dim">NULL</span> : b.dump ? <span className="dim" title={b.value}>memory dump</span> : b.value}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  )
}

/** `inScope`: the plan dumps of cursors in scope (`StmtStats.plans`); null = all of them. */
function Plans({ doc, id, inScope, jump }: { doc: TraceDoc; id: ID; inScope: ID[] | null; jump: number }) {
  // Table | Flow and the flow's band scale: one choice for every plan section, kept across statements and sessions
  const [view, setView] = usePersisted<PlanView>('mtkprof.plan.view', 'table')
  const [flowScale, setFlowScale] = usePersisted<FlowScale>('mtkprof.plan.flowScale', 'sqrt')
  const plans = useMemo(() => {
    const all = doc.plansOf(id)
    if (!inScope) return all
    const keep = new Set(inScope)
    return all.filter((p) => keep.has(p.id))
  }, [doc, id, inScope])
  useEffect(() => { if (jump) setView('flow') }, [jump]) // eslint-disable-line react-hooks/exhaustive-deps
  if (plans.length === 0) return null
  const byHash = new Map<number, Plan[]>()
  for (const p of plans) { const l = byHash.get(p.planHash); if (l) l.push(p); else byHash.set(p.planHash, [p]) }
  return <>{[...byHash.entries()].map(([h, dumps], i) => <PlanSection key={`${id}:${h}`} doc={doc} hash={h} dumps={dumps} view={view} onView={setView} flowScale={flowScale} onFlowScale={setFlowScale} scrollSeq={i === 0 ? jump : 0} />)}</>
}

type PlanView = 'table' | 'flow'

type Link = { state: 'pending' } | { state: 'ok'; url: string } | { state: 'big' } | { state: 'nogzip' }

function PlanSection({ doc, hash, dumps, view, onView, flowScale, onFlowScale, scrollSeq }: {
  doc: TraceDoc; hash: number; dumps: Plan[]; view: PlanView; onView(v: PlanView): void; flowScale: FlowScale; onFlowScale(s: FlowScale): void; scrollSeq: number
}) {
  const secRef = useRef<HTMLElement>(null)
  useScrollOn(scrollSeq, secRef)
  const [pick, setPick] = useState(dumps.length - 1) // latest by default
  const plan = dumps[Math.min(pick, dumps.length - 1)]
  const lines = useMemo(() => doc.planLines.slice(plan.first, plan.first + plan.n), [doc, plan])
  const hasStats = useMemo(() => lines.some((l) => l.hasStats), [lines])
  const [override, setOverride] = useState(planVizOverride)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const base = override || doc.planViz || DEFAULT_PLAN_VIZ
  const rows = useMemo(() => planRows(doc, plan), [doc, plan])
  const findings = useMemo(() => planFindings(rows), [rows])
  const [focus, setFocus] = useState<{ id: number; seq: number } | null>(null)
  useEffect(() => setFocus(null), [plan])
  const [link, setLink] = useState<Link>({ state: 'pending' })
  useEffect(() => {
    let live = true
    if (!canGzip) { setLink({ state: 'nogzip' }); return }
    setLink({ state: 'pending' })
    planVizUrl(base, rows).then(
      (url) => { if (live) setLink(url.length > MAX_LINK_CHARS ? { state: 'big' } : { state: 'ok', url }) },
      () => { if (live) setLink({ state: 'nogzip' }) },
    )
    return () => { live = false }
  }, [base, rows])
  const copyJson = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(rows, null, 1)); setCopied(true); setTimeout(() => setCopied(false), 1200) } catch { /* clipboard unavailable */ }
  }
  const save = (v: string) => { setPlanVizOverride(v); setOverride(planVizOverride()); setEditing(false) }
  return (
    <section className="section" ref={secRef}>
      <header>
        <h2>Plan {hash || ''}</h2>
        <span className="hint">STAT at <LineRef line={plan.line} file={doc.fileOfCursor(plan.cursor)} />{dumps.length > 1 ? ` · ${dumps.length} dumps` : ''}</span>
        {plan.xPlanMatched && <span className="hint">predicates, estimates: ref bundle</span>}
        <span className="tools plan-acts">
          <span className="seg" role="group" aria-label="Plan view">
            <button aria-pressed={view === 'table'} onClick={() => onView('table')} title="the plan lines as a table">Table</button>
            <button aria-pressed={view === 'flow'} onClick={() => onView('flow')}
              title={hasStats ? 'the rows flowing through the plan, leaves to the client (Sankey)' : 'no row-source statistics in this dump: the table stays, with a note'}>Row flow</button>
          </span>
          {dumps.length > 1 && (
            <label className="small muted">dump:{' '}
              <select value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="Plan dump">
                {dumps.map((d, i) => <option key={d.id} value={i}>{i === dumps.length - 1 ? `latest (line ${fmtInt(d.line)})` : `#${i + 1} · line ${fmtInt(d.line)}`}</option>)}
              </select>
            </label>
          )}
          {link.state === 'ok'
            ? <a className="btn" href={link.url} target="_blank" rel="noopener" title={`${base} (plan in URL fragment)`}>Open in plan viz ↗</a>
            : <button disabled title={link.state === 'big' ? 'plan too large for a link' : link.state === 'nogzip' ? 'no CompressionStream' : 'encoding…'}>Open in plan viz ↗</button>}
          <button className="icon-btn" onClick={copyJson} aria-label={copied ? 'Copied' : 'Copy JSON'} title={copied ? 'Copied' : 'Copy JSON (the visualizer\'s rows)'}>{copied ? <CheckIcon /> : <CopyIcon />}</button>
          <button className={`quiet${editing ? ' on' : ''}`} aria-label="Plan viz URL" title={`plan viz URL: ${base}`} aria-expanded={editing} onClick={() => { setDraft(override); setEditing(!editing) }}>⚙</button>
        </span>
      </header>
      {link.state === 'big' && <p className="small plan-note">plan too large for a link ({rows.length} rows); use Copy JSON (the copy icon).</p>}
      {link.state === 'nogzip' && <p className="small plan-note">No CompressionStream; use Copy JSON (the copy icon).</p>}
      {editing && (
        <form className="plan-cfg" onSubmit={(e) => { e.preventDefault(); save(draft) }}>
          <label className="small muted" htmlFor={`pv-${plan.id}`}>plan viz URL</label>
          <input id={`pv-${plan.id}`} type="text" value={draft} placeholder={doc.planViz || DEFAULT_PLAN_VIZ} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          <button type="submit">Save</button>
          <button type="button" onClick={() => { setDraft(''); save('') }}>reset to default</button>
          <span className="small muted">localStorage; plan sent in URL fragment only</span>
        </form>
      )}
      <PlanAdvisor findings={findings} onNode={(id) => setFocus((f) => ({ id, seq: (f?.seq ?? 0) + 1 }))} />
      {view === 'flow' && !hasStats && <p className="callout">{NO_STATS_NOTE}</p>}
      {view === 'flow' && hasStats
        ? <RowFlow doc={doc} plan={plan} lines={lines} scale={flowScale} onScale={onFlowScale} focus={focus} />
        : <PlanTable doc={doc} plan={plan} focus={focus} />}
    </section>
  )
}

const ADVICE_CLASS = { critical: 'serious', warning: 'notable', info: 'info' } as const

/** Plan-level findings from the visualizer's advisor (shared core package); facts only, no suggestions. */
function PlanAdvisor({ findings, onNode }: { findings: PlanFinding[]; onNode: (id: number) => void }) {
  if (findings.length === 0) return null
  const counts = { critical: 0, warning: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  const hint = (['critical', 'warning', 'info'] as const).filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(', ')
  return (
    <div className="plan-advisor">
      <header><h3>Plan advisor</h3><span className="hint">{hint} · metadata-free rules</span></header>
      <ul className="findings">
        {findings.map((f, i) => (
          <li key={`${f.ruleId}-${i}`} className={`finding sev-${ADVICE_CLASS[f.severity]}`}>
            <details open={f.severity === 'critical'}>
              <summary>
                <span className="sev">{f.severity}</span>
                <span className="finding-text">
                  <b>{f.title}</b>
                  {f.nodeIds.map((n) => <Fragment key={n}> <button type="button" className="link node-ref" title={`jump to plan line ${n}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onNode(n) }}>id {n}</button></Fragment>)}
                </span>
              </summary>
              <div className="advice small">
                <p>{f.explanation}</p>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PlanTable({ doc, plan, focus }: { doc: TraceDoc; plan: Plan; focus: { id: number; seq: number } | null }) {
  const lines = doc.planLines.slice(plan.first, plan.first + plan.n)
  const focusRow = useRef<HTMLTableRowElement | null>(null)
  useEffect(() => { if (focus) focusRow.current?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }, [focus])
  const maxT = lines.reduce((a, l) => Math.max(a, l.timeUs), 0)
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const toggle = (id: number) => setOpen((o) => { const n = new Set(o); if (!n.delete(id)) n.add(id); return n })
  return (
    <div className="tbl-wrap"><table className="tbl plan">
      <thead><tr><th className="num">id</th><th>operation</th><th className="num">rows</th><th className="num">starts</th><th className="num">cr</th><th className="num">pr</th><th className="num">pw</th><th className="num">time</th><th className="num">cost</th><th className="num">card</th></tr></thead>
      <tbody>{lines.map((l) => {
        const preds = [l.access && `access(${l.access})`, l.filter && `filter(${l.filter})`].filter(Boolean) as string[]
        const shown = open.has(l.id)
        return (
          <Fragment key={l.id}>
            <tr ref={focus?.id === l.id ? focusRow : undefined} className={[maxT > 0 && l.timeUs >= 0.5 * maxT ? 'hot' : '', focus?.id === l.id ? 'focus' : ''].filter(Boolean).join(' ') || undefined}>
              <td className="num dim">{l.id}</td>
              <td className="op" style={{ paddingInlineStart: `${0.5 + l.depth * 0.9}rem` }}>{l.op}{l.object && <span className="obj"> {l.object}</span>}{l.alias && <span className="obj dim"> {l.alias}</span>}
                {preds.length > 0 && <button className={`quiet pred${shown ? ' on' : ''}`} title={preds.join('\n')} aria-label="Predicates" aria-expanded={shown} onClick={() => toggle(l.id)}>⚑</button>}</td>
              <td className="num">{fmtCompact(l.rows)}</td><td className="num">{fmtCompact(l.starts)}</td>
              <td className="num">{fmtCompact(l.cr)}</td><td className="num">{fmtCompact(l.pr)}</td><td className="num">{fmtCompact(l.pw)}</td>
              <td className="num"><span className="heat"><i style={{ inlineSize: maxT ? `${(100 * l.timeUs) / maxT}%` : 0 }} /></span>{fmtDur(l.timeUs)}</td>
              <td className="num dim">{l.cost >= 0 ? fmtCompact(l.cost) : ''}</td>
              <td className="num dim">{l.card >= 0 ? fmtCompact(l.card) : l.eRows ? <span title="estimate from the ref bundle DBMS_XPLAN">~{fmtCompact(l.eRows)}</span> : ''}</td>
            </tr>
            {shown && <tr className="pred-row"><td /><td colSpan={9}>{preds.map((p) => <code key={p}>{p}</code>)}</td></tr>}
          </Fragment>
        )
      })}</tbody>
    </table></div>
  )
}

function Errors({ doc, id }: { doc: TraceDoc; id: ID }) {
  const errs = doc.errors.filter((e) => e.statement === id)
  if (errs.length === 0) return null
  return (
    <section className="section">
      <header><h2>Errors</h2></header>
      <ul className="small" style={{ margin: 0, paddingInlineStart: '1.2rem' }}>
        {errs.slice(0, 20).map((e) => <li key={e.id}>{e.parseError ? 'parse error ' : ''}{oraErr(e.err)} at <LineRef line={e.line} file={doc.fileOfCtx(e.context)} />{e.wallUs ? ` (${fmtWall(e.wallUs, doc.tzOffsetMin)})` : ''}</li>)}
        {errs.length > 20 && <li className="muted">… {errs.length - 20} more</li>}
      </ul>
    </section>
  )
}

/** The view buttons' glyphs (14 px, currentColor). */
function FlowIcon() {
  return <svg className="ico" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M1 3c5 0 5 4 12 4M1 11c5 0 5-4 12-4" /></svg>
}
function DialogueIcon() {
  return <svg className="ico" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 1v12M12 1v12M2 4h9M11 4l-1.5-1.2M12 9H3M3 9l1.5 1.2" /></svg>
}
function BlocksIcon() {
  return <svg className="ico" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="currentColor"><rect x="1" y="1" width="5" height="5" rx="1" /><rect x="8" y="1" width="5" height="5" rx="1" opacity=".45" /><rect x="1" y="8" width="5" height="5" rx="1" opacity=".45" /><rect x="8" y="8" width="5" height="5" rx="1" /></svg>
}
