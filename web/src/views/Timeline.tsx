import { useMemo } from 'react'
import * as echarts from 'echarts/core'
import { CustomChart } from 'echarts/charts'
import type { EChartsOption, CustomSeriesRenderItemParams, CustomSeriesRenderItemAPI, CustomSeriesRenderItemReturn } from 'echarts'
import type { TraceDoc } from '../data/doc'
import { StmtLink } from '../components/StmtLink'
import { LineRef } from '../components/LineRef'
import { CallKind, callKindName, NONE, type ID } from '../data/types'
import { fmtDur, fmtInt, fmtWall, fmtCompact, preview } from '../data/format'
import { useStore, actions, scopeOf } from '../app/store'
import { sourceOf, useSourceQuery, type Bar } from '../data/source'
import { Chart } from '../components/Chart'
import { DataTable, type Column } from '../components/DataTable'
import { resolveVar } from '../components/colors'
import '../styles/timeline.css'

echarts.use([CustomChart])

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

  const source = sourceOf(doc)
  const scope = scopeOf(state)
  const query = useSourceQuery(source, `${scope.window ? `${scope.window.startTim}:${scope.window.endTim}` : ''}|${scope.contexts ? [...scope.contexts].sort((a, b) => a - b).join(',') : ''}`,
    (signal) => (source.ready ? source.calls(scope, signal) : null), 'calls')
  const picked = useMemo(() => {
    const p = query.data
    if (!p) return null
    // [lane, startUs, endUs, bar index, group] per bar
    const rows = p.bars.map((b, k) => [lanes.byStmt[b.stmt], b.tim - b.e - base, b.tim - base, k, groupIndex[groupOf(b.kind)]])
    return { rows, bars: p.bars, total: p.total, sampled: p.sampled, longest: p.longest }
  }, [query.data, lanes, base])

  const option = useMemo<EChartsOption>(() => {
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
          const b = picked?.bars[d[3]]
          if (!b) return ''
          const st = doc.statements[b.stmt]
          const startTim = b.tim - b.e
          const when = doc.wallOffsetUs ? fmtWall(doc.wallOf(startTim), doc.tzOffsetMin, { micros: true }) : `+${fmtDur(startTim - base)}`
          const lines = [
            `<b>${callKindName[b.kind] ?? 'CALL'}</b> ${st ? doc.label(st) : ''}${b.execNo ? ` · exec #${b.execNo}` : ''}`,
            `start ${when}`,
            `elapsed ${fmtDur(b.e)} · cpu ${fmtDur(b.c)} · rows ${fmtInt(b.r)}`,
            `line ${fmtInt(b.line)}${b.dep ? ` · depth ${b.dep}` : ''}`,
          ]
          return lines.join('<br>')
        },
      },
      xAxis: { type: 'value', min: xMin, max: xMax, axisLabel: { formatter: (v: number) => fmtDur(v), hideOverlap: true } },
      yAxis: { type: 'category', data: lanes.list.map((l) => l.label), inverse: true, triggerEvent: true, axisLabel: {  width: 240, overflow: 'truncate', fontFamily: getComputedStyle(document.body).getPropertyValue('--font-mono') || undefined, fontSize: 11 }, splitLine: { show: true } },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, filterMode: 'weakFilter' },
        { type: 'slider', xAxisIndex: 0, filterMode: 'weakFilter', height: 20, bottom: 6, borderColor: 'transparent', fillerColor: 'rgba(120,120,120,0.15)', labelFormatter: (v: number) => fmtDur(v) },
      ],
      series: [{
        type: 'custom', name: 'calls', renderItem, encode: { x: [1, 2], y: 0 }, data: picked?.rows ?? [],
        progressive: 5000, progressiveThreshold: 5000, clip: true,
      }],
    }
  }, [doc, lanes, picked, win, base])

  const events = useMemo(() => ({
    click: (p: unknown) => {
      const e = p as { componentType?: string; value?: string; data?: number[] }
      if (e.componentType === 'yAxis') { // lane label: the statement's sql_id
        const one = lanes.list.find((l) => l.label === e.value)?.stmts
        if (one?.size === 1) actions.selectStmt([...one][0])
        return
      }
      const d = e.data
      if (!d) return
      const stmt = picked?.bars[d[3]]?.stmt
      if (stmt !== undefined && stmt !== NONE) actions.selectStmt(stmt)
    },
  }), [lanes, picked])

  if (!source.ready) {
    return (
      <section className="section">
        <header><h2>Timeline</h2></header>
        <p className="callout">This document was generated without fact tables (<code>-facts=false</code>), so individual calls are not available. Re-run <code>mtkprof html</code> or <code>mtkprof serve</code> without that flag, or use <code>mtkprof serve -facts=false</code> to have the server slice them, to see the timeline.</p>
      </section>
    )
  }
  if (!picked) {
    return (
      <section className="section">
        <header><h2>Timeline</h2><span className="hint">{query.error ? `failed: ${query.error}` : 'loading…'}</span></header>
        {query.error && <p className="callout">{query.error}</p>}
      </section>
    )
  }

  const height = Math.max(240, lanes.list.length * LANE_PX + 70)
  const longestCols: Column<Bar>[] = [
    { key: 'k', header: 'Call', render: (b) => callKindName[b.kind] ?? 'CALL', sort: (b) => b.kind },
    { key: 's', header: 'Statement', className: 'clip', render: (b) => { const st = doc.statements[b.stmt]; return st ? <><StmtLink doc={doc} id={b.stmt} /> {preview(st.text, 60)}</> : '–' }, sort: (b) => b.stmt },
    { key: 't', header: 'Start', render: (b) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(b.tim - b.e), doc.tzOffsetMin) : `+${fmtDur(b.tim - b.e - base)}`), sort: (b) => b.tim - b.e },
    { key: 'e', header: 'Elapsed', align: 'end', render: (b) => fmtDur(b.e), sort: (b) => b.e, bar: true },
    { key: 'c', header: 'CPU', align: 'end', render: (b) => fmtDur(b.c), sort: (b) => b.c },
    { key: 'r', header: 'Rows', align: 'end', render: (b) => fmtCompact(b.r), sort: (b) => b.r },
    { key: 'l', header: 'Line', align: 'end', render: (b) => <LineRef line={b.line} bare />, sort: (b) => b.line },
  ]

  return (
    <>
      <section className="section">
        <header>
          <h2>Timeline</h2>
          <span className="hint">
            {picked.sampled
              ? `showing the ${fmtInt(picked.bars.length)} longest of ${fmtInt(picked.total)} calls; set a window on the Overview to see all of them`
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
          <DataTable columns={longestCols} rows={picked.longest} rowKey={(b) => b.id} maxHeight="24rem" rowHeight={28}
            selectedKey={null} onRowClick={(b) => { if (b.stmt !== NONE) actions.selectStmt(b.stmt) }} />
        </section>
      )}
    </>
  )
}
