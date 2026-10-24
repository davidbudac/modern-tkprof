import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TimelineChart } from './TimelineChart'
import type { TraceDoc } from '../data/doc'
import { StmtLink, LinkText } from '../components/StmtLink'
import { fmtDur, fmtInt, fmtCompact, fmtPct, preview } from '../data/format'
import { useStore, actions, callFilter, waitFilter } from '../app/store'
import { componentRows, quickSegments, statementWaits, type ComponentRow } from '../data/derive'
import { ticks, tickLabel, tickUnit, numberWord } from '../data/scale'
import { lightFill } from '../components/colors'
import { Findings, findingText } from './Findings'
import { Lanes } from './Lanes'
import { NONE, type StmtStats } from '../data/types'

const TOP_STATEMENTS = 8
const LEDGER_ROWS = 5

export function Overview({ doc }: { doc: TraceDoc }) {
  const state = useStore((s) => s)
  const cf = callFilter(state), wf = waitFilter(state)
  const totalUs = state.window ? state.window.endTim - state.window.startTim : doc.spanUs()
  const rows = useMemo(() => componentRows(doc, cf, wf, totalUs), [doc, state.window, state.contexts, state.includeIdle, totalUs])
  const stmts = useMemo(() => [...doc.stats.statements].filter((s) => s.allCalls.count > 0).sort((a, b) => b.elapsed + b.idleUs - (a.elapsed + a.idleUs)), [doc])
  const [timeView, setTimeView] = useState<'lanes' | 'event' | 'class'>('lanes')
  return (
    <>
      <section className="hero">
        <h1>Where {fmtDur(totalUs)} went{state.window ? <span className="dim"> in the selected window</span> : null}</h1>
        <p className="lede">{summary(rows, totalUs, state.window ? [] : stmts)}</p>
        <Axis totalUs={totalUs} />
        <Track rows={rows} totalUs={totalUs} />
        <Ledger rows={rows} totalUs={totalUs} />
      </section>

      <section className="section">
        <header><h2>Statements</h2><span className="hint">{state.window ? 'whole trace, on the trace\'s time scale (statement numbers do not follow the window)' : 'response time on the same scale as above'}; recursive children and idle time between calls included</span>
          <span className="tools"><button className="link" onClick={() => actions.setView('statements')}>all {stmts.length} statements</button></span></header>
        <StatementLedger doc={doc} stmts={stmts} totalUs={doc.spanUs()} />
      </section>

      <Findings doc={doc} />

      <section className="section">
        <header><h2>The session over time</h2>
          <span className="hint">{timeView === 'lanes' ? 'one lane per statement, in order of first call; drag across the lanes to focus every view on a window, click empty space or press Esc to clear it; click a bar or sql_id to open the statement' : 'busy time per bucket; drag the slider below the chart to focus every view on a window, press Esc to clear it'}</span>
          <span className="tools"><span className="seg" role="group" aria-label="Time view">
            <button aria-pressed={timeView === 'lanes'} onClick={() => setTimeView('lanes')}>lanes</button>
            <button aria-pressed={timeView === 'event'} onClick={() => setTimeView('event')} title="stacked buckets, one series per wait event (top 10, rest folded)">by event</button>
            <button aria-pressed={timeView === 'class'} onClick={() => setTimeView('class')} title="stacked buckets, waits folded into wait classes">by class</button>
          </span></span></header>
        {timeView === 'lanes' ? <Lanes doc={doc} /> : <TimelineChart doc={doc} by={timeView} />}
      </section>

      <TraceFacts doc={doc} />
    </>
  )
}

/** One or two sentences that say what the numbers say. */
function summary(rows: ComponentRow[], totalUs: number, stmts: StmtStats[]): string {
  if (totalUs <= 0) return 'The trace has no time information.'
  const waits = rows.filter((r) => r.kind === 'wait' && r.role !== 'idle' && r.us / totalUs >= 0.05).slice(0, 2)
  const cpu = rows.find((r) => r.kind === 'cpu')?.us ?? 0
  const idle = rows.filter((r) => r.role === 'idle').reduce((a, r) => a + r.us, 0)
  const part = (r: ComponentRow) => `${fmtDur(r.us)} (${fmtPct(r.us, totalUs, 0)}) on ${r.label}`
  const out: string[] = []
  if (waits.length) out.push(`The session spent ${waits.map(part).join(' and ')}.`)
  if (cpu / totalUs >= 0.5) out.push(`Most of the time is CPU work: ${fmtDur(cpu)}, ${fmtPct(cpu, totalUs, 0)}.`)
  else out.push(`CPU work is ${fmtDur(cpu)}, ${fmtPct(cpu, totalUs, 0)}.`)
  if (idle / totalUs >= 0.05) out.push(`${fmtDur(idle)} (${fmtPct(idle, totalUs, 0)}) was idle, waiting for the client between calls.`)
  let acc = 0, k = 0
  for (const s of stmts) { acc += s.elapsed + s.idleUs; k++; if (acc >= 0.8 * totalUs) break }
  if (stmts.length > 1 && acc >= 0.8 * totalUs) {
    if (k <= 5) out.push(`${k === 1 ? 'One statement accounts' : `${numberWord(k)[0].toUpperCase() + numberWord(k).slice(1)} statements account`} for ${fmtPct(acc, totalUs, 0)} of it.`)
    else out.push(`No single statement dominates: it takes ${k} to reach ${fmtPct(acc, totalUs, 0)}.`)
  }
  return out.join(' ')
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
      {rest > 0 && <div className="seg rest" style={{ width: `${(100 * rest) / scale}%` }} title={`other components: ${fmtDur(rest)}`} />}
    </div>
  )
}

function Ledger({ rows, totalUs }: { rows: ComponentRow[]; totalUs: number }) {
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
          <dt className="dim">{rest.length > 0 ? `${rest.length} more component${rest.length === 1 ? '' : 's'}` : ''}{rest.length > 0 && un ? ' · ' : ''}{un ? `unaccounted ${un.us < 0 ? '−' : ''}${fmtDur(Math.abs(un.us))}` : ''}</dt>
          <dd><span className="dim">{rest.length > 0 ? fmtDur(restUs) : ''}</span><span className="dim">{rest.length > 0 ? fmtPct(restUs, totalUs) : ''}</span><span className="n"><button className="link" onClick={() => actions.setView('waits')}>all wait events</button></span></dd>
        </div>
      )}
    </dl>
  )
}

/** Top statements, each with its own profile bar drawn on the shared time axis. */
function StatementLedger({ doc, stmts, totalUs }: { doc: TraceDoc; stmts: StmtStats[]; totalUs: number }) {
  const top = stmts.slice(0, TOP_STATEMENTS)
  const rest = stmts.slice(TOP_STATEMENTS)
  const restUs = rest.reduce((a, s) => a + s.elapsed + s.idleUs, 0)
  const tk = ticks(totalUs)
  const findings = doc.stats.findings
  return (
    <div className="stmt-ledger ruled" style={{ backgroundSize: `${(100 * tk.step) / totalUs}% 100%` }}>
      {top.map((st) => {
        const s = doc.statements[st.id]
        const resp = st.elapsed + st.idleUs
        const segs = quickSegments(doc, st).filter((x) => x.us > 0)
        const own = findings.filter((f) => f.statement === st.id)
        return (
          <div key={st.id} className="srow row-click" onClick={() => actions.selectStmt(st.id)}>
            <div className="meta">
              <span className="id"><StmtLink doc={doc} id={st.id} /></span>
              <span className="txt mono">{preview(s.text, 140)}</span>
              <span className="t">{fmtDur(resp)}</span>
              <span className="p">{fmtPct(resp, totalUs)}</span>
            </div>
            <div className="bar">{segs.map((x) => <i key={x.role} style={{ width: `${(100 * x.us) / totalUs}%`, background: `var(--c-${x.role})` }} title={`${x.label} ${fmtDur(x.us)}`} />)}</div>
            <div className="note">
              <Note doc={doc} st={st} />
              {own.map((f, i) => <span key={i} className="fnote"><span className={`badge ${f.severity}`}>{f.severity}</span><b>{f.title}</b> <LinkText doc={doc} text={findingText(doc, f)} /></span>)}
            </div>
          </div>
        )
      })}
      {rest.length > 0 && <div className="srest">{rest.length} more statement{rest.length === 1 ? '' : 's'}, {fmtDur(restUs)} together ({fmtPct(restUs, totalUs)}). <button className="link" onClick={() => actions.setView('statements')}>Open the list</button></div>}
    </div>
  )
}

/** What the statement did, in one line: its top wait, its volume, its plan, its recursive work. */
function Note({ doc, st }: { doc: TraceDoc; st: StmtStats }) {
  const parts: string[] = []
  const w = statementWaits(doc, st.id, 3).find((x) => x.role !== 'idle')
  const resp = st.elapsed + st.idleUs
  if (w && w.us / resp >= 0.2) parts.push(`${w.name} ${fmtDur(w.us)} in ${fmtInt(w.count)} wait${w.count === 1 ? '' : 's'}${w.obj > 0 && (w.role === 'userio' || w.role === 'sysio') ? ` on obj# ${w.obj}` : ''}`)
  else if (st.cpu / resp >= 0.5) parts.push(`${fmtDur(st.cpu)} CPU`)
  if (st.executions > 1) parts.push(`${fmtInt(st.executions)} executions`)
  if (st.allCalls.rows > 0) parts.push(`${fmtCompact(st.allCalls.rows)} row${st.allCalls.rows === 1 ? '' : 's'}${st.fetch.count > 1 ? ` in ${fmtInt(st.fetch.count)} fetches` : ''}`)
  if (st.allCalls.disk > 0) parts.push(`${fmtCompact(st.allCalls.disk)} disk reads`)
  if (st.childUs >= 0.01 * st.elapsed && st.children?.length) parts.push(`runs ${st.children.length} recursive statement${st.children.length === 1 ? '' : 's'} (${fmtPct(st.childUs, st.elapsed, 0)} of its time)`)
  if (st.planHashes?.length) parts.push(`plan ${st.planHashes.join(', ')}`)
  if (st.errors > 0) parts.push(`${st.errors} error${st.errors === 1 ? '' : 's'}`)
  return <span>{parts.join(' · ')}</span>
}

function TraceFacts({ doc }: { doc: TraceDoc }) {
  const stats = doc.stats
  const nExec = stats.statements.reduce((a, s) => a + s.executions, 0)
  const rows = stats.statements.reduce((a, s) => a + s.allCalls.rows, 0)
  const disk = stats.statements.reduce((a, s) => a + s.allCalls.disk, 0)
  const query = stats.statements.reduce((a, s) => a + s.allCalls.query, 0)
  const calls = doc.hasFacts ? doc.calls.n : stats.statements.reduce((a, s) => a + s.allCalls.count, 0)
  const waits = doc.hasFacts ? doc.waits.n : stats.events.reduce((a, e) => a + e.count, 0)
  const commits = doc.transactions.filter((t) => !t.rollback).length, rollbacks = doc.transactions.length - commits
  const sentences: string[] = []
  sentences.push(`${doc.errors.length === 0 ? 'No errors' : `${fmtInt(doc.errors.length)} error${doc.errors.length === 1 ? '' : 's'}`}, ${doc.transactions.length === 0 ? 'no commits' : `${fmtInt(commits)} commit${commits === 1 ? '' : 's'}${rollbacks ? ` and ${fmtInt(rollbacks)} rollback${rollbacks === 1 ? '' : 's'}` : ''}`}.`)
  sentences.push(`${fmtInt(doc.diag.lines)} lines${doc.diag.unknownLines ? `, ${fmtInt(doc.diag.unknownLines)} not recognised (first at line ${fmtInt(doc.unknown[0]?.line ?? 0)})` : ', every one recognised'}.`)
  if (doc.diag.assumedCursors) sentences.push(`${doc.diag.assumedCursors} cursor${doc.diag.assumedCursors === 1 ? ' was' : 's were'} open before tracing started; earlier calls are attributed as tkprof does.`)
  if (doc.file.truncated) sentences.push('The trace was cut by max_dump_file_size.')
  return (
    <section className="section facts-sec">
      <header><h2>The trace</h2></header>
      <div className="facts">
        <div className="fact"><span className="v">{fmtInt(doc.statements.length)}</span><span className="l">statements</span></div>
        <div className="fact"><span className="v">{fmtCompact(nExec)}</span><span className="l">executions</span></div>
        <div className="fact"><span className="v">{fmtCompact(calls)}</span><span className="l">db calls</span></div>
        <div className="fact"><span className="v">{fmtCompact(waits)}</span><span className="l">waits</span></div>
        <div className="fact"><span className="v">{fmtCompact(rows)}</span><span className="l">rows</span></div>
        <div className="fact" title="physical block reads (p=)"><span className="v">{fmtCompact(disk)}</span><span className="l">disk reads</span></div>
        <div className="fact" title="buffer gets in consistent mode (cr=)"><span className="v">{fmtCompact(query)}</span><span className="l">consistent gets</span></div>
      </div>
      <p className="small muted">{sentences.join(' ')}{doc.diag.notes?.length ? ' ' + doc.diag.notes.join(' ') : ''}</p>
    </section>
  )
}
