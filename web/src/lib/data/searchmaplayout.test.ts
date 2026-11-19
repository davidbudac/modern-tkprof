import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { OptNode } from './opt'
import { buildSearchMap, runNodes } from './searchmap'
import type { SearchMap } from './searchmap'
import { HEAD, MAX_COL, MIN_COL, columnWidth, dotRadius, layoutMap, orderAt } from './searchmaplayout'

const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./searchmap.fixture.json', import.meta.url)), 'utf8')) as Record<string, { tree: OptNode }>
const first = (key: string) => buildSearchMap(runNodes(fx[key].tree)[0])

describe('the layout of the first run of opt_two', () => {
  const m = first('opt_two')
  const l = layoutMap(m, { avail: 720, plotH: 150 })
  it('fits all 18 orders in the room, one column each', () => {
    expect(l.colW).toBe(40)
    expect(l.plotW).toBe(18 * 40)
    expect(l.dotR).toBeGreaterThan(0)
  })
  it('puts a higher cost higher up, on a log axis inside the plot', () => {
    expect(l.y(453.647906)).toBeLessThan(l.y(6.002106))
    expect(l.y(m.axis!.hi)).toBeCloseTo(12 + HEAD, 5)
    expect(l.y(m.axis!.lo)).toBeCloseTo(12 + 150, 5)
    expect(l.grid.length).toBe(m.axis!.ticks.length)
  })
  it('draws the best-so-far line as two steps, a cross per aborted order and a strip square per position', () => {
    expect((l.best.match(/H/g) ?? []).length).toBe(2)
    expect((l.crosses.match(/M/g) ?? []).length).toBe(16)
    expect(l.strip.map((s) => s.slot)).toEqual([0, 1, 2, 3])
    expect(l.strip.reduce((k, s) => k + (s.d.match(/M/g) ?? []).length, 0)).toBe(18 * 4)
    expect(l.band).toEqual({ x: 12 * 40, w: 40 })
  })
  it('finds the order under a pointer', () => {
    expect(orderAt(0, l.colW, 18)).toBe(0)
    expect(orderAt(41, l.colW, 18)).toBe(1)
    expect(orderAt(18 * 40, l.colW, 18)).toBe(-1)
    expect(orderAt(-1, l.colW, 18)).toBe(-1)
  })
})

describe('columns', () => {
  it('are as wide as the room allows, between the narrowest and the widest', () => {
    expect(columnWidth(720, 18)).toBe(40)
    expect(columnWidth(720, 2)).toBe(MAX_COL)
    expect(columnWidth(720, 2000)).toBe(MIN_COL)
    expect(columnWidth(720, 0)).toBe(MAX_COL)
  })
  it('lose their dots before they lose their ends', () => {
    expect(dotRadius(40)).toBeGreaterThan(dotRadius(8))
    expect(dotRadius(MIN_COL)).toBe(0)
  })
})

describe('hundreds of orders', () => {
  it('scroll rather than crowd: a column of at least three px, no dots at that width, a thin ladder and an end per order', () => {
    const m = first('opt_join8')
    const l = layoutMap(m, { avail: 40, plotH: 150 })
    expect(l.colW).toBe(MIN_COL)
    expect(l.plotW).toBe(31 * MIN_COL)
    expect(l.dotsOk + l.dotsAb + l.dotsWin).toBe('')
    expect(l.strip.reduce((k, s) => k + (s.d.match(/M/g) ?? []).length, 0)).toBe(31 * 8)
    expect(l.xTicks.length).toBeLessThan(31)
  })
  it('lays out 2,000 orders of ten tables at once, and draws every strip square', () => {
    const orders = Array.from({ length: 2000 }, (_, i) => ({
      id: `o${i}`, index: i, n: i + 1, line: i, tables: Array.from({ length: 10 }, (_, t) => `T${t}[T${t}]#${t}`), labels: Array.from({ length: 10 }, (_, t) => `T${t}`), slot: Array.from({ length: 10 }, (_, t) => t),
      points: [{ pos: 0, text: '5', v: 5, from: 'access' as const }, { pos: 3, text: '50', v: 50, from: 'step' as const }], done: i % 100 === 0, cost: '', abort: i % 100 === 0 ? null : ('in-step' as const), abortAt: 3, isBest: i === 0, bestText: '60', bestV: 60,
    }))
    const m: SearchMap = { run: 'r', searches: 1, search: 0, orders, winner: 0, legend: [], axis: { lo: 4, hi: 80, ticks: [10, 30] }, steps: [{ index: 0, text: '60', v: 60 }] }
    const t0 = performance.now()
    const l = layoutMap(m, { avail: 1000, plotH: 150 })
    expect(performance.now() - t0).toBeLessThan(300)
    expect(l.colW).toBe(MIN_COL)
    expect(l.strip.reduce((k, s) => k + (s.d.match(/M/g) ?? []).length, 0)).toBe(20000)
    expect((l.crosses.match(/M/g) ?? []).length).toBe(1980)
  })
  it('has no paths when there is no axis', () => {
    const m = buildSearchMap({ id: 'r', kind: 'run', label: '', crumb: '', from: 1, to: 2, lvl: 5, n: 1 })
    const l = layoutMap(m, { avail: 400, plotH: 100 })
    expect(l.best + l.ladderOk + l.crosses).toBe('')
    expect(l.band).toBeNull()
  })
})
