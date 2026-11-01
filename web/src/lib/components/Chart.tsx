import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, ScatterChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent, MarkAreaComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import type { EChartsType } from 'echarts/core'
import { chromeColors } from './colors'

echarts.use([BarChart, LineChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent, MarkAreaComponent, CanvasRenderer])

/** Base option: recessive hairline grid, system font, text in ink tokens. */
export function baseOption(): EChartsOption {
  const c = chromeColors()
  return {
    animation: false,
    textStyle: { fontFamily: getComputedStyle(document.body).fontFamily, color: c.ink2 },
    grid: { left: 8, right: 16, top: 28, bottom: 28, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: c.axis } },
      backgroundColor: c.surface, borderColor: c.hairline, textStyle: { color: c.ink, fontSize: 12 }, extraCssText: 'box-shadow:none;font-variant-numeric:tabular-nums',
    },
    xAxis: { axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false }, axisLabel: { color: c.ink3 }, splitLine: { show: false } },
    yAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: c.ink3 }, splitLine: { lineStyle: { color: c.grid } } },
    legend: { textStyle: { color: c.ink2 }, icon: 'roundRect', itemWidth: 10, itemHeight: 10, top: 0, left: 0 },
  }
}

export function Chart({ option, className, onEvents }: { option: EChartsOption; className?: string; onEvents?: Record<string, (p: unknown, chart: EChartsType) => void> }) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<EChartsType | null>(null)
  const optionRef = useRef(option)
  optionRef.current = option
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const rethemed = () => chart.setOption(echarts.util.merge(baseOption(), optionRef.current, true), true)
    mq.addEventListener('change', rethemed)
    const mo = new MutationObserver(rethemed)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { ro.disconnect(); mq.removeEventListener('change', rethemed); mo.disconnect(); chart.dispose(); chartRef.current = null }
  }, [])
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.setOption(echarts.util.merge(baseOption(), option, true), true)
    chart.off('click'); chart.off('datazoom')
    if (onEvents) for (const [ev, fn] of Object.entries(onEvents)) chart.on(ev, (p: unknown) => fn(p, chart))
  }, [option, onEvents])
  return <div ref={ref} className={'chart ' + (className ?? '')} />
}
