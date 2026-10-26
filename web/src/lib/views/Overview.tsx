import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ctxKey } from '../data/fileset'
import { TimelineChart } from './TimelineChart'
import type { TraceDoc } from '../data/doc'
import { StmtLink, LinkText } from '../components/StmtLink'
import { fmtDur, fmtInt, fmtCompact, fmtPct, preview } from '../data/format'
import { scopeOf, type Scope } from '../state/store'
import { useStore, useActions } from '../state/session'
import { sourceOf, useSourceQuery } from '../data/source'
import { componentRowsFrom, quickSegments, type ComponentRow, type ScopeProfile, type StmtWait } from '../data/derive'
import { ticks, tickLabel, tickUnit } from '../data/scale'
import { lightFill } from '../components/colors'
import { Findings, findingText } from './Findings'
import { Lanes, type LaneColor } from './Lanes'
import { Minimap } from '../components/Minimap'
import { WindowBar } from '../components/WindowBar'
import { NONE, type StmtStats } from '../data/types'
import { scopeKey, useScope, useScopedStatements, type ScopedStatements } from '../data/scopedstmts'
import { useScopedFindings } from '../data/scopedfindings'
import { selectedCount, fileCount } from '../data/fileset'
import { concentrationLede, responseOf, responseShare, responseUs, sessionsLabel, shareNote } from '../data/response'

const TOP_STATEMENTS = 8
const LEDGER_ROWS = 5

export function Overview({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  const state = useStore((s) => s)
  const source = sourceOf(doc)
  const scope = scopeOf(state)
  const profile = useSourceQuery(source, `profile:${scope.window ? `${scope.window.startTim}:${scope.window.endTim}` : ''}|${ctxKey(scope.contexts)}|${scope.includeIdle ? 1 : 0}`,
    (signal) => source.profile(scope, signal), 'profile')
  // the base of every percentage here: Σ session spans of the scope (response.ts), with the wall clock beside it
  const resp = useMemo(() => responseOf(doc, scope, profile.data), [doc, scope, profile.data])
  const totalUs = resp.responseUs
  const sessions = sessionsLabel(resp, fmtDur)
  const rows = useMemo(() => componentRowsFrom(doc, profile.data ?? null, totalUs), [doc, profile.data, totalUs])
  const ss = useScopedStatements(doc)
  const stmts = useMemo(() => [...ss.stats].filter((s) => s.allCalls.count > 0).sort((a, b) => responseUs(b) - responseUs(a)), [ss.stats])
  const lede = concentrationLede(totalUs, stmts)
  const [timeView, setTimeView] = useState<'lanes' | 'event' | 'class'>('lanes')
  const [laneColor, setLaneColor] = useState<LaneColor>('phase')
  const [laneWaits, setLaneWaits] = useState(false)
  return (
    <>
      <section className="hero">
        <div className="hero-head">
          <h1>Response time {fmtDur(totalUs)}{sessions ? <span className="dim" title="sum over the sessions of each session's span; wall: the clock time the scope covers"> · {sessions}</span> : null}{state.window ? <span className="dim"> · window</span> : null}{state.files ? <span className="dim"> · {selectedCount(doc, state.files)} of {fileCount(doc)} files</span> : null}</h1>
          {lede && <p className="lede">{lede}</p>}
        </div>
        <Minimap doc={doc} />
        <Axis totalUs={totalUs} />
        <Track rows={rows} totalUs={totalUs} />
        <Ledger rows={rows} totalUs={totalUs} />
      </section>

      <section className="section">
        <header><h2>Timeline</h2>
          <span className="hint">{timeView === 'lanes' ? 'lane per statement, by first call · drag: set window · click a block: window it · double-click: open · Esc: clear' : 'busy time per bucket · slider: set window · Esc: clear'}</span>
          <span className="tools">
            {timeView === 'lanes' && <span className="seg" role="group" aria-label="Color lanes by">
              <button aria-pressed={laneColor === 'phase'} onClick={() => setLaneColor('phase')} title="PARSE / EXEC / FETCH / CLOSE / other">phase</button>
              <button aria-pressed={laneColor === 'resource'} onClick={() => setLaneColor('resource')} title="the statement's dominant resource">resource</button>
            </span>}
            {timeView === 'lanes' && <span className="seg" role="group" aria-label="Wait strips">
              <button aria-pressed={laneWaits} onClick={() => setLaneWaits((v) => !v)} title="a strip of the wait events under each lane">waits</button>
            </span>}
            <span className="seg" role="group" aria-label="Time view">
            <button aria-pressed={timeView === 'lanes'} onClick={() => setTimeView('lanes')}>lanes</button>
            <button aria-pressed={timeView === 'event'} onClick={() => setTimeView('event')} title="top 10 events, rest folded">by event</button>
            <button aria-pressed={timeView === 'class'} onClick={() => setTimeView('class')} title="by wait class">by class</button>
          </span></span></header>
        <WindowBar doc={doc} zoom={timeView === 'lanes'} />
        {timeView === 'lanes' ? <Lanes doc={doc} colorBy={laneColor} showWaits={laneWaits} /> : <TimelineChart doc={doc} by={timeView} />}
      </section>

      <section className="section">
        <header><h2>Statements</h2><span className="hint">incl. recursive children and idle between calls{ss.narrowed ? ` · ${ss.inScope} of ${ss.total} statements in scope` : ''}</span>
          <span className="tools"><button className="link" onClick={() => actions.setView('statements')}>all {stmts.length} statements</button></span></header>
        {ss.notice && <p className="callout">{ss.notice}</p>}
        <StatementLedger doc={doc} stmts={stmts} totalUs={totalUs} />
      </section>

      <Findings doc={doc} />

      <TraceFacts doc={doc} ss={ss} scope={scope} profile={profile.data ?? null} />
    </>
  )
}

function Axis({ totalUs }: { totalUs: number }) {
  const tk = ticks(totalUs)
  return (
    <div className="axis">
      {tk.at.map((t, i) => <i key={t} style={{ left: `${(100 * t) / totalUs}%` }}>{i === 0 ? `0 ${tickUnit(tk.step)}` : tickLabel(t, tk.step)}</i>)}
      <i className="last">{fmtDur(totalUs)}</i>
    </div>
  )
}

/** Measured width of an element, for deciding which labels fit. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

const MIN_SEG = 0.004

/** The response-time bar: one segment per component, on the axis above it. */
function Track({ rows, totalUs }: { rows: ComponentRow[]; totalUs: number }) {
  const actions = useActions()
  const [ref, width] = useWidth<HTMLDivElement>()
  const shown = rows.filter((r) => r.kind !== 'unaccounted' && r.us > 0)
  const big = shown.filter((r) => r.us / totalUs >= MIN_SEG)
  const rest = shown.filter((r) => r.us / totalUs < MIN_SEG).reduce((a, r) => a + r.us, 0)
  const scale = Math.max(totalUs, shown.reduce((a, r) => a + r.us, 0))
  return (
    <div className="track" ref={ref} role="img" aria-label={big.map((r) => `${r.label} ${fmtPct(r.us, totalUs, 0)}`).join(', ')}>
      {big.map((r) => {
        const px = (width * r.us) / scale
        const fits = px >= r.label.length * 6.6 + 14
        return (
          <div key={r.label} className={'seg' + (lightFill(r.role) ? ' on-light' : '')} style={{ width: `${(100 * r.us) / scale}%`, background: `var(--c-${r.role})`, cursor: r.event !== NONE ? 'pointer' : undefined }}
            title={`${r.label}: ${fmtDur(r.us)} (${fmtPct(r.us, totalUs)})${r.count ? `, ${fmtInt(r.count)} waits` : ''}`}
            onClick={r.event !== NONE ? () => actions.selectEvent(r.event) : undefined}>
            {fits ? r.label : ''}
          </div>
        )
      })}
      {rest > 0 && <div className="seg rest" style={{ width: `${(100 * rest) / scale}%` }} title={`other: ${fmtDur(rest)}`} />}
    </div>
  )
}

function Ledger({ rows, totalUs }: { rows: ComponentRow[]; totalUs: number }) {
  const actions = useActions()
  const main = rows.filter((r) => r.kind !== 'unaccounted' && r.us > 0)
  const top = main.slice(0, LEDGER_ROWS)
  const rest = main.slice(LEDGER_ROWS)
  const restUs = rest.reduce((a, r) => a + r.us, 0)
  const un = rows.find((r) => r.kind === 'unaccounted')
  const note = (r: ComponentRow) => {
    if (r.kind === 'cpu' || !r.count) return ''
    if (r.role === 'idle') return `${fmtInt(r.count)} ${/message from client/.test(r.label) ? 'round trips' : 'waits'}`
    return `${fmtInt(r.count)} wait${r.count === 1 ? '' : 's'}, ${r.count <= 10 ? `longest ${fmtDur(r.maxUs)}` : `avg ${fmtDur(r.us / r.count)}`}`
  }
  return (
    <dl className="ledger">
      {top.map((r) => (
        <div key={r.label} className={r.event !== NONE ? 'row-click' : undefined} onClick={r.event !== NONE ? () => actions.selectEvent(r.event) : undefined}>
          <dt><i className="swatch" style={{ background: `var(--c-${r.role})` }} />{r.label}</dt>
          <dd><span>{fmtDur(r.us)}</span><span>{fmtPct(r.us, totalUs)}</span><span className="n">{note(r)}</span></dd>
        </div>
      ))}
      {(rest.length > 0 || un) && (
        <div className="rest">
          <dt className="dim">{rest.length > 0 ? `${rest.length} more` : ''}{rest.length > 0 && un ? ' · ' : ''}{un ? `unaccounted ${un.us < 0 ? '−' : ''}${fmtDur(Math.abs(un.us))}` : ''}</dt>
          <dd><span className="dim">{rest.length > 0 ? fmtDur(restUs) : ''}</span><span className="dim">{rest.length > 0 ? fmtPct(restUs, totalUs) : ''}</span><span className="n"><button className="link" onClick={() => actions.setView('waits')}>all waits</button></span></dd>
        </div>
      )}
    </dl>
  )
}

/** Top statements, each with its own profile bar drawn on the shared time axis. */
function StatementLedger({ doc, stmts, totalUs }: { doc: TraceDoc; stmts: StmtStats[]; totalUs: number }) {
  const actions = useActions()
  const source = sourceOf(doc)
  const top = stmts.slice(0, TOP_STATEMENTS)
  const scope = useScope(doc)
  const roles = useSourceQuery(source, `roles:${scopeKey(scope)}`, (signal) => source.stmtRoles(scope, signal), 'roles').data
  const topIds = top.map((s) => s.id)
  const waits = useSourceQuery(source, `waits:${topIds.join(',')}:${scopeKey(scope)}`, (signal) => (source.ready ? source.stmtWaits(topIds, 3, scope, signal) : null)).data
  const rest = stmts.slice(TOP_STATEMENTS)
  const restUs = rest.reduce((a, s) => a + responseUs(s), 0)
  const tk = ticks(totalUs)
  const findings = useScopedFindings(doc).findings
  return (
    <div className="stmt-ledger ruled" style={{ backgroundSize: `${(100 * tk.step) / totalUs}% 100%` }}>
      {top.map((st) => {
        const s = doc.statements[st.id]
        const resp = responseUs(st)
        const segs = quickSegments(doc, st, roles).filter((x) => x.us > 0)
        const own = findings.filter((f) => f.statement === st.id)
        return (
          <div key={st.id} className="srow row-click" onClick={() => actions.selectStmt(st.id)}>
            <div className="meta">
              <span className="id"><StmtLink doc={doc} id={st.id} /></span>
              <span className="txt mono">{preview(s.text, 300)}</span>
              <span className="t">{fmtDur(resp)}</span>
              <span className="p" title={shareNote(responseShare(st, totalUs))}>{fmtPct(resp, totalUs)}</span>
            </div>
            <div className="bar">{segs.map((x) => <i key={x.role} style={{ width: `${(100 * x.us) / totalUs}%`, background: `var(--c-${x.role})` }} title={`${x.label} ${fmtDur(x.us)}`} />)}</div>
            <div className="note">
              <Note doc={doc} st={st} waits={waits?.get(st.id)} />
              {own.map((f, i) => <span key={i} className="fnote"><span className={`badge ${f.severity}`}>{f.severity}</span><b>{f.title}</b> <LinkText doc={doc} text={findingText(doc, f)} /></span>)}
            </div>
          </div>
        )
      })}
      {rest.length > 0 && <div className="srest">{rest.length} more statement{rest.length === 1 ? '' : 's'} · {fmtDur(restUs)} ({fmtPct(restUs, totalUs)}) <button className="link" onClick={() => actions.setView('statements')}>all</button></div>}
    </div>
  )
}

/** One line per statement: top wait, volume, plan, recursive work. */
function Note({ doc, st, waits }: { doc: TraceDoc; st: StmtStats; waits?: StmtWait[] }) {
  const parts: string[] = []
  const w = (waits ?? []).find((x) => x.role !== 'idle')
  const resp = responseUs(st)
  if (w && w.us / resp >= 0.2) parts.push(`${w.name} ${fmtDur(w.us)} in ${fmtInt(w.count)} wait${w.count === 1 ? '' : 's'}${w.obj > 0 && (w.role === 'userio' || w.role === 'sysio') ? ` on obj# ${w.obj}${doc.objectName(w.obj) ? ` (${doc.objectName(w.obj)})` : ''}` : ''}`)
  else if (st.cpu / resp >= 0.5) parts.push(`${fmtDur(st.cpu)} CPU`)
  if (st.executions > 1) parts.push(`${fmtInt(st.executions)} executions`)
  if (st.allCalls.rows > 0) parts.push(`${fmtCompact(st.allCalls.rows)} row${st.allCalls.rows === 1 ? '' : 's'}${st.fetch.count > 1 ? ` in ${fmtInt(st.fetch.count)} fetches` : ''}`)
  if (st.allCalls.disk > 0) parts.push(`${fmtCompact(st.allCalls.disk)} disk reads`)
  if (st.childUs >= 0.01 * st.elapsed && st.children?.length) parts.push(`${st.children.length} recursive statement${st.children.length === 1 ? '' : 's'} ${fmtPct(st.childUs, st.elapsed, 0)}`)
  if (st.planHashes?.length) parts.push(`plan ${st.planHashes.join(', ')}`)
  if (st.errors > 0) parts.push(`${st.errors} error${st.errors === 1 ? '' : 's'}`)
  return <span>{parts.join(' · ')}</span>
}

/**
 * The facts of the trace; with a scope (window, sessions, files) the counts that the scope can answer are the scope's:
 * the statement table's sums, the waits of the profile, the errors, commits and lines of its contexts and files. The rest
 * (unrecognised lines, notes) stays whole-trace.
 */
function TraceFacts({ doc, ss, scope, profile }: { doc: TraceDoc; ss: ScopedStatements; scope: Scope; profile: ScopeProfile | null }) {
  const stats = doc.stats
  const narrows = ss.narrowed
  const rowsOf = ss.stats
  const nExec = rowsOf.reduce((a, s) => a + s.executions, 0)
  const rows = rowsOf.reduce((a, s) => a + s.allCalls.rows, 0)
  const disk = rowsOf.reduce((a, s) => a + s.allCalls.disk, 0)
  const query = rowsOf.reduce((a, s) => a + s.allCalls.query, 0)
  const calls = narrows ? rowsOf.reduce((a, s) => a + s.allCalls.count, 0) : doc.hasFacts ? doc.calls.n : rowsOf.reduce((a, s) => a + s.allCalls.count, 0)
  const waits = narrows && profile ? profile.events.reduce((a, e) => a + e.count, 0) : doc.hasFacts ? doc.waits.n : stats.events.reduce((a, e) => a + e.count, 0)
  const errors = narrows ? rowsOf.reduce((a, s) => a + s.errors, 0) : doc.errors.length
  const txs = narrows ? doc.transactions.filter((t) => (!scope.contexts || scope.contexts.has(t.context)) && (!scope.window || (t.tim >= scope.window.startTim && t.tim <= scope.window.endTim))) : doc.transactions
  const commits = txs.filter((t) => !t.rollback).length, rollbacks = txs.length - commits
  const lines = scope.files ? (doc.file.files ?? []).reduce((a, f, i) => a + (scope.files!.has(i) ? f.lines : 0), 0) : doc.diag.lines
  const facts: string[] = []
  facts.push(`${fmtInt(errors)} error${errors === 1 ? '' : 's'}`)
  facts.push(`${fmtInt(commits)} commit${commits === 1 ? '' : 's'}${rollbacks ? `, ${fmtInt(rollbacks)} rollback${rollbacks === 1 ? '' : 's'}` : ''}`)
  facts.push(`${fmtInt(lines)} lines${doc.diag.unknownLines ? `, ${fmtInt(doc.diag.unknownLines)} unrecognised (first: line ${fmtInt(doc.unknown[0]?.line ?? 0)})` : ''}`)
  if (doc.diag.assumedCursors) facts.push(`${doc.diag.assumedCursors} cursor${doc.diag.assumedCursors === 1 ? '' : 's'} opened before trace start (attributed as tkprof)`)
  if (doc.file.truncated) facts.push('cut by max_dump_file_size')
  facts.push(...(doc.diag.notes ?? []))
  return (
    <section className="section facts-sec">
      <header><h2>Trace</h2>{narrows && <span className="hint">counts of the selection · notes are for the whole set</span>}</header>
      <div className="facts">
        <div className="fact"><span className="v">{fmtInt(narrows ? ss.inScope : doc.statements.length)}</span><span className="l">statements</span></div>
        <div className="fact"><span className="v">{fmtCompact(nExec)}</span><span className="l">executions</span></div>
        <div className="fact"><span className="v">{fmtCompact(calls)}</span><span className="l">db calls</span></div>
        <div className="fact"><span className="v">{fmtCompact(waits)}</span><span className="l">waits</span></div>
        <div className="fact"><span className="v">{fmtCompact(rows)}</span><span className="l">rows</span></div>
        <div className="fact" title="physical block reads (p=)"><span className="v">{fmtCompact(disk)}</span><span className="l">disk reads</span></div>
        <div className="fact" title="buffer gets in consistent mode (cr=)"><span className="v">{fmtCompact(query)}</span><span className="l">consistent gets</span></div>
      </div>
      <p className="small muted">{facts.join(' · ')}</p>
    </section>
  )
}
