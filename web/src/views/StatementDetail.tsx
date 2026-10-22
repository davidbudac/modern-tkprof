import { useMemo, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import type { ID, StmtStats, CallStats, Plan } from '../data/types'
import { fmtDur, fmtInt, fmtPct, fmtWall, fmtCompact, oraErr, preview } from '../data/format'
import { useStore, actions } from '../app/store'
import { SqlText } from '../components/SqlText'
import { ProfileBar } from '../components/ProfileBar'
import { DataTable, type Column } from '../components/DataTable'
import { statementSegments, executions, bindsOf, bindPreview, type Execution } from '../data/derive'

export function StatementDetail({ doc, id }: { doc: TraceDoc; id: ID }) {
  const st = doc.statements[id]
  const stats = doc.stats.statements[id]
  if (!st || !stats) return <p className="muted">Unknown statement.</p>
  const ctx = st.cursors.length ? doc.contexts[doc.cursors[st.cursors[0]].context] : undefined
  const planHashes = stats.planHashes ?? []
  const assumed = st.cursors.some((c) => doc.cursors[c].assumed)
  return (
    <>
      <dl className="kv">
        <dt>Kind</dt><dd>{st.kind === 0 ? st.commandName : kindName(st.kind)}{st.kind === 0 && ` · depth ${stats.minDepth}${stats.maxDepth !== stats.minDepth ? `–${stats.maxDepth}` : ''}`}</dd>
        {st.kind === 0 && <><dt>Hash</dt><dd className="mono">{st.hashValue}</dd></>}
        {planHashes.length > 0 && <><dt>Plan hash</dt><dd className="mono">{planHashes.join(', ')}</dd></>}
        <dt>Parsed by</dt><dd>user id {st.parsingUserId}{ctx?.module ? ` · module ${ctx.module}` : ''}{ctx?.action ? ` · action ${ctx.action}` : ''}{ctx?.sessionId ? ` · session ${ctx.sessionId}` : ''}</dd>
        <dt>Seen</dt><dd>line {fmtInt(st.firstLine)} · {st.cursors.length} cursor{st.cursors.length === 1 ? '' : 's'}{stats.firstWallUs ? ` · ${fmtWall(stats.firstWallUs, doc.tzOffsetMin)} → ${fmtWall(stats.lastWallUs, doc.tzOffsetMin)}` : ''}</dd>
      </dl>
      {assumed && <p className="callout">A cursor of this statement was open before tracing started; its earlier calls are attributed here (same cursor number), as tkprof does.</p>}
      <SqlText text={st.text} />
      <ResponseTime doc={doc} stats={stats} />
      <CallTable doc={doc} stats={stats} />
      {doc.hasFacts && <Executions doc={doc} id={id} />}
      <Plans doc={doc} id={id} />
      <Links doc={doc} stats={stats} />
      <Errors doc={doc} id={id} />
    </>
  )
}

function kindName(k: number): string { return ['SQL', 'unknown statement', 'commit', 'rollback', 'LOB operation', 'RPC call', 'parse error'][k] ?? '?' }

function ResponseTime({ doc, stats }: { doc: TraceDoc; stats: StmtStats }) {
  const total = stats.elapsed + stats.idleUs
  const segs = useMemo(() => (doc.hasFacts ? statementSegments(doc, stats) : []), [doc, stats])
  return (
    <section className="section">
      <header><h2>Response time {fmtDur(total)}</h2><span className="hint">{fmtPct(total, doc.spanUs())} of the trace · {fmtDur(stats.elapsed)} in calls + {fmtDur(stats.idleUs)} idle between them</span></header>
      {segs.length > 0 && <ProfileBar segments={segs} totalUs={total} compact />}
      {stats.childUs > 0 && <p className="small muted">{fmtDur(stats.childUs)} ({fmtPct(stats.childUs, stats.elapsed)}) of the elapsed time was spent in recursive statements.</p>}
    </section>
  )
}

function CallTable({ doc, stats }: { doc: TraceDoc; stats: StmtStats }) {
  const inclusive = useStore((s) => s.inclusive)
  const rows: { name: string; c: CallStats; res: boolean }[] = [
    { name: 'Parse', c: stats.parse, res: true }, { name: 'Execute', c: stats.exec, res: true }, { name: 'Fetch', c: stats.fetch, res: true },
    { name: 'Close', c: stats.close, res: false }, { name: 'Other', c: stats.other, res: true }, { name: 'Total', c: stats.total, res: true },
  ].filter((r) => r.c.count > 0 || r.name === 'Total')
  const v = (c: CallStats, inc: keyof CallStats, self: keyof CallStats) => (inclusive ? c[inc] : c[self]) as number
  void doc
  return (
    <section className="section">
      <header><h2>Database calls</h2>
        <span className="tools"><span className="seg" role="group" aria-label="Statistics mode">
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

function Executions({ doc, id }: { doc: TraceDoc; id: ID }) {
  const exs = useMemo(() => executions(doc, id), [doc, id])
  const [sel, setSel] = useState<Execution | null>(null)
  if (exs.length === 0) return null
  const cols: Column<Execution>[] = [
    { key: 'n', header: '#', align: 'end', render: (e) => e.execNo, sort: (e) => e.execNo },
    { key: 't', header: 'Start', render: (e) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(e.startTim), doc.tzOffsetMin) : `+${fmtDur(e.startTim - doc.span.firstTim)}`), sort: (e) => e.startTim },
    { key: 'e', header: 'Elapsed', align: 'end', render: (e) => fmtDur(e.e), sort: (e) => e.e, bar: true },
    { key: 'c', header: 'CPU', align: 'end', render: (e) => fmtDur(e.c), sort: (e) => e.c },
    { key: 'w', header: 'Waits', align: 'end', render: (e) => fmtDur(e.waitEla), sort: (e) => e.waitEla },
    { key: 'r', header: 'Rows', align: 'end', render: (e) => fmtCompact(e.r), sort: (e) => e.r },
    { key: 'p', header: 'Disk', align: 'end', render: (e) => fmtCompact(e.p), sort: (e) => e.p },
    { key: 'cr', header: 'Query', align: 'end', render: (e) => fmtCompact(e.cr), sort: (e) => e.cr },
    { key: 'f', header: 'Fetches', align: 'end', render: (e) => e.fetches, sort: (e) => e.fetches },
    { key: 'b', header: 'Binds', className: 'clip mono', render: (e) => bindPreview(doc, e.bindSet), sort: (e) => bindPreview(doc, e.bindSet) },
  ]
  const slow = exs.reduce((a, e) => (e.e > a.e ? e : a), exs[0])
  const avg = exs.reduce((a, e) => a + e.e, 0) / exs.length
  return (
    <section className="section">
      <header><h2>Executions</h2><span className="hint">{exs.length} · avg {fmtDur(avg)} · slowest {fmtDur(slow.e)} (#{slow.execNo})</span></header>
      <DataTable columns={cols} rows={exs} rowKey={(e) => `${e.cursor}:${e.execNo}`} maxHeight="22rem" rowHeight={28}
        selectedKey={sel ? `${sel.cursor}:${sel.execNo}` : null} onRowClick={(e) => setSel(sel && sel.exec === e.exec ? null : e)} />
      {sel && <Binds doc={doc} ex={sel} />}
    </section>
  )
}

function Binds({ doc, ex }: { doc: TraceDoc; ex: Execution }) {
  const binds = bindsOf(doc, ex.bindSet)
  const waits = doc.waitsByCall.get(ex.exec)
  return (
    <div className="section">
      <header><h3>Execution #{ex.execNo}</h3><span className="hint">cursor at line {fmtInt(doc.cursors[ex.cursor]?.line ?? 0)} · EXEC at line {fmtInt(doc.calls.line[ex.exec])} · {waits.length} waits on the EXEC</span></header>
      {binds.length === 0 ? <p className="small muted">No bind values were captured for this execution (trace level without binds, or no binds).</p> : (
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th className="num">pos</th><th>type</th><th>value</th></tr></thead>
          <tbody>{binds.map((b) => (
            <tr key={b.pos}><td className="num">{b.pos}</td><td className="dim">{b.type}{b.mal > 0 ? `[${b.mal}]` : ''}</td>
              <td className="mono text">{b.noDef ? <span className="dim">same as an earlier bind</span> : b.isNull ? <span className="dim">NULL</span> : b.dump ? <span className="dim" title={b.value}>memory dump</span> : b.value}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  )
}

function Plans({ doc, id }: { doc: TraceDoc; id: ID }) {
  const plans = doc.plansOf(id)
  if (plans.length === 0) return null
  const last = new Map<number, Plan>()
  for (const p of plans) last.set(p.planHash, p)
  return (
    <>
      {[...last.values()].map((p) => (
        <section className="section" key={p.id}>
          <header><h2>Plan {p.planHash || ''}</h2><span className="hint">row source statistics from the STAT lines at line {fmtInt(p.line)}{plans.filter((x) => x.planHash === p.planHash).length > 1 ? ` · ${plans.filter((x) => x.planHash === p.planHash).length} dumps, last shown` : ''}</span></header>
          <PlanTable doc={doc} plan={p} />
        </section>
      ))}
    </>
  )
}

function PlanTable({ doc, plan }: { doc: TraceDoc; plan: Plan }) {
  const lines = doc.planLines.slice(plan.first, plan.first + plan.n)
  const maxT = lines.reduce((a, l) => Math.max(a, l.timeUs), 0)
  return (
    <div className="tbl-wrap"><table className="tbl plan">
      <thead><tr><th className="num">id</th><th>operation</th><th className="num">rows</th><th className="num">starts</th><th className="num">cr</th><th className="num">pr</th><th className="num">pw</th><th className="num">time</th><th className="num">cost</th><th className="num">card</th></tr></thead>
      <tbody>{lines.map((l) => (
        <tr key={l.id} className={maxT > 0 && l.timeUs >= 0.5 * maxT ? 'hot' : undefined}>
          <td className="num dim">{l.id}</td>
          <td className="op" style={{ paddingInlineStart: `${0.5 + l.depth * 0.9}rem` }}>{l.op}{l.object && <span className="obj"> {l.object}</span>}</td>
          <td className="num">{fmtCompact(l.rows)}</td><td className="num">{fmtCompact(l.starts)}</td>
          <td className="num">{fmtCompact(l.cr)}</td><td className="num">{fmtCompact(l.pr)}</td><td className="num">{fmtCompact(l.pw)}</td>
          <td className="num"><span className="heat"><i style={{ inlineSize: maxT ? `${(100 * l.timeUs) / maxT}%` : 0 }} /></span>{fmtDur(l.timeUs)}</td>
          <td className="num dim">{l.cost >= 0 ? fmtCompact(l.cost) : ''}</td><td className="num dim">{l.card >= 0 ? fmtCompact(l.card) : ''}</td>
        </tr>
      ))}</tbody>
    </table></div>
  )
}

function Links({ doc, stats }: { doc: TraceDoc; stats: StmtStats }) {
  const children = stats.children ?? [], parents = stats.parents ?? []
  if (children.length === 0 && parents.length === 0) return null
  const row = (l: { statement: ID; calls: number; elapsed: number }, base: number) => {
    const s = doc.statements[l.statement]
    return (
      <tr key={l.statement} className="row-click" onClick={() => actions.selectStmt(l.statement)}>
        <td className="num">{fmtDur(l.elapsed)}</td><td className="num dim">{fmtPct(l.elapsed, base)}</td><td className="num">{fmtInt(l.calls)}</td>
        <td className="mono">{doc.label(s)}</td><td className="clip">{preview(s.text, 60)}</td>
      </tr>
    )
  }
  return (
    <section className="section">
      <header><h2>Recursive relations</h2><span className="hint">click to navigate</span></header>
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th className="num">time</th><th className="num">share</th><th className="num">calls</th><th>sql id</th><th>statement</th></tr></thead>
        <tbody>
          {children.length > 0 && <tr><td colSpan={5} className="dim">executed by this statement (time included above)</td></tr>}
          {children.map((l) => row(l, stats.elapsed))}
          {parents.length > 0 && <tr><td colSpan={5} className="dim">called from</td></tr>}
          {parents.map((l) => row(l, l.elapsed))}
        </tbody>
      </table></div>
    </section>
  )
}

function Errors({ doc, id }: { doc: TraceDoc; id: ID }) {
  const errs = doc.errors.filter((e) => e.statement === id)
  if (errs.length === 0) return null
  return (
    <section className="section">
      <header><h2>Errors</h2></header>
      <ul className="small" style={{ margin: 0, paddingInlineStart: '1.2rem' }}>
        {errs.slice(0, 20).map((e) => <li key={e.id}>{e.parseError ? 'parse error ' : ''}{oraErr(e.err)} at line {fmtInt(e.line)}{e.wallUs ? ` (${fmtWall(e.wallUs, doc.tzOffsetMin)})` : ''}</li>)}
        {errs.length > 20 && <li className="muted">… {errs.length - 20} more</li>}
      </ul>
    </section>
  )
}
