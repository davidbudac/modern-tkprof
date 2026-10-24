import { Fragment, useEffect, useMemo, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import type { ID, StmtStats, CallStats, Plan } from '../data/types'
import { fmtDur, fmtInt, fmtPct, fmtWall, fmtCompact, oraErr } from '../data/format'
import { useStore, actions } from '../app/store'
import { SqlText } from '../components/SqlText'
import { ProfileBar } from '../components/ProfileBar'
import { DataTable, type Column } from '../components/DataTable'
import { bindsOf, previewOfBinds, type Execution } from '../data/derive'
import { sourceOf, useSourceQuery } from '../data/source'
import type { Segment } from '../components/ProfileBar'
import { LineRef } from '../components/LineRef'
import { ColumnChooser } from '../components/ColumnChooser'
import { usePersisted } from '../app/persist'
import { ExecCompare } from './ExecCompare'
import { planRows, planVizUrl, planVizOverride, setPlanVizOverride, canGzip, DEFAULT_PLAN_VIZ, MAX_LINK_CHARS } from '../data/planviz'

export function StatementDetail({ doc, id }: { doc: TraceDoc; id: ID }) {
  const st = doc.statements[id]
  const stats = doc.stats.statements[id]
  if (!st || !stats) return <p className="muted">Unknown statement.</p>
  const planHashes = stats.planHashes ?? []
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(st.text); setCopied(true); setTimeout(() => setCopied(false), 1200) } catch { /* clipboard unavailable */ }
  }
  return (
    <>
      <div className="title">
        <h1 className="mono">{doc.label(st)}</h1>
        <span className="chip-q">{st.kind === 0 ? st.commandName || 'SQL' : kindName(st.kind)}</span>
        <span className="chip-q">depth {stats.minDepth}{stats.maxDepth !== stats.minDepth ? `–${stats.maxDepth}` : ''}</span>
        {planHashes.map((h) => <span key={h} className="chip-q">plan {h}</span>)}
        {st.kind === 0 && <span className="chip-q" title="hash value">hv {st.hashValue}</span>}
        <span className="acts"><button onClick={copy}>{copied ? 'Copied' : 'Copy SQL'}</button></span>
      </div>
      <SqlText text={st.text} />
      <ResponseTime doc={doc} stats={stats} />
      <CallTable doc={doc} stats={stats} />
      {sourceOf(doc).ready && <Executions doc={doc} id={id} />}
      <Plans doc={doc} id={id} />
      {st.refPlan && (
        <section className="section">
          <details>
            <summary><b>DBMS_XPLAN from ref bundle</b> <span className="hint">plans/{st.sqlId}.txt</span></summary>
            <pre className="mono small" style={{ overflowX: 'auto' }}>{st.refPlan}</pre>
          </details>
        </section>
      )}
      <Errors doc={doc} id={id} />
    </>
  )
}

function kindName(k: number): string { return ['SQL', 'unknown statement', 'commit', 'rollback', 'LOB operation', 'RPC call', 'parse error'][k] ?? '?' }

function ResponseTime({ doc, stats }: { doc: TraceDoc; stats: StmtStats }) {
  const total = stats.elapsed + stats.idleUs
  const source = sourceOf(doc)
  const waitsQ = useSourceQuery(source, `waits:${stats.id}`, (signal) => (source.ready ? source.stmtWaits([stats.id], 4, signal) : null), 'waits')
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
  if (trips) notes.push(`${fmtInt(trips.count)} round trip${trips.count === 1 ? '' : 's'} to the client, ${fmtDur(trips.us)} idle`)
  if (stats.pxSessions) notes.push(`PX slaves: ${stats.pxSessions} session${stats.pxSessions === 1 ? '' : 's'}, ${fmtDur(stats.pxEla ?? 0)} (own sessions, not included above)`)
  if (stats.childUs > 0) notes.push(`${fmtDur(stats.childUs)} (${fmtPct(stats.childUs, stats.elapsed)}) in recursive statements`)
  return (
    <section className="section">
      <header><h2>Response time {fmtDur(total)}</h2><span className="hint">{fmtPct(total, doc.spanUs())} of the trace · {fmtDur(stats.elapsed)} in calls + {fmtDur(stats.idleUs)} idle between them</span></header>
      {source.ready && waitsQ.data ? <ProfileBar segments={segs} totalUs={total} /> : <ProfileBar segments={[{ role: 'cpu', label: 'CPU', us: stats.cpu }, { role: 'other', label: 'Waits', us: stats.waitUs }, { role: 'idle', label: 'Idle', us: stats.idleUs }]} totalUs={total} />}
      {notes.length > 0 && <p className="small muted">{notes.join(' · ')}</p>}
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
  const source = sourceOf(doc)
  const page = useSourceQuery(source, `executions:${id}`, (signal) => source.executions(id, signal), 'executions')
  const exs = useMemo(() => page.data?.rows ?? [], [page.data])
  const [hidden, setHidden] = usePersisted<string[]>('mtkprof.cols.executions', [])
  const wanted = useStore((s) => s.selection.exec)
  const [sel, setSel] = useState<Execution | null>(null)
  const [picked, setPicked] = useState<string[]>([]) // up to two execution keys: A (older pick) and B
  useEffect(() => { if (wanted) { const e = exs.find((x) => x.cursor === wanted.cursor && x.execNo === wanted.execNo); if (e) setSel(e) } }, [wanted, exs])
  useEffect(() => setPicked([]), [id, doc])
  if (!page.data) {
    return page.error ? <section className="section"><header><h2>Executions</h2></header><p className="callout">{page.error}</p></section>
      : page.loading ? <section className="section"><header><h2>Executions</h2><span className="hint">loading…</span></header></section> : null
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
    { key: 'l', header: 'Line', align: 'end', title: 'trace line of the EXEC call', render: (e) => <LineRef line={e.line} file={doc.fileOfCursor(e.cursor)} bare />, sort: (e) => e.line },
  ]
  const cols = [pickCol, ...all.filter((c) => c.key === 'n' || !hidden.includes(c.key))]
  const { total, avgE: avg, slowest: slow } = page.data
  return (
    <section className="section">
      <header><h2>Executions</h2><span className="hint">{page.data.partial ? `the ${exs.length} slowest of ${total}` : total} · avg {fmtDur(avg)} · slowest {fmtDur(slow?.e ?? 0)} (#{slow?.execNo}){exs.length > 1 && ' · tick two to compare them'}</span>
        <span className="tools"><ColumnChooser all={all.filter((c) => c.key !== 'n').map((c) => ({ key: c.key, label: c.header }))} hidden={hidden} onChange={setHidden} /></span></header>
      <DataTable columns={cols} rows={exs} rowKey={(e) => `${e.cursor}:${e.execNo}`} maxHeight="22rem" rowHeight={28}
        selectedKey={sel ? `${sel.cursor}:${sel.execNo}` : null} onRowClick={(e, ev) => (ev?.shiftKey ? togglePick(e) : setSel(sel && sel.exec === e.exec ? null : e))} />
      {pa && pb ? <ExecCompare doc={doc} stmt={id} a={pa} b={pb} onClear={() => setPicked([])} /> : sel && <Binds doc={doc} stmt={id} ex={sel} />}
    </section>
  )
}

function Binds({ doc, stmt, ex }: { doc: TraceDoc; stmt: ID; ex: Execution }) {
  const source = sourceOf(doc)
  const detail = useSourceQuery(source, `detail:${stmt}:${ex.cursor}:${ex.execNo}`, (signal) => source.executionDetail(stmt, ex, signal), 'detail')
  const d = detail.data
  const binds = d?.binds ?? []
  const file = doc.fileOfCursor(ex.cursor)
  return (
    <div className="section">
      <header><h3>Execution #{ex.execNo}</h3><span className="hint">cursor at <LineRef line={doc.cursors[ex.cursor]?.line ?? 0} file={file} /> · EXEC at <LineRef line={ex.line} file={file} />{d && d.bindLine > 0 && <> · binds at <LineRef line={d.bindLine} file={file} /></>}{d ? ` · ${d.execWaits} waits on the EXEC` : detail.loading ? ' · loading…' : ''}</span></header>
      {detail.error ? <p className="callout">{detail.error}</p> : !d ? null : binds.length === 0 ? <p className="small muted">No bind values were captured for this execution (trace level without binds, or no binds).</p> : (
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th className="num">pos</th><th>type</th><th>value</th></tr></thead>
          <tbody>{binds.map((b) => (
            <tr key={b.pos}><td className="num">{b.pos}</td><td className="dim">{b.type}{b.mal > 0 ? `[${b.mal}]` : ''}</td>
              <td className="mono text" title={b.typed}>{b.noDef ? <span className="dim">same as an earlier bind</span> : b.isNull ? <span className="dim">NULL</span> : b.dump ? <span className="dim" title={b.value}>memory dump</span> : b.value}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  )
}

function Plans({ doc, id }: { doc: TraceDoc; id: ID }) {
  const plans = doc.plansOf(id)
  if (plans.length === 0) return null
  const byHash = new Map<number, Plan[]>()
  for (const p of plans) { const l = byHash.get(p.planHash); if (l) l.push(p); else byHash.set(p.planHash, [p]) }
  return <>{[...byHash.entries()].map(([h, dumps]) => <PlanSection key={`${id}:${h}`} doc={doc} hash={h} dumps={dumps} />)}</>
}

type Link = { state: 'pending' } | { state: 'ok'; url: string } | { state: 'big' } | { state: 'nogzip' }

function PlanSection({ doc, hash, dumps }: { doc: TraceDoc; hash: number; dumps: Plan[] }) {
  const [pick, setPick] = useState(dumps.length - 1) // latest by default
  const plan = dumps[Math.min(pick, dumps.length - 1)]
  const [override, setOverride] = useState(planVizOverride)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const base = override || doc.planViz || DEFAULT_PLAN_VIZ
  const rows = useMemo(() => planRows(doc, plan), [doc, plan])
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
    <section className="section">
      <header>
        <h2>Plan {hash || ''}</h2>
        <span className="hint">row source statistics from the STAT lines at <LineRef line={plan.line} file={doc.fileOfCursor(plan.cursor)} />{dumps.length > 1 ? ` · ${dumps.length} dumps` : ''}</span>
        {plan.xPlanMatched && <span className="hint">predicates and estimates overlaid from ref bundle</span>}
        <span className="tools plan-acts">
          {dumps.length > 1 && (
            <label className="small muted">dump:{' '}
              <select value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="Plan dump">
                {dumps.map((d, i) => <option key={d.id} value={i}>{i === dumps.length - 1 ? `latest (line ${fmtInt(d.line)})` : `#${i + 1} · line ${fmtInt(d.line)}`}</option>)}
              </select>
            </label>
          )}
          {link.state === 'ok'
            ? <a className="btn" href={link.url} target="_blank" rel="noopener" title={`opens ${base} with the plan in the URL fragment only`}>Open in plan viz ↗</a>
            : <button disabled title={link.state === 'big' ? 'plan too large for a link' : link.state === 'nogzip' ? 'this browser has no CompressionStream' : 'encoding…'}>Open in plan viz ↗</button>}
          <button onClick={copyJson} title="the plan as the visualizer's JSON row array">{copied ? 'Copied' : 'Copy JSON'}</button>
          <button className={`quiet${editing ? ' on' : ''}`} aria-label="Plan viz URL" title={`plan viz URL: ${base}`} aria-expanded={editing} onClick={() => { setDraft(override); setEditing(!editing) }}>⚙</button>
        </span>
      </header>
      {link.state === 'big' && <p className="small plan-note">plan too large for a link ({rows.length} rows) — use “Copy JSON” and paste it into the visualizer.</p>}
      {link.state === 'nogzip' && <p className="small plan-note">This browser cannot compress the link — use “Copy JSON” and paste it into the visualizer.</p>}
      {editing && (
        <form className="plan-cfg" onSubmit={(e) => { e.preventDefault(); save(draft) }}>
          <label className="small muted" htmlFor={`pv-${plan.id}`}>plan viz URL</label>
          <input id={`pv-${plan.id}`} type="text" value={draft} placeholder={doc.planViz || DEFAULT_PLAN_VIZ} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          <button type="submit">Save</button>
          <button type="button" onClick={() => { setDraft(''); save('') }}>reset to default</button>
          <span className="small muted">stored in this browser (localStorage); the plan is sent only in the URL fragment.</span>
        </form>
      )}
      <PlanTable doc={doc} plan={plan} />
    </section>
  )
}

function PlanTable({ doc, plan }: { doc: TraceDoc; plan: Plan }) {
  const lines = doc.planLines.slice(plan.first, plan.first + plan.n)
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
            <tr className={maxT > 0 && l.timeUs >= 0.5 * maxT ? 'hot' : undefined}>
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
