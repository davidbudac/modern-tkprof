import { useMemo } from 'react'
import { isBlockIO } from '../data/iomap'
import { ctxKey } from '../data/fileset'
import type { EChartsOption } from 'echarts'
import type { TraceDoc } from '../data/doc'
import { StmtLink } from '../components/StmtLink'
import type { ID } from '../data/types'
import { fmtDur, fmtInt, fmtPct, preview, fmtCompact, fmtWall } from '../data/format'
import { LineRef } from '../components/LineRef'
import { scopeOf } from '../state/store'
import { useStore, useActions, useStoreApi } from '../state/session'
import { sourceOf, useSourceQuery, KEEP_SLOWEST, type KeyAgg } from '../data/source'
import { Chart } from '../components/Chart'
import { cssColor, roleOfClass } from '../components/colors'

const scopeKey = (s: ReturnType<typeof scopeOf>, window = true) =>
  `${window && s.window ? `${s.window.startTim}:${s.window.endTim}` : ''}|${ctxKey(s.contexts)}|${s.includeIdle ? 1 : 0}`

export function EventDetail({ doc, id }: { doc: TraceDoc; id: ID }) {
  const actions = useActions()
  const store = useStoreApi()
  const ev = doc.events[id]
  const state = useStore((s) => s)
  const source = sourceOf(doc)
  const agg = doc.stats.events.find((e) => e.event === id)
  const scope = scopeOf(state)
  const noWindow = { ...scope, window: null }
  const k = `${id}:${scopeKey(scope)}`
  const histQ = useSourceQuery(source, `hist:${k}`, (signal) => (source.ready ? source.waitHist(id, scope, signal) : null), `hist:${id}`)
  const scatterQ = useSourceQuery(source, `scatter:${id}:${scopeKey(noWindow, false)}`, (signal) => (source.ready ? source.waitScatter(id, noWindow, signal) : null), `scatter:${id}`)
  const slowestQ = useSourceQuery(source, `slowest:${k}`, (signal) => (source.ready ? source.waitTop(id, scope, 12, signal) : null), `slowest:${id}`)
  const byStmtQ = useSourceQuery(source, `bystmt:${k}`, (signal) => (source.ready ? source.waitsBy(id, scope, 'stmt', 12, signal) : null), `bystmt:${id}`)
  const byObjQ = useSourceQuery(source, `byobj:${k}`, (signal) => (source.ready ? source.waitsBy(id, scope, 'obj', 12, signal) : null), `byobj:${id}`)
  const byP1Q = useSourceQuery(source, `byp1:${k}`, (signal) => (source.ready ? source.waitsBy(id, scope, 'p1', 12, signal) : null), `byp1:${id}`)
  const hist = useMemo(() => {
    const h = histQ.data
    return h ? { edges: h.counts.map((_, i) => 2 ** i), counts: h.counts, sums: h.sums } : { edges: [] as number[], counts: [] as number[], sums: [] as number[] }
  }, [histQ.data])
  const filteredCount = histQ.data?.count ?? 0
  const total = histQ.data?.us ?? 0
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
  const allCount = scatterQ.data?.total ?? 0
  const dots = useMemo(() => scatterQ.data?.points ?? [], [scatterQ.data])
  const span = doc.spanUs()
  const scatterOpt = useMemo<EChartsOption>(() => {
    const base = doc.span.firstTim
    const label = (v: number) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(base + v), doc.tzOffsetMin) : `+${fmtDur(v)}`)
    const pts = dots.map((d, i) => [d.tim - d.ela - base, Math.max(d.ela, 0.5), i])
    const win = state.window
    return {
      grid: { left: 8, right: 16, top: 12, bottom: 56, containLabel: true },
      tooltip: {
        trigger: 'item',
        formatter: (p: unknown) => {
          const d = dots[(p as { data: number[] }).data[2]]
          if (!d) return ''
          const st = doc.statements[d.stmt]
          return `${label(d.tim - d.ela - base)}<br><b>${fmtDur(d.ela)}</b>${st ? `<br>${doc.label(st)}` : ''}<br>line ${fmtInt(d.line)}${linesAvailable ? ' (click to view)' : ''}`
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
      if (start <= 0 && end >= 100) { if (store.getState().window) actions.setWindow(null); return }
      actions.setWindow({ startTim: doc.span.firstTim + (span * start) / 100, endTim: doc.span.firstTim + (span * end) / 100 })
    },
    click: (p: unknown) => { const d = (p as { data?: number[] }).data; if (d && store.getState().linesAvailable) actions.openLines(dots[d[2]].line, dots[d[2]].file ?? doc.fileOfStmt(dots[d[2]].stmt)) },
  }), [doc, span, dots])
  const slowest = slowestQ.data ?? []
  const byStmt: KeyAgg[] = byStmtQ.data ?? []
  const byObj: KeyAgg[] = byObjQ.data ?? []
  const p1Name = ev.p1Name || 'p1'
  const byP1: KeyAgg[] = byP1Q.data ?? []
  const isFile = /file/i.test(p1Name)
  return (
    <>
      <dl className="kv">
        <dt>Class</dt><dd>{ev.class || 'unknown'}{ev.idle ? ' (idle)' : ''}</dd>
        <dt>Parameters</dt><dd className="mono">{[ev.p1Name, ev.p2Name, ev.p3Name].filter(Boolean).join(' · ') || '–'}</dd>
        {source.ready && isBlockIO(ev) && <><dt>Blocks</dt><dd><button type="button" className="link" onClick={() => actions.showBlocks({ event: id })} title="the Blocks view, filtered to this event">the file blocks these waits read or wrote</button></dd></>}
        {agg && <><dt>Whole trace</dt><dd>{fmtInt(agg.count)} waits · {fmtDur(agg.us)} · avg {fmtDur(agg.us / agg.count)} · max {fmtDur(agg.maxUs)}</dd></>}
        {(state.window || state.contexts || state.files) && <><dt>In filter</dt><dd>{fmtInt(filteredCount)} waits · {fmtDur(total)}</dd></>}
      </dl>
      {filteredCount > 0 && (
        <section className="section">
          <header><h2>Duration distribution</h2><span className="hint">log-scale buckets</span></header>
          <Chart option={histOpt} className="short" />
        </section>
      )}
      {allCount > 0 && span > 0 && (
        <section className="section">
          <header><h2>Waits over time</h2><span className="hint">{dots.length < allCount ? `${fmtInt(dots.length)} of ${fmtInt(allCount)} waits (${fmtInt(KEEP_SLOWEST)} slowest + even sample)` : `${fmtInt(allCount)} waits`} · log scale · slider: set window</span></header>
          <Chart option={scatterOpt} onEvents={scatterEvents} className="short" />
        </section>
      )}
      {slowest.length > 0 && (
        <section className="section">
          <header><h2>Slowest waits</h2></header>
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>start</th><th className="num">elapsed</th><th>statement</th><th className="num">line</th></tr></thead>
            <tbody>
              {slowest.map((x, k) => { const st = doc.statements[x.stmt]; const t = x.tim - x.ela; return (
                <tr key={k}>
                  <td>{doc.wallOffsetUs ? fmtWall(doc.wallOf(t), doc.tzOffsetMin) : `+${fmtDur(t - doc.span.firstTim)}`}</td>
                  <td className="num">{fmtDur(x.ela)}</td>
                  <td>{st ? <StmtLink doc={doc} id={x.stmt} /> : '–'}</td>
                  <td className="num"><LineRef line={x.line} file={x.file ?? doc.fileOfStmt(x.stmt)} bare /></td>
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
          <header><h2>By object</h2><span className="hint">{doc.hasRef ? 'names: ref bundle' : 'obj# = dba_objects.object_id; names need -ref'}</span></header>
          <div className="tbl-wrap"><table className="tbl"><tbody>
            {byObj.map((a) => <tr key={a.key}><td className="num">{fmtDur(a.sum)}</td><td className="num dim">{fmtPct(a.sum, total)}</td><td className="num">{fmtInt(a.count)}</td><td className="mono">obj# {a.key}{doc.objectName(a.key) && <> <span className="obj">{doc.objectName(a.key)}</span></>}</td></tr>)}
          </tbody></table></div>
        </section>
      )}
      {byP1.length > 1 && (
        <section className="section">
          <header><h2>By {p1Name}</h2>{isFile && <span className="hint">{doc.hasRef ? 'names: ref bundle' : 'file# = v$datafile.file#; names need -ref'}</span>}</header>
          <div className="tbl-wrap"><table className="tbl"><tbody>
            {byP1.map((a) => <tr key={a.key}><td className="num">{fmtDur(a.sum)}</td><td className="num dim">{fmtPct(a.sum, total)}</td><td className="num">{fmtInt(a.count)}</td><td className="mono">{p1Name} {fmtCompact(a.key)}{isFile && doc.fileName(a.key) && <> <span className="obj" title={doc.fileName(a.key)?.tablespace}>{doc.fileName(a.key)?.name}</span></>}</td></tr>)}
          </tbody></table></div>
        </section>
      )}
    </>
  )
}
