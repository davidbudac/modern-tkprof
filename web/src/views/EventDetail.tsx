import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import type { TraceDoc } from '../data/doc'
import { StmtLink } from '../components/StmtLink'
import type { ID } from '../data/types'
import { fmtDur, fmtInt, fmtPct, preview, fmtCompact } from '../data/format'
import { actions, useStore, waitFilter } from '../app/store'
import { Chart } from '../components/Chart'
import { groupBy, logHistogram } from '../data/groupby'
import { cssColor, roleOfClass } from '../components/colors'

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
          <header><h2>By object</h2><span className="hint">obj# from the trace; map with dba_objects.object_id</span></header>
          <div className="tbl-wrap"><table className="tbl"><tbody>
            {byObj.map((a) => <tr key={a.key}><td className="num">{fmtDur(a.sum)}</td><td className="num dim">{fmtPct(a.sum, total)}</td><td className="num">{fmtInt(a.count)}</td><td className="mono">obj# {a.key}</td></tr>)}
          </tbody></table></div>
        </section>
      )}
      {byP1.length > 1 && (
        <section className="section">
          <header><h2>By {p1Name}</h2>{isFile && <span className="hint">file# from the trace; map with v$datafile</span>}</header>
          <div className="tbl-wrap"><table className="tbl"><tbody>
            {byP1.map((a) => <tr key={a.key}><td className="num">{fmtDur(a.sum)}</td><td className="num dim">{fmtPct(a.sum, total)}</td><td className="num">{fmtInt(a.count)}</td><td className="mono">{p1Name} {fmtCompact(a.key)}</td></tr>)}
          </tbody></table></div>
        </section>
      )}
    </>
  )
}
