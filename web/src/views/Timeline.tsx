import { useMemo } from 'react'
import * as echarts from 'echarts/core'
import { CustomChart } from 'echarts/charts'
import type { EChartsOption, CustomSeriesRenderItemParams, CustomSeriesRenderItemAPI, CustomSeriesRenderItemReturn } from 'echarts'
import type { TraceDoc } from '../data/doc'
import { CallKind, callKindName, NONE, type ID } from '../data/types'
import { fmtDur, fmtInt, fmtWall, fmtCompact, preview } from '../data/format'
import { useStore, actions, callFilter } from '../app/store'
import { Chart } from '../components/Chart'
import { DataTable, type Column } from '../components/DataTable'
import { resolveVar } from '../components/colors'
import '../styles/timeline.css'

echarts.use([CustomChart])

const MAX_BARS = 20000
const MAX_LANES = 25
const LANE_PX = 26

/** Call kind → color token. The chart legend above the lanes documents this mapping. */
type KindGroup = 'parse' | 'exec' | 'fetch' | 'close' | 'other'
const kindGroups: { id: KindGroup; label: string; token: string }[] = [
  { id: 'parse', label: 'PARSE', token: '--c-sysio' },
  { id: 'exec', label: 'EXEC', token: '--c-cpu' },
  { id: 'fetch', label: 'FETCH', token: '--c-userio' },
  { id: 'close', label: 'CLOSE', token: '--c-idle' },
  { id: 'other', label: 'LOB / commit / RPC', token: '--c-other' },
]
const groupIndex: Record<KindGroup, number> = { parse: 0, exec: 1, fetch: 2, close: 3, other: 4 }

function groupOf(kind: number): KindGroup {
  switch (kind) {
    case CallKind.parse: return 'parse'
    case CallKind.exec: return 'exec'
    case CallKind.fetch: return 'fetch'
    case CallKind.close: return 'close'
    default: return 'other'
  }
}

interface Lane { label: string; stmts: Set<ID> | null } // null = fold-everything-else lane

interface Picked {
  /** [lane, startUs, endUs, callIndex, groupIndex] per bar */
  rows: number[][]
  total: number
  sampled: boolean
  longest: number[] // call indexes, longest first (max 20)
}

export function Timeline({ doc }: { doc: TraceDoc }) {
  const state = useStore((s) => s)
  const win = state.window
  const base = doc.span.firstTim

  // Lanes: top statements by response time, ordered by first call; the rest folded into one lane.
  const lanes = useMemo<{ list: Lane[]; byStmt: Int32Array }>(() => {
    const top = doc.stats.statements
      .filter((s) => s.allCalls.count > 0)
      .sort((a, b) => b.elapsed + b.idleUs - (a.elapsed + a.idleUs))
      .slice(0, MAX_LANES)
      .sort((a, b) => a.firstTim - b.firstTim)
    const list: Lane[] = top.map((s) => {
      const st = doc.statements[s.id]
      return { label: `${doc.label(st)}  ${preview(st.text, 40)}`, stmts: new Set([s.id]) }
    })
    const byStmt = new Int32Array(doc.statements.length).fill(-1)
    top.forEach((s, i) => { byStmt[s.id] = i })
    const rest = doc.statements.length - top.length
    if (rest > 0) {
      list.push({ label: `other statements (${rest})`, stmts: null })
      for (let i = 0; i < byStmt.length; i++) if (byStmt[i] < 0) byStmt[i] = list.length - 1
    }
    return { list, byStmt }
  }, [doc])

  const picked = useMemo<Picked>(() => {
    const c = doc.calls
    const cf = callFilter(state)
    const idx: number[] = []
    for (let i = 0; i < c.n; i++) {
      if (!c.tim[i]) continue
      if (cf && !cf(i)) continue
      idx.push(i)
    }
    const total = idx.length
    let keep = idx
    let sampled = false
    if (total > MAX_BARS) {
      sampled = true
      const es = new Float64Array(total)
      for (let k = 0; k < total; k++) es[k] = c.e[idx[k]]
      es.sort()
      const threshold = es[total - MAX_BARS]
      const above: number[] = [], equal: number[] = []
      for (const i of idx) {
        const e = c.e[i]
        if (e > threshold) above.push(i)
        else if (e === threshold) equal.push(i)
      }
      keep = above.concat(equal.slice(0, MAX_BARS - above.length))
    }
    const rows: number[][] = new Array(keep.length)
    for (let k = 0; k < keep.length; k++) {
      const i = keep[k]
      const end = c.tim[i] - base
      rows[k] = [lanes.byStmt[c.stmt[i]], end - c.e[i], end, i, groupIndex[groupOf(c.kind[i])]]
    }
    // longest calls in the window (from the unsampled set)
    const longest = idx.length <= 20 ? idx.slice() : (() => {
      const es = new Float64Array(total)
      for (let k = 0; k < total; k++) es[k] = c.e[idx[k]]
      const sorted = es.slice().sort()
      const th = sorted[total - 20]
      return idx.filter((i) => c.e[i] >= th)
    })()
    longest.sort((a, b) => c.e[b] - c.e[a])
    return { rows, total, sampled, longest: longest.slice(0, 20) }
  }, [doc, lanes, state.window, state.contexts, base])

  const option = useMemo<EChartsOption>(() => {
    const c = doc.calls
    const span = doc.spanUs()
    const xMin = win ? win.startTim - base : 0
    const xMax = win ? win.endTim - base : span
    const colorCache: string[] = []
    const colorOf = (g: number) => (colorCache[g] ??= resolveVar(kindGroups[g].token))
    const renderItem = (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI): CustomSeriesRenderItemReturn => {
      if (params.dataIndex === 0) colorCache.length = 0 // re-resolve colors on every (re)render, e.g. after a theme switch
      const lane = api.value(0) as number, start = api.value(1) as number, end = api.value(2) as number
      const p0 = api.coord([start, lane]), p1 = api.coord([end, lane])
      const laneH = (api.size!([0, 1]) as number[])[1]
      const h = Math.max(laneH * 0.6, 3)
      const cs = params.coordSys as unknown as { x: number; y: number; width: number; height: number }
      const rect = echarts.graphic.clipRectByRect({ x: p0[0], y: p0[1] - h / 2, width: Math.max(p1[0] - p0[0], 1), height: h }, cs)
      if (!rect) return null as unknown as CustomSeriesRenderItemReturn
      return { type: 'rect', shape: rect, style: api.style({ fill: colorOf(api.value(4) as number) }) }
    }
    return {
      legend: { show: false },
      grid: { left: 8, right: 16, top: 8, bottom: 44, containLabel: true },
      tooltip: {
        trigger: 'item',
        axisPointer: { type: 'none' },
        formatter: (p: unknown) => {
          const d = (p as { data: number[] }).data
          const i = d[3]
          const st = doc.statements[c.stmt[i]]
          const startTim = c.tim[i] - c.e[i]
          const when = doc.wallOffsetUs ? fmtWall(doc.wallOf(startTim), doc.tzOffsetMin, { micros: true }) : `+${fmtDur(startTim - base)}`
          const lines = [
            `<b>${callKindName[c.kind[i]] ?? 'CALL'}</b> ${st ? doc.label(st) : ''}${c.execNo[i] ? ` · exec #${c.execNo[i]}` : ''}`,
            `start ${when}`,
            `elapsed ${fmtDur(c.e[i])} · cpu ${fmtDur(c.c[i])} · rows ${fmtInt(c.r[i])}`,
            `line ${fmtInt(c.line[i])}${c.dep[i] ? ` · depth ${c.dep[i]}` : ''}`,
          ]
          return lines.join('<br>')
        },
      },
      xAxis: { type: 'value', min: xMin, max: xMax, axisLabel: { formatter: (v: number) => fmtDur(v), hideOverlap: true } },
      yAxis: { type: 'category', data: lanes.list.map((l) => l.label), inverse: true, axisLabel: { width: 240, overflow: 'truncate', fontFamily: getComputedStyle(document.body).getPropertyValue('--font-mono') || undefined, fontSize: 11 }, splitLine: { show: true } },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, filterMode: 'weakFilter' },
        { type: 'slider', xAxisIndex: 0, filterMode: 'weakFilter', height: 20, bottom: 6, borderColor: 'transparent', fillerColor: 'rgba(120,120,120,0.15)', labelFormatter: (v: number) => fmtDur(v) },
      ],
      series: [{
        type: 'custom', name: 'calls', renderItem, encode: { x: [1, 2], y: 0 }, data: picked.rows,
        progressive: 5000, progressiveThreshold: 5000, clip: true,
      }],
    }
  }, [doc, lanes, picked, win, base])

  const events = useMemo(() => ({
    click: (p: unknown) => {
      const d = (p as { data?: number[] }).data
      if (!d) return
      const stmt = doc.calls.stmt[d[3]]
      if (stmt !== NONE) actions.selectStmt(stmt)
    },
  }), [doc])

  if (!doc.hasFacts) {
    return (
      <section className="section">
        <header><h2>Timeline</h2></header>
        <p className="callout">This document was generated without fact tables (<code>-facts=false</code>), so individual calls are not available. Re-run <code>mtkprof html</code> or <code>mtkprof serve</code> without that flag to see the timeline.</p>
      </section>
    )
  }

  const height = Math.max(240, lanes.list.length * LANE_PX + 70)
  const c = doc.calls
  const longestCols: Column<number>[] = [
    { key: 'k', header: 'Call', render: (i) => callKindName[c.kind[i]] ?? 'CALL', sort: (i) => c.kind[i] },
    { key: 's', header: 'Statement', className: 'clip', render: (i) => { const st = doc.statements[c.stmt[i]]; return st ? <><span className="mono">{doc.label(st)}</span> {preview(st.text, 60)}</> : '–' }, sort: (i) => c.stmt[i] },
    { key: 't', header: 'Start', render: (i) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(c.tim[i] - c.e[i]), doc.tzOffsetMin) : `+${fmtDur(c.tim[i] - c.e[i] - base)}`), sort: (i) => c.tim[i] - c.e[i] },
    { key: 'e', header: 'Elapsed', align: 'end', render: (i) => fmtDur(c.e[i]), sort: (i) => c.e[i], bar: true },
    { key: 'c', header: 'CPU', align: 'end', render: (i) => fmtDur(c.c[i]), sort: (i) => c.c[i] },
    { key: 'r', header: 'Rows', align: 'end', render: (i) => fmtCompact(c.r[i]), sort: (i) => c.r[i] },
    { key: 'l', header: 'Line', align: 'end', render: (i) => fmtInt(c.line[i]), sort: (i) => c.line[i] },
  ]

  return (
    <>
      <section className="section">
        <header>
          <h2>Timeline</h2>
          <span className="hint">
            {picked.sampled
              ? `showing the ${fmtInt(MAX_BARS)} longest of ${fmtInt(picked.total)} calls; set a window on the Overview to see all of them`
              : `${fmtInt(picked.total)} calls${win ? ' in the selected window' : ''}`}
            {lanes.list.length > MAX_LANES ? ` · top ${MAX_LANES} statements have their own lane` : ''}
          </span>
        </header>
        <div className="lane-legend" role="list" aria-label="Call kinds">
          {kindGroups.map((g) => (
            <span className="k" role="listitem" key={g.id}><i className="swatch" style={{ background: `var(${g.token})` }} />{g.label}</span>
          ))}
        </div>
        {picked.rows.length === 0
          ? <p className="muted small">No calls in the selected window.</p>
          : <div style={{ blockSize: height }}><Chart option={option} className="lanes" onEvents={events} /></div>}
      </section>
      {picked.longest.length > 0 && (
        <section className="section">
          <header><h2>Longest calls</h2><span className="hint">{win ? 'in the selected window' : 'in the whole trace'}; click to open the statement</span></header>
          <DataTable columns={longestCols} rows={picked.longest} rowKey={(i) => i} maxHeight="24rem" rowHeight={28}
            selectedKey={null} onRowClick={(i) => { const s = c.stmt[i]; if (s !== NONE) actions.selectStmt(s) }} />
        </section>
      )}
    </>
  )
}
