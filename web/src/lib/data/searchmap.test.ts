import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { OptNode, OptRun } from './opt'
import { PALETTE, buildSearchMap, logTicks, plot, runIdOf, runLabel, runNodes, runRows, shortName, tableRef } from './searchmap'

interface Fx { runs: OptRun[]; tree: OptNode }
const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./searchmap.fixture.json', import.meta.url)), 'utf8')) as Record<string, Fx>

const runOf = (key: string, n: number): OptNode => runNodes(fx[key].tree).find((r) => r.n === n)!

describe('the table of runs', () => {
  it('has a row per run with the orders it tried, those aborted and the final cost as printed', () => {
    const rows = runRows(fx.opt_two.runs, fx.opt_two.tree)
    expect(rows).toHaveLength(9)
    expect(rows[0]).toMatchObject({ orders: 18, aborted: 16, finalCost: '384.608830', bestJo: 13 })
    expect(rows[0].run.qb).toBe('SEL$1BA63A14')
    expect(rows[8]).toMatchObject({ orders: 18, aborted: 16, finalCost: '384.608830' })
    expect(rows[8].run.final).toBe(true)
    expect(rows[3]).toMatchObject({ orders: 1, aborted: 0 })
  })
  it('says same as run N for a run with the text of an earlier one', () => {
    const rows = runRows(fx.opt_two_2.runs, fx.opt_two_2.tree)
    expect(rows[3].run.sameAs).toBe(1)
  })
})

describe('the map of the first run of opt_two (4 tables, 18 orders)', () => {
  const m = buildSearchMap(runOf('opt_two', 1))
  it('has the orders in the order tried, the winner named by the run', () => {
    expect(m.orders).toHaveLength(18)
    expect(m.orders.map((o) => o.n)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
    expect(m.winner).toBe(12)
    expect(m.orders[12].isBest).toBe(true)
    expect(m.searches).toBe(1)
  })
  it('gives a completed order the cost of every position, as printed', () => {
    const o = m.orders[0]
    expect(o.done).toBe(true)
    expect(o.points.map((p) => p.text)).toEqual(['6.002106', '110.031654', '314.232856', '453.647906'])
    expect(o.points.every((p) => p.from === 'best-so-far')).toBe(true)
    expect(o.cost).toBe('453.647906')
    expect(m.orders[12].cost).toBe('384.608830')
  })
  it('keeps the two shapes of an aborted order apart', () => {
    // order 16: abandoned after its first table, no join step printed
    expect(m.orders[15]).toMatchObject({ done: false, abort: 'no-step', abortAt: 0 })
    expect(m.orders[15].points).toEqual([{ pos: 0, text: '137.063704', v: 137.063704, from: 'access' }])
    // order 3: abandoned inside its first step, which printed no cost
    expect(m.orders[2]).toMatchObject({ done: false, abort: 'in-step', abortAt: 1 })
    expect(m.orders[2].points.map((p) => p.text)).toEqual(['6.002106'])
  })
  it('places the printed steps by their table: the steps an order shares with the one before it are not printed again', () => {
    // order 2 is C, O, MTK_ORDERS, A like order 1 up to O: it prints steps for positions 2 and 3 only
    const o = m.orders[1]
    expect(o.abort).toBe('in-step')
    expect(o.abortAt).toBe(3)
    expect(o.points.map((p) => [p.pos, p.text, p.from])).toEqual([[0, '6.002106', 'access'], [2, '247.446962', 'step']])
  })
  it('carries the printed cost of the last completed order forward as the best so far', () => {
    expect(m.orders[0].bestText).toBe('453.647906')
    expect(m.orders[11].bestText).toBe('453.647906')
    expect(m.orders[12].bestText).toBe('384.608830')
    expect(m.orders[17].bestText).toBe('384.608830')
    expect(m.steps.map((s) => [s.index, s.text])).toEqual([[0, '453.647906'], [12, '384.608830']])
  })
  it('colours a position by its table (#n), so orders that start alike read as a group', () => {
    const starts = m.orders.map((o) => o.slot[0])
    expect(starts.slice(0, 4)).toEqual([0, 0, 0, 0]) // MTK_CUST#0
    expect(new Set(starts.slice(4, 10))).toEqual(new Set([1])) // MTK_ORDERS[O]#1
    expect(new Set(starts.slice(10, 15))).toEqual(new Set([2])) // MTK_AUDIT#2
    expect(new Set(starts.slice(15))).toEqual(new Set([3])) // MTK_ORDERS[MTK_ORDERS]#3
    expect(m.legend.map((l) => [l.slot, l.label])).toEqual([[0, 'C'], [1, 'O'], [2, 'A'], [3, 'MTK_ORDERS']])
  })
  it('has an axis that takes in every plotted cost', () => {
    expect(m.axis).not.toBeNull()
    expect(m.axis!.lo).toBeLessThan(6.002106)
    expect(m.axis!.hi).toBeGreaterThan(453.647906)
    expect(m.axis!.ticks.length).toBeGreaterThan(1)
  })
})

describe('the first table of an aborted order', () => {
  it('takes the single table section costed before the order, not the one costed after the join search', () => {
    // opt_two dump 2, run 1: a one-table block costed twice, 136.863728 (table scan) before its join search and 1,000.254326 (index) after it
    const run = runOf('opt_two_2', 1)
    const secs: string[] = []
    const visit = (n: OptNode) => { if (n.kind === 'table' && n.ref === 'MTK_ORDERS[MTK_ORDERS]') secs.push(n.accCost ?? ''); for (const c of n.children ?? []) visit(c) }
    visit(run)
    expect(secs).toEqual(['136.863728', '1000.254326'])
    // a synthetic aborted order after the search picks the later one; the one in the search the earlier
    const jo = (from: number): OptNode => ({ id: 'jo', kind: 'join-order', label: '', crumb: '', from, to: from + 5, lvl: 7, n: 1, tables: ['MTK_ORDERS[MTK_ORDERS]#0'], result: 'aborted' })
    const mk = (from: number): OptNode => ({ ...run, children: [...(run.children ?? []).filter((c) => c.kind === 'table'), { id: 'js', kind: 'join-search', label: '', crumb: '', from, to: from + 9, lvl: 6, children: [jo(from + 1)] }] })
    const secsAt = (run.children ?? []).filter((c) => c.kind === 'table')
    expect(buildSearchMap(mk(secsAt[0].to + 1)).orders[0].points[0].text).toBe('136.863728')
    expect(buildSearchMap(mk(secsAt[1].to + 1)).orders[0].points[0].text).toBe('1000.254326')
  })
})

describe('the map of opt_join8 (8 tables)', () => {
  const m = buildSearchMap(runOf('opt_join8', 1))
  it('has its 31 orders of 8 tables, the winner first, and eight colours', () => {
    expect(m.orders).toHaveLength(31)
    expect(m.orders.every((o) => o.tables.length === 8)).toBe(true)
    expect(m.winner).toBe(0)
    expect(m.legend).toHaveLength(8)
    expect(m.orders.filter((o) => o.done)).toHaveLength(1)
  })
})

/** A run of `n` orders over `t` tables, built the way the outline is. */
function synth(n: number, t: number, searches = 1): OptNode {
  const tables = Array.from({ length: t }, (_, i) => `T${i}[T${i}]#${i}`)
  const orders = (base: number): OptNode[] => Array.from({ length: n }, (_, k) => {
    const rot = [...tables.slice(k % t), ...tables.slice(0, k % t)]
    const done = k === 0 || k === 37
    const steps: OptNode[] = rot.slice(1, 1 + (k % (t - 1))).map((x, j) => ({ id: `s${base}-${k}-${j}`, kind: 'join-step', label: '', crumb: '', from: 0, to: 0, lvl: 8, table: x, stepCost: String(10 + j * 7 + k % 5) }))
    return {
      id: `o${base}-${k}`, kind: 'join-order', label: '', crumb: '', from: base + k * 10, to: base + k * 10 + 9, lvl: 7, n: k + 1, tables: rot, children: steps,
      ...(done ? { cost: String(100 + k), result: `cost: ${100 + k}`, posCosts: rot.map((_, j) => String(10 + j * 20 + k)), isBest: k === 37 } : { result: 'aborted' }),
    }
  })
  return {
    id: 'r', kind: 'run', label: '', crumb: '', from: 0, to: 1e6, lvl: 5, n: 1,
    children: Array.from({ length: searches }, (_, s) => ({ id: `js${s}`, kind: 'join-search', label: '', crumb: '', from: s * 1e5, to: s * 1e5 + 9e4, lvl: 6, children: orders(s * 1e5) })),
  }
}

describe('many orders and many tables', () => {
  it('maps 2,000 orders of ten tables, every order with its own id, ten colours', () => {
    const t0 = performance.now()
    const m = buildSearchMap(synth(2000, 10))
    expect(m.orders).toHaveLength(2000)
    expect(new Set(m.orders.map((o) => o.id)).size).toBe(2000)
    expect(m.legend).toHaveLength(10)
    expect(Math.max(...m.orders.flatMap((o) => o.slot))).toBe(PALETTE - 1)
    expect(m.winner).toBe(37)
    expect(performance.now() - t0).toBeLessThan(500)
  })
  it('shows one join search of a run that has several, the last unless asked, keyed by node id', () => {
    const run = synth(5, 3, 3)
    expect(buildSearchMap(run).searches).toBe(3)
    expect(buildSearchMap(run).search).toBe(2)
    expect(buildSearchMap(run).orders[0].id).toBe('o200000-0')
    expect(buildSearchMap(run, 0).orders[0].id).toBe('o0-0')
    expect(buildSearchMap(run, 9).search).toBe(2)
  })
  it('a run with no join order has an empty map and no axis', () => {
    const m = buildSearchMap({ id: 'r', kind: 'run', label: '', crumb: '', from: 1, to: 2, lvl: 5, n: 1 })
    expect(m.orders).toEqual([])
    expect(m.axis).toBeNull()
    expect(m.winner).toBe(-1)
    expect(m.searches).toBe(0)
  })
})

describe('what the trace prints that is not a cost', () => {
  it('keeps the printed text of a cost that is not a positive number and leaves the dot out', () => {
    expect(plot('1.5e3')).toBe(1500)
    expect(plot('0.000000')).toBeNull()
    expect(plot('-3')).toBeNull()
    expect(plot('NaN')).toBeNull()
    expect(plot('')).toBeNull()
    const run: OptNode = {
      id: 'r', kind: 'run', label: '', crumb: '', from: 1, to: 2, lvl: 5, n: 1,
      children: [{ id: 'js', kind: 'join-search', label: '', crumb: '', from: 1, to: 2, lvl: 6, children: [
        { id: 'o', kind: 'join-order', label: '', crumb: '', from: 1, to: 2, lvl: 7, n: 1, tables: ['A#0', 'B#1'], cost: '0.0000', posCosts: ['0.0000', 'x'], result: 'cost: 0.0000' },
      ] }],
    }
    const m = buildSearchMap(run)
    expect(m.orders[0].points).toEqual([{ pos: 0, text: '0.0000', v: null, from: 'best-so-far' }, { pos: 1, text: 'x', v: null, from: 'best-so-far' }])
    expect(m.axis).toBeNull()
    expect(m.steps).toEqual([])
  })
  it('names the short form of a table as the alias', () => {
    expect(shortName('MTK_ORDERS[O]#1')).toBe('O')
    expect(shortName('MTK_ORDERS[MTK_ORDERS]#3')).toBe('MTK_ORDERS')
    expect(shortName('T#0')).toBe('T')
    expect(tableRef('MTK_ORDERS[O]#1')).toBe('MTK_ORDERS[O]')
  })
  it('has log axis ticks at 1 and 3 of each decade, thinned when there are many', () => {
    expect(logTicks(5, 600)).toEqual([10, 30, 100, 300])
    expect(logTicks(0, 5)).toEqual([])
    expect(logTicks(1, 1e9).every((t) => Math.log10(t) % 1 === 0)).toBe(true)
  })
})

describe('finding the run', () => {
  it('is the innermost run on the chain of nodes holding the line', () => {
    expect(runIdOf([{ id: 'a', kind: 'dump' }, { id: 'b', kind: 'run' }, { id: 'c', kind: 'join-order' }])).toBe('b')
    expect(runIdOf([{ id: 'a', kind: 'dump' }, { id: 'p', kind: 'phase-env' }])).toBe('')
    expect(runLabel({ n: 3, of: 9, qb: 'SEL$1', qbn: '1' })).toBe('Run 3 of 9 · SEL$1 (#1)')
  })
})
