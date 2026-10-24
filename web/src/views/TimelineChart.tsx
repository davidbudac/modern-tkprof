import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import type { TraceDoc } from '../data/doc'
import { Chart } from '../components/Chart'
import { useStore, actions, waitFilter } from '../app/store'
import { timeline, pickBucket } from '../data/derive'
import { resolveVar, roleShade, type Role } from '../components/colors'
import { fmtDur, fmtWall } from '../data/format'

/** Stacked activity per time bucket (CPU + waits by event or by class) with a zoom slider that sets the global window. */
export function TimelineChart({ doc, by = 'event' }: { doc: TraceDoc; by?: 'event' | 'class' }) {
  const state = useStore((s) => s)
  const bucketUs = useMemo(() => pickBucket(doc.spanUs()), [doc])
  const data = useMemo(() => timeline(doc, bucketUs, undefined, waitFilter({ ...state, window: null }), by), [doc, bucketUs, by, state.contexts, state.includeIdle])
  const option = useMemo<EChartsOption>(() => {
    const series = data.series.filter((s) => s.values.some((v) => v > 0))
    const nth = new Map<Role, number>()
    const colors = series.map((s) => { const k = nth.get(s.role) ?? 0; nth.set(s.role, k + 1); return roleShade(s.role, k) })
    const labels = data.starts.map((t) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(t), doc.tzOffsetMin) : fmtDur(t - doc.span.firstTim)))
    const bucketSec = bucketUs / 1e6
    return {
      grid: { left: 8, right: 16, top: 36, bottom: 56, containLabel: true },
      legend: { type: 'scroll', data: series.map((s) => s.label), left: 120, right: 0, top: 0, itemGap: 14 },
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const ps = params as { seriesName: string; value: number; axisValue: string; marker: string }[]
          const lines = ps.filter((p) => p.value > 0).map((p) => `${p.marker} ${p.seriesName} <b style="float:right;margin-left:1em">${(100 * p.value / bucketSec).toFixed(0)}%</b>`)
          return `<div>${ps[0]?.axisValue}</div>` + lines.join('<br>')
        },
      },
      xAxis: { type: 'category', data: labels, axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', name: '% of time busy', nameLocation: 'end', nameTextStyle: { align: 'left', padding: [0, 0, 0, -30] }, axisLabel: { formatter: (v: number) => `${Math.round((100 * v) / bucketSec)}%` }, max: bucketSec },
      dataZoom: [{ type: 'slider', height: 20, bottom: 6, brushSelect: true, borderColor: 'transparent', fillerColor: 'rgba(120,120,120,0.15)' }, { type: 'inside' }],
      series: series.map((s, i) => ({
        name: s.label, type: 'bar', stack: 'time', barCategoryGap: '20%',
        itemStyle: { color: colors[i], borderColor: resolveVar('--surface-raised'), borderWidth: 1 },
        data: Array.from(s.values, (v) => Math.round(v) / 1e6),
      })),
    }
  }, [data, doc, bucketUs])
  const events = useMemo(() => ({
    datazoom: (p: unknown) => {
      const z = p as { start?: number; end?: number; batch?: { start: number; end: number }[] }
      const start = z.batch?.[0]?.start ?? z.start ?? 0, end = z.batch?.[0]?.end ?? z.end ?? 100
      if (start <= 0 && end >= 100) { actions.setWindow(null); return }
      const span = doc.spanUs()
      actions.setWindow({ startTim: doc.span.firstTim + (span * start) / 100, endTim: doc.span.firstTim + (span * end) / 100 })
    },
  }), [doc])
  if (data.starts.length === 0) return <p className="muted small">No time information in this trace.</p>
  return <Chart option={option} onEvents={events} />
}
