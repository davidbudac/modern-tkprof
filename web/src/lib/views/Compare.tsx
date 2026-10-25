import { useMemo, useState } from 'react'
import type { CompareData } from '../data/load'
import type { TraceDoc } from '../data/doc'
import type { CmpEvent, CmpMetric, CmpStmt } from '../data/types'
import { fmtDur, fmtInt, fmtCompact, preview } from '../data/format'
import { fmtDurDelta, fmtIntDelta, fmtPctDelta, worse } from '../data/delta'
import { traceSegments } from '../data/derive'
import { roleLabel } from '../components/colors'
import { DataTable, type Column } from '../components/DataTable'
import { type Side } from '../state/store'
import { useStore, useActions } from '../state/session'
import '../styles/compare.css'

/** Count metrics where more is worse (the rest are volume: executions, rows, statements). */
const costly = new Set(['parses', 'hardParses', 'disk', 'query', 'current', 'errors'])

const kindName = ['sql', 'unknown', 'commit', 'rollback', 'lob', 'rpc', 'parse error']
const stmtLabel = (d: CmpStmt) => d.sqlId || `(${kindName[d.kind] ?? '?'})`

function fileName(doc: TraceDoc): string { return (doc.file.traceFile || doc.file.path).split(/[\\/]/).pop() ?? '' }

/** B against A: totals, the two profiles, statements and events that changed. */
export function Compare({ data }: { data: CompareData }) {
  const { a, b, diff } = data
  return (
    <>
      <section className="hero">
        <h1>B vs A</h1>
        <p className="lede cmp-files">
          <span><b className="side-tag">A</b> <span className="mono">{fileName(a)}</span></span>
          <span><b className="side-tag">B</b> <span className="mono">{fileName(b)}</span></span>
        </p>
        <Totals totals={diff.totals} />
        <Profiles a={a} b={b} />
      </section>
      <StatementsDelta data={data} />
      <EventsDelta events={diff.events} />
    </>
  )
}

function valueOf(m: CmpMetric, v: number): string { return m.unit === 'us' ? fmtDur(v) : fmtInt(v) }

function Totals({ totals }: { totals: CmpMetric[] }) {
  return (
    <dl className="cmp-totals" aria-label="Totals of A and B">
      {totals.map((m) => {
        const tone = m.unit === 'us' || costly.has(m.key) ? worse(m.delta) : ''
        return (
          <div className="cmp-total" key={m.key}>
            <dt>{m.label}</dt>
            <dd>
              <span className="ab"><small>A</small>{valueOf(m, m.a)}</span>
              <span className="ab"><small>B</small>{valueOf(m, m.b)}</span>
              <span className={'delta ' + tone}>{m.unit === 'us' ? fmtDurDelta(m.delta) : fmtIntDelta(m.delta)} <small>{fmtPctDelta(m.a, m.b)}</small></span>
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

/** Two bars on one time scale, so the longer trace is the longer bar. */
function Profiles({ a, b }: { a: TraceDoc; b: TraceDoc }) {
  const rows = useMemo(() => [a, b].map((doc) => {
    const total = doc.spanUs()
    return { doc, total, segs: traceSegments(doc, undefined, undefined, total).filter((s) => s.us > 0) }
  }), [a, b])
  const longest = Math.max(1, ...rows.map((r) => r.total))
  const roles = [...new Set(rows.flatMap((r) => r.segs.map((s) => s.role)))]
  return (
    <figure className="cmp-bars">
      {rows.map((r, i) => (
        <div className="cmp-bar-row" key={i}>
          <b className="side-tag">{i ? 'B' : 'A'}</b>
          <div className="cmp-bar-slot">
            <div className="cmp-bar" style={{ inlineSize: `${(100 * r.total) / longest}%` }} role="img"
              aria-label={r.segs.map((s) => `${s.label} ${fmtDur(s.us)}`).join(', ')}>
              {r.segs.map((s) => (
                <i key={s.role} className={s.role === 'unaccounted' ? 'unaccounted' : undefined} style={{ flex: `${s.us} 1 0`, background: s.role === 'unaccounted' ? undefined : `var(--c-${s.role})` }}
                  title={`${s.label}: ${fmtDur(s.us)}`} />
              ))}
            </div>
          </div>
          <span className="cmp-bar-total">{fmtDur(r.total)}</span>
        </div>
      ))}
      <figcaption>
        {roles.map((role) => (
          <span className="k" key={role}><i className={'swatch' + (role === 'unaccounted' ? ' unaccounted' : '')} style={{ background: role === 'unaccounted' ? undefined : `var(--c-${role})` }} />{roleLabel[role]}</span>
        ))}
      </figcaption>
    </figure>
  )
}

type Filter = 'all' | 'slower' | 'faster' | 'new' | 'gone' | 'plan'
const filters: { id: Filter; label: string; title: string; test: (d: CmpStmt) => boolean }[] = [
  { id: 'all', label: 'all', title: 'all statements', test: () => true },
  { id: 'slower', label: 'slower', title: 'in both, more elapsed in B', test: (d) => d.status === 'both' && d.dElapsed > 0 },
  { id: 'faster', label: 'faster', title: 'in both, less elapsed in B', test: (d) => d.status === 'both' && d.dElapsed < 0 },
  { id: 'new', label: 'new in B', title: 'only in trace B', test: (d) => d.status === 'onlyB' },
  { id: 'gone', label: 'gone from B', title: 'only in trace A', test: (d) => d.status === 'onlyA' },
  { id: 'plan', label: 'plan changed', title: 'plan hash values differ', test: (d) => d.planChanged },
]

function StatementsDelta({ data }: { data: CompareData }) {
  const actions = useActions()
  const side = useStore((s) => s.side)
  const [filter, setFilter] = useState<Filter>('all')
  const all = data.diff.statements
  const counts = useMemo(() => Object.fromEntries(filters.map((f) => [f.id, all.filter(f.test).length])) as Record<Filter, number>, [all])
  const rows = useMemo(() => all.filter(filters.find((f) => f.id === filter)!.test), [all, filter])

  const open = (d: CmpStmt, to: Side) => { const s = d[to]; if (s) actions.openStmtOn(to, s.id) }
  const openDefault = (d: CmpStmt) => open(d, d[side] ? side : side === 'a' ? 'b' : 'a')
  const perExec = (s: CmpStmt['a']) => (s && s.executions > 0 ? fmtDur(s.perExecUs) : '')
  const columns: Column<CmpStmt>[] = [
    { key: 'id', header: 'SQL ID', className: 'mono', render: (d) => <>{stmtLabel(d)}{d.status !== 'both' && <span className={'chip-q cmp-chip ' + d.status}>{d.status === 'onlyB' ? 'new in B' : 'gone from B'}</span>}</>, sort: stmtLabel },
    { key: 'text', header: 'Statement', className: 'clip', render: (d) => <span title={d.text}>{preview(d.text, 90)}</span>, sort: (d) => d.text },
    { key: 'ea', header: 'A elapsed', align: 'end', render: (d) => (d.a ? fmtDur(d.a.elapsed) : ''), sort: (d) => d.a?.elapsed ?? -1 },
    { key: 'eb', header: 'B elapsed', align: 'end', render: (d) => (d.b ? fmtDur(d.b.elapsed) : ''), sort: (d) => d.b?.elapsed ?? -1 },
    { key: 'd', header: 'Δ', align: 'end', title: 'B − A, elapsed', render: (d) => <span className={'delta ' + worse(d.dElapsed)}>{fmtDurDelta(d.dElapsed)}</span>, sort: (d) => d.dElapsed },
    { key: 'p', header: 'Δ%', align: 'end', render: (d) => <span className={'delta ' + worse(d.dElapsed)}>{fmtPctDelta(d.a?.elapsed ?? 0, d.b?.elapsed ?? 0)}</span>, sort: (d) => (d.a && d.a.elapsed ? d.dElapsed / d.a.elapsed : d.dElapsed > 0 ? Infinity : 0) },
    { key: 'x', header: 'Execs A → B', align: 'end', render: (d) => `${d.a ? fmtInt(d.a.executions) : '–'} → ${d.b ? fmtInt(d.b.executions) : '–'}`, sort: (d) => d.dExecutions },
    { key: 'pa', header: 'Per exec A', align: 'end', render: (d) => perExec(d.a), sort: (d) => d.a?.perExecUs ?? -1 },
    { key: 'pb', header: 'Per exec B', align: 'end', render: (d) => perExec(d.b), sort: (d) => d.b?.perExecUs ?? -1 },
    { key: 'io', header: 'Δ disk', align: 'end', title: 'B − A, disk reads (blocks)', render: (d) => <span className={'delta ' + worse(d.dDisk)}>{d.dDisk ? (d.dDisk > 0 ? '+' : '−') + fmtCompact(Math.abs(d.dDisk)) : '0'}</span>, sort: (d) => d.dDisk },
    { key: 'plan', header: 'Plan', render: (d) => (d.planChanged ? <span className="chip-q cmp-chip plan" title={`${d.a?.planHashes.join(', ')} → ${d.b?.planHashes.join(', ')}`}>changed</span> : ''), sort: (d) => (d.planChanged ? 1 : 0) },
    { key: 'open', header: 'Open', render: (d) => (
      <span className="cmp-open" onClick={(e) => e.stopPropagation()}>
        <button disabled={!d.a} onClick={() => open(d, 'a')} title="open in trace A">A</button>
        <button disabled={!d.b} onClick={() => open(d, 'b')} title="open in trace B">B</button>
      </span>
    ) },
  ]
  return (
    <section className="section">
      <header>
        <h2>Statements</h2>
        <span className="hint">{all.length} matched by sql_id · by |Δ elapsed| · elapsed incl. recursive children, excl. think time</span>
        <span className="tools"><span className="seg" role="group" aria-label="Statement filter">
          {filters.map((f) => <button key={f.id} aria-pressed={filter === f.id} title={f.title} onClick={() => setFilter(f.id)}>{f.label} {counts[f.id]}</button>)}
        </span></span>
      </header>
      <DataTable key={filter} columns={columns} rows={rows} rowKey={(d) => d.key} onRowClick={openDefault} rowHeight={30} maxHeight="26rem" empty="No statements in this group" />
    </section>
  )
}

function EventsDelta({ events }: { events: CmpEvent[] }) {
  const rows = useMemo(() => events.filter((e) => e.a.us !== 0 || e.b.us !== 0 || e.a.count !== 0 || e.b.count !== 0), [events])
  const columns: Column<CmpEvent>[] = [
    { key: 'n', header: 'Wait event', render: (e) => <>{e.name}{e.idle && <span className="dim"> (idle)</span>}</>, sort: (e) => e.name },
    { key: 'c', header: 'Class', className: 'dim', render: (e) => e.class, sort: (e) => e.class },
    { key: 'a', header: 'A time', align: 'end', render: (e) => fmtDur(e.a.us), sort: (e) => e.a.us },
    { key: 'b', header: 'B time', align: 'end', render: (e) => fmtDur(e.b.us), sort: (e) => e.b.us },
    { key: 'd', header: 'Δ', align: 'end', render: (e) => <span className={'delta ' + (e.idle ? '' : worse(e.deltaUs))}>{fmtDurDelta(e.deltaUs)}</span>, sort: (e) => e.deltaUs },
    { key: 'p', header: 'Δ%', align: 'end', render: (e) => <span className={'delta ' + (e.idle ? '' : worse(e.deltaUs))}>{fmtPctDelta(e.a.us, e.b.us)}</span>, sort: (e) => (e.a.us ? e.deltaUs / e.a.us : e.deltaUs > 0 ? Infinity : 0) },
    { key: 'na', header: 'A waits', align: 'end', render: (e) => fmtInt(e.a.count), sort: (e) => e.a.count },
    { key: 'nb', header: 'B waits', align: 'end', render: (e) => fmtInt(e.b.count), sort: (e) => e.b.count },
    { key: 'aa', header: 'A avg', align: 'end', render: (e) => (e.a.count ? fmtDur(e.a.us / e.a.count) : ''), sort: (e) => (e.a.count ? e.a.us / e.a.count : -1) },
    { key: 'ab', header: 'B avg', align: 'end', render: (e) => (e.b.count ? fmtDur(e.b.us / e.b.count) : ''), sort: (e) => (e.b.count ? e.b.us / e.b.count : -1) },
  ]
  return (
    <section className="section">
      <header><h2>Wait events</h2><span className="hint">{rows.length} matched by name · by |Δ time| · idle events uncoloured</span></header>
      <DataTable columns={columns} rows={rows} rowKey={(e) => e.name} rowHeight={30} maxHeight="22rem" empty="No wait events" />
    </section>
  )
}
