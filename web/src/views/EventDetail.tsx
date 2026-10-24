import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import type { TraceDoc } from '../data/doc'
import { StmtLink } from '../components/StmtLink'
import type { ID } from '../data/types'
import { fmtDur, fmtInt, fmtPct, preview, fmtCompact, fmtWall } from '../data/format'
import { LineRef } from '../components/LineRef'
import { actions, getState, useStore, waitFilter } from '../app/store'
import { Chart } from '../components/Chart'
import { groupBy, logHistogram } from '../data/groupby'
import { cssColor, roleOfClass } from '../components/colors'

const MAX_DOTS = 20000
const KEEP_SLOWEST = 2000

/** At most `cap` of the indices: the slowest waits are always kept, the rest evenly strided. */
function sampleWaits(ids: number[], ela: ArrayLike<number>, cap: number): number[] {
  if (ids.length <= cap) return ids
  const byEla = [...ids].sort((a, b) => ela[b] - ela[a])
  const keep = byEla.slice(0, KEEP_SLOWEST)
  const rest = byEla.slice(KEEP_SLOWEST)
  const stride = rest.length / (cap - KEEP_SLOWEST)
  for (let k = 0; k < cap - KEEP_SLOWEST; k++) keep.push(rest[Math.floor(k * stride)])
  return keep
}

export function EventDetail({ doc, id }: { doc: TraceDoc; id: ID }) {
  const ev = doc.events[id]
  const state = useStore((s) => s)
  const agg = doc.stats.events.find((e) => e.event === id)
  const w = doc.waits
  const filtered = useMemo(() => {
    const wf = waitFilter(state)
    const ids: number[] = []
    for (let i = 0; i < w.n; i++) if (w.event[i] === id && (!wf || wf(i))) ids.push(i)
    return ids
  }, [doc, id, state.window, state.contexts])
  const hist = useMemo(() => logHistogram(filtered.map((i) => w.ela[i])), [filtered])
  const total = filtered.reduce((a, i) => a + w.ela[i], 0)
  const role = roleOfClass(ev.class, ev.idle)
  const histOpt = useMemo<EChartsOption>(() => {
    let lo = 0, hi = hist.counts.length - 1
    while (lo < hi && hist.counts[lo] === 0) lo++
    while (hi > lo && hist.counts[hi] === 0) hi--
    const cats = hist.edges.slice(lo, hi + 1).map((e) => fmtDur(e))
    return {
      grid: { left: 8, right: 12, top: 12, bottom: 24, containLabel: true },
      tooltip: { trigger: 'axis', formatter: (p: unknown) => { const q = (p as { axisValue: string; value: number; dataIndex: number }[])[0]; return `≥ ${q.axisValue}: ${fmtInt(q.value)} waits, ${fmtDur(hist.sums[lo + q.dataIndex])}` } },
      xAxis: { type: 'category', data: cats, axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', minInterval: 1 },
      series: [{ type: 'bar', data: hist.counts.slice(lo, hi + 1), itemStyle: { color: cssColor(role), borderRadius: [3, 3, 0, 0] }, barCategoryGap: '10%' }],
    }
  }, [hist, role])
  // scatter: every wait over trace time, ela on a log axis; the slider sets the global time window
  const linesAvailable = state.linesAvailable
  const allIds = useMemo(() => {
    const wf = waitFilter({ ...state, window: null })
    const ids: number[] = []
    for (let i = 0; i < w.n; i++) if (w.event[i] === id && w.tim[i] && (!wf || wf(i))) ids.push(i)
    return ids
  }, [doc, id, state.contexts, state.includeIdle])
  const dots = useMemo(() => sampleWaits(allIds, w.ela, MAX_DOTS), [allIds])
  const span = doc.spanUs()
  const scatterOpt = useMemo<EChartsOption>(() => {
    const base = doc.span.firstTim
    const label = (v: number) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(base + v), doc.tzOffsetMin) : `+${fmtDur(v)}`)
    const pts = dots.map((i) => [w.tim[i] - w.ela[i] - base, Math.max(w.ela[i], 0.5), i])
    const win = state.window
    return {
      grid: { left: 8, right: 16, top: 12, bottom: 56, containLabel: true },
      tooltip: {
        trigger: 'item',
        formatter: (p: unknown) => {
          const i = (p as { data: number[] }).data[2]
          const st = doc.statements[w.stmt[i]]
          return `${label(w.tim[i] - w.ela[i] - base)}<br><b>${fmtDur(w.ela[i])}</b>${st ? `<br>${doc.label(st)}` : ''}<br>line ${fmtInt(w.line[i])}${linesAvailable ? ' (click to view)' : ''}`
        },
      },
      xAxis: { type: 'value', min: 0, max: span, splitNumber: 5, axisLabel: { hideOverlap: true, formatter: (v: number) => label(v) } },
      yAxis: { type: 'log', logBase: 10, min: (v: { min: number }) => Math.max(0.5, 10 ** Math.floor(Math.log10(v.min))), axisLabel: { formatter: (v: number) => fmtDur(v) } },
      dataZoom: [
        { type: 'slider', xAxisIndex: 0, filterMode: 'none', height: 20, bottom: 6, brushSelect: true, borderColor: 'transparent', fillerColor: 'rgba(120,120,120,0.15)',
          ...(win ? { startValue: win.startTim - base, endValue: win.endTim - base } : { start: 0, end: 100 }) },
        { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
      ],
      series: [{ type: 'scatter', data: pts, large: true, largeThreshold: 2000, symbolSize: 5, itemStyle: { color: cssColor(role), opacity: 0.55 } }],
    }
  }, [dots, doc, role, span, state.window, linesAvailable])
  const scatterEvents = useMemo(() => ({
    datazoom: (p: unknown) => {
      const z = p as { start?: number; end?: number; batch?: { start: number; end: number }[] }
      const start = z.batch?.[0]?.start ?? z.start ?? 0, end = z.batch?.[0]?.end ?? z.end ?? 100
      if (start <= 0 && end >= 100) { if (getState().window) actions.setWindow(null); return }
      actions.setWindow({ startTim: doc.span.firstTim + (span * start) / 100, endTim: doc.span.firstTim + (span * end) / 100 })
    },
    click: (p: unknown) => { const d = (p as { data?: number[] }).data; if (d && getState().linesAvailable) actions.openLines(w.line[d[2]]) },
  }), [doc, span])
  const slowest = useMemo(() => [...filtered].sort((a, b) => w.ela[b] - w.ela[a]).slice(0, 12), [filtered])
  const byStmt = useMemo(() => groupBy({ n: filtered.length, key: (k) => w.stmt[filtered[k]], value: (k) => w.ela[filtered[k]] }).slice(0, 12), [filtered])
  const byObj = useMemo(() => groupBy({ n: filtered.length, key: (k) => { const o = w.obj[filtered[k]]; return o > 0 ? o : NaN }, value: (k) => w.ela[filtered[k]] }).slice(0, 12), [filtered])
  const p1Name = ev.p1Name || 'p1'
  const byP1 = useMemo(() => groupBy({ n: filtered.length, key: (k) => w.p1[filtered[k]], value: (k) => w.ela[filtered[k]] }).slice(0, 12), [filtered])
  const isFile = /file/i.test(p1Name)
  return (
    <>
      <dl className="kv">
        <dt>Class</dt><dd>{ev.class || 'unknown'}{ev.idle ? ' (idle)' : ''}</dd>
        <dt>Parameters</dt><dd className="mono">{[ev.p1Name, ev.p2Name, ev.p3Name].filter(Boolean).join(' · ') || '–'}</dd>
        {agg && <><dt>Whole trace</dt><dd>{fmtInt(agg.count)} waits · {fmtDur(agg.us)} · avg {fmtDur(agg.us / agg.count)} · max {fmtDur(agg.maxUs)}</dd></>}
        {(state.window || state.contexts) && <><dt>In filter</dt><dd>{fmtInt(filtered.length)} waits · {fmtDur(total)}</dd></>}
      </dl>
      {filtered.length > 0 && (
        <section className="section">
          <header><h2>Duration distribution</h2><span className="hint">log scale buckets</span></header>
          <Chart option={histOpt} className="short" />
        </section>
      )}
      {allIds.length > 0 && span > 0 && (
        <section className="section">
          <header><h2>Waits over time</h2><span className="hint">{dots.length < allIds.length ? `${fmtInt(dots.length)} of ${fmtInt(allIds.length)} waits (the ${fmtInt(KEEP_SLOWEST)} slowest + an even sample)` : `${fmtInt(allIds.length)} waits`} · elapsed on a log scale · drag the slider to set the time window</span></header>
          <Chart option={scatterOpt} onEvents={scatterEvents} className="short" />
        </section>
      )}
      {slowest.length > 0 && (
        <section className="section">
          <header><h2>Slowest waits</h2></header>
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>start</th><th className="num">elapsed</th><th>statement</th><th className="num">line</th></tr></thead>
            <tbody>
              {slowest.map((i) => { const st = doc.statements[w.stmt[i]]; const t = w.tim[i] - w.ela[i]; return (
                <tr key={i}>
                  <td>{doc.wallOffsetUs ? fmtWall(doc.wallOf(t), doc.tzOffsetMin) : `+${fmtDur(t - doc.span.firstTim)}`}</td>
                  <td className="num">{fmtDur(w.ela[i])}</td>
                  <td>{st ? <StmtLink doc={doc} id={w.stmt[i]} /> : '–'}</td>
                  <td className="num"><LineRef line={w.line[i]} bare /></td>
                </tr>) })}
            </tbody>
          </table></div>
        </section>
      )}
      {byStmt.length > 0 && (
        <section className="section">
          <header><h2>By statement</h2></header>
          <div className="tbl-wrap"><table className="tbl"><tbody>
            {byStmt.map((a) => { const s = doc.statements[a.key]; return (
              <tr key={a.key} className="row-click" onClick={() => actions.selectStmt(a.key)}>
                <td className="num">{fmtDur(a.sum)}</td><td className="num dim">{fmtPct(a.sum, total)}</td><td className="num">{fmtInt(a.count)}</td>
                <td>{s ? <StmtLink doc={doc} id={a.key} /> : '–'}</td><td className="clip">{s ? preview(s.text, 50) : 'no cursor'}</td>
              </tr>) })}
          </tbody></table></div>
        </section>
      )}
      {byObj.length > 0 && (
        <section className="section">
          <header><h2>By object</h2><span className="hint">{doc.hasRef ? 'obj# from the trace, named from the reference bundle' : 'obj# from the trace; map with dba_objects.object_id, or pass a reference bundle (mtkprof -ref)'}</span></header>
          <div className="tbl-wrap"><table className="tbl"><tbody>
            {byObj.map((a) => <tr key={a.key}><td className="num">{fmtDur(a.sum)}</td><td className="num dim">{fmtPct(a.sum, total)}</td><td className="num">{fmtInt(a.count)}</td><td className="mono">obj# {a.key}{doc.objectName(a.key) && <> <span className="obj">{doc.objectName(a.key)}</span></>}</td></tr>)}
          </tbody></table></div>
        </section>
      )}
      {byP1.length > 1 && (
        <section className="section">
          <header><h2>By {p1Name}</h2>{isFile && <span className="hint">{doc.hasRef ? 'file# from the trace, named from the reference bundle' : 'file# from the trace; map with v$datafile, or pass a reference bundle (mtkprof -ref)'}</span>}</header>
          <div className="tbl-wrap"><table className="tbl"><tbody>
            {byP1.map((a) => <tr key={a.key}><td className="num">{fmtDur(a.sum)}</td><td className="num dim">{fmtPct(a.sum, total)}</td><td className="num">{fmtInt(a.count)}</td><td className="mono">{p1Name} {fmtCompact(a.key)}{isFile && doc.fileName(a.key) && <> <span className="obj" title={doc.fileName(a.key)?.tablespace}>{doc.fileName(a.key)?.name}</span></>}</td></tr>)}
          </tbody></table></div>
        </section>
      )}
    </>
  )
}
