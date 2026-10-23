import { useMemo, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import { fmtDur, fmtInt, fmtCompact, fmtPct, preview, fmtWall } from '../data/format'
import { useStore, actions, callFilter, waitFilter } from '../app/store'
import { ProfileBar } from '../components/ProfileBar'
import { Stat } from '../components/Stat'
import { DataTable, type Column } from '../components/DataTable'
import { traceSegments } from '../data/derive'
import { TimelineChart } from './TimelineChart'
import { Findings } from './Findings'
import { roleOfClass } from '../components/colors'
import type { ProfileRow, StmtStats } from '../data/types'

export function Overview({ doc }: { doc: TraceDoc }) {
  const state = useStore((s) => s)
  const [timelineBy, setTimelineBy] = useState<'event' | 'class'>('event')
  const cf = callFilter(state), wf = waitFilter(state)
  const totalUs = state.window ? state.window.endTim - state.window.startTim : doc.spanUs()
  const segments = useMemo(() => traceSegments(doc, cf, wf, totalUs), [doc, state.window, state.contexts, state.includeIdle, totalUs])
  const cpu = segments.find((s) => s.role === 'cpu')?.us ?? 0
  const topWait = doc.stats.profile.rows.filter((r) => r.kind === 'wait').sort((a, b) => b.us - a.us)[0]
  const idle = segments.find((s) => s.role === 'idle')?.us ?? 0
  const stats = doc.stats
  const nExec = stats.statements.reduce((a, s) => a + s.executions, 0)
  const rows = stats.statements.reduce((a, s) => a + s.allCalls.rows, 0)
  const disk = stats.statements.reduce((a, s) => a + s.allCalls.disk, 0)
  const query = stats.statements.reduce((a, s) => a + s.allCalls.query, 0)

  return (
    <>
      <section className="hero">
        <div className="figure">{fmtDur(totalUs)}<small>{state.window ? 'selected window' : 'response time in trace'}</small></div>
        <p className="lede">
          {fmtPct(cpu, totalUs)} on CPU
          {topWait ? <>, {fmtPct(topWait.us, totalUs)} waiting on <b>{topWait.component}</b></> : null}
          {idle > 0 ? <>, {fmtPct(idle, totalUs)} idle between calls</> : null}.
          {doc.file.truncated && <> The trace was cut by max_dump_file_size.</>}
          {doc.file.continuedFrom?.length ? <> It continues an earlier file.</> : null}
        </p>
        <ProfileBar segments={segments} totalUs={totalUs} />
      </section>

      <div className="stats">
        <Stat label="statements" value={fmtInt(doc.statements.length)} />
        <Stat label="executions" value={fmtCompact(nExec)} />
        <Stat label="db calls" value={fmtCompact(doc.hasFacts ? doc.calls.n : stats.statements.reduce((a, s) => a + s.allCalls.count, 0))} />
        <Stat label="waits" value={fmtCompact(doc.hasFacts ? doc.waits.n : stats.events.reduce((a, e) => a + e.count, 0))} />
        <Stat label="rows" value={fmtCompact(rows)} />
        <Stat label="disk reads" value={fmtCompact(disk)} title="physical block reads (p=)" />
        <Stat label="consistent gets" value={fmtCompact(query)} title="buffer gets in consistent mode (cr=)" />
        <Stat label="transactions" value={fmtInt(doc.transactions.length)} title="XCTEND lines (commits + rollbacks)" />
        <Stat label="errors" value={fmtInt(doc.errors.length)} />
      </div>

      <Findings doc={doc} />

      <section className="section">
        <header><h2>Activity over time</h2><span className="hint">drag the slider below the chart to focus on a window; every view follows</span>
          <span className="tools">
            <span className="seg" role="group" aria-label="Break down waits by">
              <button aria-pressed={timelineBy === 'event'} onClick={() => setTimelineBy('event')} title="one series per wait event (top 10, rest folded)">events</button>
              <button aria-pressed={timelineBy === 'class'} onClick={() => setTimelineBy('class')} title="waits folded into wait classes">classes</button>
            </span>
          </span></header>
        <TimelineChart doc={doc} by={timelineBy} />
      </section>

      <div className="grid-2">
        <section className="section">
          <header><h2>Resource profile</h2><span className="hint">where the response time went</span></header>
          <ProfileTable doc={doc} totalUs={totalUs} />
        </section>
        <section className="section">
          <header><h2>Top statements</h2><span className="hint">by response time, recursive children included</span>
            <span className="tools"><button className="link" onClick={() => actions.setView('statements')}>all {doc.statements.length} statements</button></span></header>
          <TopStatements doc={doc} totalUs={totalUs} />
        </section>
      </div>

      {(doc.diag.notes?.length || doc.diag.unknownLines || doc.unknown.length) ? (
        <section className="section">
          <header><h2>Notes</h2></header>
          <ul className="small muted" style={{ margin: 0, paddingInlineStart: '1.2rem' }}>
            {doc.diag.unknownLines > 0 && <li>{doc.diag.unknownLines} lines were not recognised (first ones: {doc.unknown.slice(0, 3).map((u) => `line ${u.line}`).join(', ')}).</li>}
            {doc.diag.notes?.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </section>
      ) : null}
    </>
  )
}

function ProfileTable({ doc, totalUs }: { doc: TraceDoc; totalUs: number }) {
  const rows = doc.stats.profile.rows.filter((r) => r.us > 0 || r.count > 0)
  const sel = useStore((s) => s.selection.event)
  const cols: Column<ProfileRow>[] = [
    { key: 'c', header: 'Component', render: (r) => <span className="evname" title={r.component}><i className={'swatch' + (r.kind === 'unaccounted' ? ' unaccounted' : '')} style={{ background: r.kind === 'unaccounted' ? undefined : `var(--c-${r.kind === 'cpu' ? 'cpu' : roleOfClass(r.class ?? '', r.kind === 'idle')})` }} /><span>{r.component}</span></span>, sort: (r) => r.component, className: 'clip', width: '18rem' },
    { key: 'us', header: 'Time', align: 'end', render: (r) => fmtDur(r.us), sort: (r) => r.us, bar: true },
    { key: 'pct', header: '%', align: 'end', render: (r) => fmtPct(r.us, totalUs), sort: (r) => r.us },
    { key: 'n', header: 'Count', align: 'end', render: (r) => (r.count ? fmtInt(r.count) : ''), sort: (r) => r.count },
    { key: 'avg', header: 'Avg', align: 'end', render: (r) => (r.count ? fmtDur(r.avgUs) : ''), sort: (r) => r.avgUs },
    { key: 'max', header: 'Max', align: 'end', render: (r) => (r.count ? fmtDur(r.maxUs) : ''), sort: (r) => r.maxUs },
    { key: 'cls', header: 'Class', render: (r) => <span className="dim">{r.kind === 'cpu' ? '' : r.kind === 'unaccounted' ? '' : r.class || '?'}</span>, sort: (r) => r.class ?? '' },
  ]
  const evByName = new Map(doc.events.map((e) => [e.name, e.id]))
  return (
    <DataTable columns={cols} rows={rows} rowKey={(r) => r.component} defaultSort={{ key: 'us', dir: 'desc' }} maxHeight="30rem"
      selectedKey={sel !== null ? doc.events[sel]?.name : null}
      onRowClick={(r) => { const id = evByName.get(r.component); if (id !== undefined) actions.selectEvent(id) }} />
  )
}

function TopStatements({ doc, totalUs }: { doc: TraceDoc; totalUs: number }) {
  const sel = useStore((s) => s.selection.stmt)
  const rows = [...doc.stats.statements].filter((s) => s.allCalls.count > 0).sort((a, b) => b.elapsed + b.idleUs - (a.elapsed + a.idleUs)).slice(0, 12)
  const cols: Column<StmtStats>[] = [
    { key: 'id', header: 'SQL ID', className: 'mono', render: (s) => doc.label(doc.statements[s.id]), sort: (s) => doc.label(doc.statements[s.id]) },
    { key: 'txt', header: 'Statement', className: 'clip', render: (s) => preview(doc.statements[s.id].text, 70), sort: (s) => doc.statements[s.id].text },
    { key: 'e', header: 'Response', align: 'end', render: (s) => fmtDur(s.elapsed + s.idleUs), sort: (s) => s.elapsed + s.idleUs, bar: true },
    { key: 'pct', header: '%', align: 'end', render: (s) => fmtPct(s.elapsed + s.idleUs, totalUs), sort: (s) => s.elapsed },
    { key: 'x', header: 'Execs', align: 'end', render: (s) => fmtInt(s.executions), sort: (s) => s.executions },
    { key: 'd', header: 'Dep', align: 'end', render: (s) => s.minDepth, sort: (s) => s.minDepth },
  ]
  return <DataTable columns={cols} rows={rows} rowKey={(s) => s.id} maxHeight="30rem" selectedKey={sel} onRowClick={(s) => actions.selectStmt(s.id)} />
}

export function firstSeen(doc: TraceDoc, st: StmtStats): string { return fmtWall(st.firstWallUs, doc.tzOffsetMin) }
