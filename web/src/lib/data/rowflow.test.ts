import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import type { PlanLine, RawDocument } from './types'
import { bandScale, clientSubline, defaultMaxBand, flowLayout, flowPath, nodeSubline, NO_STATS_NOTE, opText, rowFlow, toneOf, type FlowLayout, type RowFlow } from './rowflow'

// Synthetic plan lines: a unit test of a pure function needs no trace file. The numbers of `hashJoin` are the STAT
// lines 16413 to 16416 of testdata/traces/19c/io_waits.trc (stmt 22, 7r10y07tqpg98).
const L = (id: number, parentId: number, op: string, extra: Partial<PlanLine> = {}): PlanLine => ({
  plan: 0, id, parentId, pos: 1, depth: 0, obj: 0, op, object: '', rows: 1, starts: 1, cr: 0, pr: 0, pw: 0, timeUs: 0,
  cost: -1, size: -1, card: -1, hasStats: true, ...extra,
})

const chain = [
  L(1, 0, 'SORT AGGREGATE', { rows: 1, cr: 498, pr: 496, timeUs: 636589 }),
  L(2, 1, 'TABLE ACCESS FULL', { object: 'MTK_ORDERS', depth: 1, rows: 100001, cr: 498, pr: 496, timeUs: 634138, cost: 137, size: 1300000, card: 100000 }),
]
const hashJoin = [
  L(1, 0, 'SORT AGGREGATE', { rows: 1, cr: 1708, pr: 7312, pw: 276, timeUs: 596760 }),
  L(2, 1, 'HASH JOIN ', { depth: 1, rows: 100001, cr: 1708, pr: 7312, pw: 276, timeUs: 609850, cost: 1342, size: 2086644, card: 99364 }),
  L(3, 2, 'TABLE ACCESS FULL', { object: 'MTK_CUST', depth: 2, rows: 20000, cr: 1210, pr: 1204, timeUs: 3396, cost: 341, size: 220000, card: 20000 }),
  L(4, 2, 'TABLE ACCESS FULL', { object: 'MTK_ORDERS', depth: 2, pos: 2, rows: 100001, cr: 498, pr: 496, timeUs: 2015, cost: 137, size: 1000000, card: 100000 }),
]
// a nested loop: the outer scan once, the inner index lookup once per outer row (E-Rows per start)
const nestedLoop = [
  L(1, 0, 'NESTED LOOPS', { rows: 5, cr: 20, timeUs: 90, card: 5 }),
  L(2, 1, 'TABLE ACCESS FULL', { object: 'T', depth: 1, rows: 5, cr: 8, timeUs: 30, card: 5 }),
  L(3, 1, 'INDEX UNIQUE SCAN', { object: 'T_PK', depth: 1, pos: 2, rows: 5, starts: 5, cr: 12, timeUs: 40, card: 1 }),
]
// below an INLIST ITERATOR the card covers every iteration (nasty_sql.trc: str=1119 card=1119)
const inlist = [
  L(1, 0, 'TABLE ACCESS BY INDEX ROWID', { object: 'MTK_CUST', rows: 1119, starts: 1, timeUs: 900, card: 1119 }),
  L(2, 1, 'INLIST ITERATOR', { depth: 1, rows: 1119, timeUs: 647 }),
  L(3, 2, 'INDEX UNIQUE SCAN', { object: 'MTK_CUST_PK', depth: 2, rows: 1119, starts: 1119, timeUs: 212, card: 1119 }),
]

const ids = (f: RowFlow) => f.nodes.map((n) => n.line.id)

describe('rowFlow', () => {
  it('a chain: SORT AGGREGATE over TABLE ACCESS FULL', () => {
    const f = rowFlow(chain)
    expect(ids(f)).toEqual([1, 2])
    expect(f.root?.line.id).toBe(1)
    expect(f.maxDepth).toBe(1)
    expect(f.totalUs).toBe(636589)
    expect(f.maxRows).toBe(100001)
    expect(f.hasStats).toBe(true)
    expect(f.notes).toEqual([])
    const [agg, scan] = f.nodes
    expect(agg.selfUs).toBe(636589 - 634138)
    expect(agg.selfPr).toBe(0)
    expect(agg.inRows).toBe(100001)
    expect(agg.est).toBe(-1)
    expect(scan.selfUs).toBe(634138)
    expect(scan.est).toBe(100000)
    expect(scan.parent).toBe(agg)
    expect(scan.depth).toBe(1)
    expect(toneOf(agg.selfUs)).toBe(1)
    expect(toneOf(scan.selfUs)).toBe(3)
  })

  it('a hash join with two children: self time and own I/O; the parent below its child clamps with a note', () => {
    const f = rowFlow(hashJoin)
    expect(ids(f)).toEqual([1, 2, 3, 4])
    const hj = f.nodes[1]
    expect(hj.children.map((c) => c.line.id)).toEqual([3, 4])
    expect(hj.selfUs).toBe(609850 - 3396 - 2015) // 604,439 µs ≈ 604 ms
    expect(hj.selfPr).toBe(5612)
    expect(hj.selfPw).toBe(276)
    expect(hj.selfCr).toBe(0)
    expect(hj.clamped).toBe(false)
    expect(toneOf(hj.selfUs)).toBe(3)
    expect(nodeSubline(hj)).toBe('self 604 ms · pr 5,612 · pw 276')
    const sa = f.root!
    expect(sa.clamped).toBe(true)
    expect(sa.selfUs).toBe(0)
    expect(nodeSubline(sa)).toBe('self 0 ms*')
    expect(f.notes).toEqual(['SORT AGGREGATE (id 1) reports 597 ms, less than its children (610 ms): row-source timings are sampled, so its self time is shown as 0 (marked *).'])
    expect(f.totalUs).toBe(596760)
    expect(f.selfSumUs).toBe(609850) // the join's share is 99 %, not 101 % of the clamped root
    expect(opText(hj.line)).toBe('HASH JOIN')
    expect(opText(f.nodes[2].line)).toBe('TABLE ACCESS FULL MTK_CUST')
  })

  it('a nested loop: the inner side started 5 times compares est × starts; below an iterator the card stays', () => {
    const f = rowFlow(nestedLoop)
    const [nl, outer, inner] = f.nodes
    expect(inner.rows).toBe(5)
    expect(inner.est).toBe(1)
    expect(inner.estRows).toBe(5)
    expect(outer.estRows).toBe(5)
    expect(nl.selfUs).toBe(20)
    expect(nl.selfCr).toBe(0)
    expect(nodeSubline(inner)).toBe('self 40 µs · 5 starts')
    const g = rowFlow(inlist)
    expect(g.nodes[2].estRows).toBe(1119)
  })

  it('children follow pos, then id, not the order of the lines', () => {
    const f = rowFlow([L(1, 0, 'UNION-ALL'), L(4, 1, 'C', { pos: 2 }), L(2, 1, 'A', { pos: 1 }), L(3, 1, 'B', { pos: 1 })])
    expect(ids(f)).toEqual([1, 2, 3, 4])
  })

  it('card -1 has no estimate; eRows (ref bundle DBMS_XPLAN) is the fallback', () => {
    const f = rowFlow([L(1, 0, 'SORT AGGREGATE'), L(2, 1, 'TABLE ACCESS FULL', { card: -1, eRows: 42, rows: 40 })])
    expect(f.root!.est).toBe(-1)
    expect(f.root!.estRows).toBe(-1)
    expect(f.nodes[1].est).toBe(42)
    const lay = flowLayout(f, { width: 800, scale: 'sqrt' })
    const toClient = lay.links.find((l) => l.to === 'client')!
    expect(toClient.estPath).toBeNull()
    expect(toClient.estWidth).toBe(0)
    expect(toClient.label?.text).toBe('1 row · no estimate')
    expect(lay.links.find((l) => l.from.line.id === 2)!.estPath).not.toBeNull()
  })

  it('a cycle is cut off with a note and does not hang', () => {
    const f = rowFlow([L(1, 0, 'SELECT STATEMENT'), L(2, 3, 'A'), L(3, 2, 'B'), L(4, 1, 'C'), L(5, 5, 'SELF')])
    expect(ids(f)).toEqual([1, 4])
    expect(f.notes).toEqual(['cycle at id 2: 3 lines never reach a root and are left out.'])
    expect(() => flowLayout(f, { width: 600, scale: 'linear' })).not.toThrow()
  })

  it('a repeated id ends the dump (two STAT blocks glued together)', () => {
    const f = rowFlow([...chain, ...chain])
    expect(ids(f)).toEqual([1, 2])
    expect(f.notes).toEqual(['id 1 appears twice (two STAT blocks in one dump?): the flow stops at the repeat, 2 of 4 lines left out.'])
  })

  it('a line whose parent is missing is a root of its own: the first tree, noted', () => {
    const f = rowFlow([L(1, 0, 'A'), L(2, 1, 'B'), L(3, 9, 'ORPHAN')])
    expect(ids(f)).toEqual([1, 2])
    expect(f.notes).toEqual(['1 line whose parent is not in the dump (id 3): the flow shows the tree of id 1 only.'])
    const g = rowFlow([L(5, 4, 'X'), L(6, 5, 'Y'), L(8, 7, 'Z')])
    expect(ids(g)).toEqual([5, 6])
    expect(g.notes).toEqual(['1 line whose parent is not in the dump (id 8): the flow shows the tree of id 5 only.'])
  })

  it('several lines under id 0 (a scalar subquery beside the main query) hang off the statement line', () => {
    // the shape of a dictionary query in testdata/sets/workload: ids 1 and 3 both have pid=0
    const f = rowFlow([
      L(1, 0, 'TABLE ACCESS BY INDEX ROWID BATCHED', { object: 'OBJ$', rows: 0, timeUs: 1, card: 1 }),
      L(2, 1, 'INDEX RANGE SCAN', { object: 'I_OBJ1', depth: 1, rows: 0, card: 1 }),
      L(3, 0, 'SORT ORDER BY ', { pos: 2, rows: 1, timeUs: 110, cr: 9, card: 1 }),
      L(4, 3, 'TABLE ACCESS CLUSTER', { object: 'USER$', depth: 1, rows: 1, timeUs: 7, cr: 9, card: 1 }),
    ])
    expect(ids(f)).toEqual([0, 1, 2, 3, 4])
    const st = f.root!
    expect(st.index).toBe(-1)
    expect(st.rows).toBe(1) // the main query's rows reach the client
    expect(st.inclusiveUs).toBe(111)
    expect(st.selfUs).toBe(0)
    expect(st.clamped).toBe(false)
    expect(st.children.map((c) => c.line.id)).toEqual([1, 3])
    expect(f.maxDepth).toBe(2)
    expect(f.notes).toEqual(['2 row sources at the top (a scalar subquery beside the main query, or alike): they hang off the statement, id 0, which the trace does not print; its rows are the last one\'s.'])
    const lay = flowLayout(f, { width: 800, scale: 'sqrt' })
    expect(invariants(f, lay)).toBeNull()
  })

  it('a dump without row-source statistics says so', () => {
    const f = rowFlow(chain.map((l) => ({ ...l, hasStats: false, cr: 0, pr: 0, timeUs: 0, card: 0, cost: 0, size: 0 })))
    expect(f.hasStats).toBe(false)
    expect(f.notes).toEqual([NO_STATS_NOTE])
    expect(f.nodes[1].est).toBe(-1) // card 0 of a line without statistics is not an estimate
  })

  it('row sources that never started; PX slaves', () => {
    const f = rowFlow([L(1, 0, 'HASH JOIN', { rows: 0 }), L(2, 1, 'A', { rows: 0 }), L(3, 1, 'B', { pos: 2, rows: 0, starts: 0 })])
    expect(f.notes).toEqual(['1 row source never started (starts 0): no rows, no time.'])
    const px = rowFlow([L(1, 0, 'PX COORDINATOR ', { rows: 4 }), L(2, 1, 'PX SEND QC (RANDOM) :TQ10000', { rows: 0, starts: 0 }), L(3, 2, 'TABLE ACCESS FULL', { rows: 0, starts: 0 })])
    expect(px.notes).toEqual(["PX: 2 row sources ran in the slave processes and show 0 starts here; their rows and times are in the slaves' trace files."])
    // parallel.trc: the slaves' lines carry the optimizer's card=100000 but no actual rows: no ghost, no self time
    const pxc = rowFlow([
      L(1, 0, 'PX COORDINATOR ', { rows: 6, timeUs: 75992 }),
      L(2, 1, 'PX SEND QC (ORDER) :TQ10001', { depth: 1, rows: 0, starts: 0, card: 5 }),
      L(3, 2, 'TABLE ACCESS FULL', { object: 'MTK_ORDERS', depth: 2, rows: 0, starts: 0, card: 100000 }),
    ])
    const [, send, scan] = pxc.nodes
    expect(scan.est).toBe(100000)
    expect(scan.estRows).toBe(-1)
    expect(nodeSubline(send)).toBe('not started')
    const lay = flowLayout(pxc, { width: 900, scale: 'sqrt' })
    expect(lay.links.filter((l) => l.estPath !== null).length).toBe(0)
    expect(lay.links.find((l) => l.from === scan)!.label?.text).toBe('0 rows · not started')
    expect(invariants(pxc, lay)).toBeNull()
  })

  it('no lines: no root, an empty layout', () => {
    const f = rowFlow([])
    expect(f.root).toBeNull()
    expect(f.notes).toEqual([])
    const lay = flowLayout(f, { width: 500, scale: 'sqrt' })
    expect(lay.nodes).toEqual([])
    expect(lay.links).toEqual([])
    expect(lay.height).toBe(0)
  })

  it('flowPath: the path to the root and the subtree', () => {
    const f = rowFlow(hashJoin)
    const hj = f.nodes[1]
    expect([...flowPath(hj)].map((n) => n.line.id).sort()).toEqual([1, 2, 3, 4])
    expect([...flowPath(f.nodes[2])].map((n) => n.line.id).sort()).toEqual([1, 2, 3])
  })
})

/** The geometric invariants of a layout; returns the first broken one. */
function invariants(f: RowFlow, lay: FlowLayout, minBand = 1.5): string | null {
  if (lay.columns !== f.maxDepth + 2) return `columns ${lay.columns}`
  if (lay.nodes.length !== f.nodes.length || lay.nodes.some((b, i) => b.node !== f.nodes[i])) return 'not in DFS order'
  const finite = (v: number) => Number.isFinite(v)
  for (const b of lay.nodes) {
    if (!(b.w > 0 && b.h >= 2 && b.x >= 0 && b.y >= 0 && b.label.w >= 0 && b.label.y >= 0)) return `bad box for id ${b.node.line.id}`
    if (b.y + b.h > lay.height + 0.01 || b.x + b.w > lay.width + 0.01) return `id ${b.node.line.id} outside the figure`
    if (b.col !== f.maxDepth - b.node.depth) return `column of id ${b.node.line.id}`
  }
  for (const l of lay.links) {
    if (!(l.width >= minBand && l.estWidth >= 0)) return `band of id ${l.from.line.id}`
    if (/NaN|Infinity/.test(l.path + (l.estPath ?? ''))) return `path of id ${l.from.line.id}`
  }
  // DFS stacking: within a column the bars follow the DFS order without overlapping
  const byCol = new Map<number, typeof lay.nodes>()
  for (const b of lay.nodes) byCol.set(b.col, [...(byCol.get(b.col) ?? []), b])
  for (const [, col] of byCol) for (let i = 1; i < col.length; i++) if (col[i].y < col[i - 1].y + col[i - 1].h) return `stacking in column ${col[i].col}`
  // labels never overlap each other or a bar (the client's included)
  type Box = { x: number; y: number; w: number; h: number; what: string }
  const over = (a: Box, b: Box) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01
  const labels: Box[] = lay.nodes.map((b) => ({ ...b.label, what: `label of id ${b.node.line.id}` }))
  if (lay.client) labels.push({ ...lay.client.label, what: 'client label' })
  const bars: Box[] = lay.nodes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, what: `bar of id ${b.node.line.id}` }))
  if (lay.client) bars.push({ ...lay.client, what: 'client bar' })
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) if (labels[i].w > 0 && labels[j].w > 0 && over(labels[i], labels[j])) return `${labels[i].what} overlaps ${labels[j].what}`
    for (const b of bars) if (labels[i].w > 0 && over(labels[i], b)) return `${labels[i].what} overlaps ${b.what}`
  }
  const bandLabels = lay.links.flatMap((l) => (l.label ? [{ x: l.label.x - l.label.w / 2, y: l.label.y - 7, w: l.label.w, h: 14, what: `band label of id ${l.from.line.id}` }] : []))
  for (let i = 0; i < bandLabels.length; i++) {
    for (let j = i + 1; j < bandLabels.length; j++) if (over(bandLabels[i], bandLabels[j])) return `${bandLabels[i].what} overlaps ${bandLabels[j].what}`
    for (const b of bars) if (over(bandLabels[i], b)) return `${bandLabels[i].what} overlaps ${b.what}`
    if (!finite(bandLabels[i].x) || !finite(bandLabels[i].y)) return 'band label position'
  }
  return null
}

describe('flowLayout', () => {
  it('band widths grow with rows, on both scales; minBand keeps a 1-row band visible', () => {
    for (const sc of ['sqrt', 'linear'] as const) {
      const s = bandScale(sc, 1e7, 120)
      const rows = [0, 1, 2, 10, 1e3, 1e5, 1e7]
      const w = rows.map(s)
      for (let i = 1; i < w.length; i++) expect(w[i]).toBeGreaterThan(w[i - 1])
      expect(s(1e7)).toBeCloseTo(120)
    }
    expect(bandScale('sqrt', 100, 100)(25)).toBeCloseTo(50)
    expect(bandScale('linear', 100, 100)(25)).toBeCloseTo(25)
    // a 1-row band next to a 1 M-row one
    const f = rowFlow([L(1, 0, 'HASH JOIN', { rows: 1 }), L(2, 1, 'BIG', { rows: 1e6 }), L(3, 1, 'ONE', { pos: 2, rows: 1 })])
    for (const sc of ['sqrt', 'linear'] as const) {
      const lay = flowLayout(f, { width: 800, scale: sc })
      const big = lay.links.find((l) => l.from.line.id === 2)!, one = lay.links.find((l) => l.from.line.id === 3)!
      expect(one.width).toBe(1.5)
      expect(big.width).toBeCloseTo(120)
      expect(invariants(f, lay)).toBeNull()
    }
  })

  it('the hash join: columns, the client, band labels, a node as tall as its children stacked', () => {
    const f = rowFlow(hashJoin)
    const lay = flowLayout(f, { width: 900, scale: 'sqrt' })
    expect(invariants(f, lay)).toBeNull()
    expect(lay.columns).toBe(4)
    expect(lay.nodes.map((b) => b.col)).toEqual([2, 1, 0, 0])
    const [sa, hj, cust, orders] = lay.nodes
    expect(cust.y + cust.h).toBeLessThanOrEqual(orders.y) // DFS order: CUST above ORDERS
    const kids = lay.links.filter((l) => l.to === hj.node)
    expect(hj.h).toBeCloseTo(kids.reduce((a, l) => a + l.width, 0)) // sqrt: the stacked bands are wider than sqrt(Σ rows)
    expect(sa.h).toBeCloseTo(lay.links.find((l) => l.from === hj.node)!.width)
    expect(lay.client!.x).toBeGreaterThan(sa.x)
    expect(lay.client!.h).toBe(4) // 1 row: the thinnest band, the bar at its least
    const labels = Object.fromEntries(lay.links.map((l) => [l.from.line.id, l.label?.text]))
    expect(labels).toEqual({ 3: '20,000 rows · est. 20,000', 4: '100,001 rows · est. 100,000', 2: '100,001 rows · est. 99,364', 1: '1 row · no estimate' })
    expect(lay.links.map((l) => l.width > 15 === !!l.label?.inside)).toEqual([true, true, true, true])
    expect(lay.nodes.map((b) => b.tone)).toEqual([0, 3, 1, 1])
    // the estimate ghost sits on the band (estimates within 1 %)
    for (const l of lay.links.filter((x) => x.estPath)) expect(Math.abs(l.estWidth - l.width)).toBeLessThan(1)
    // linear: the 1-row band to the client is the thread of the mock-up, the 120,001 rows into the join the river
    const lin = flowLayout(f, { width: 900, scale: 'linear' })
    expect(invariants(f, lin)).toBeNull()
    expect(lin.links.find((l) => l.to === 'client')!.width).toBe(1.5)
    expect(lin.nodes[1].h).toBeCloseTo(defaultMaxBand(120001)) // 105 px: five decades of rows
    // the long label of the 20-px CUST band would touch the join's label: the shorter one takes its place
    for (const w of [900, 1185]) {
      const at = flowLayout(f, { width: w, scale: 'linear' })
      expect(at.links.every((l) => l.label !== null), `${w} px`).toBe(true)
      expect(invariants(f, at)).toBeNull()
    }
  })

  it('a chain keeps one height to the client (the river of stmt 21)', () => {
    const f = rowFlow([
      L(1, 0, 'SORT ORDER BY', { rows: 100001, cr: 498, pr: 1827, pw: 1331, timeUs: 2448362, card: 100000 }),
      L(2, 1, 'TABLE ACCESS FULL', { object: 'MTK_ORDERS', depth: 1, rows: 100001, cr: 498, pr: 496, timeUs: 2432, card: 100000 }),
    ])
    const lay = flowLayout(f, { width: 900, scale: 'sqrt' })
    expect(invariants(f, lay)).toBeNull()
    const [so, scan] = lay.nodes
    expect(so.h).toBeCloseTo(scan.h)
    expect(so.y).toBeCloseTo(scan.y)
    expect(lay.client!.h).toBeCloseTo(so.h)
    expect(so.tone).toBe(4)
    expect(nodeSubline(so.node)).toBe('self 2.446 s · pr 1,331 · pw 1,331')
    expect(lay.client!.text).toBe('100,001 rows')
    expect(clientSubline(f.root!, 40)).toBe('100K rows')
  })

  it('the thickest band grows with the decades of rows: a 5-row plan stays slim', () => {
    expect(defaultMaxBand(0)).toBe(24)
    expect(defaultMaxBand(5)).toBeCloseTo(36.5, 1)
    expect(defaultMaxBand(1e6)).toBeCloseTo(120)
    expect(defaultMaxBand(1e9)).toBe(120)
    const small = flowLayout(rowFlow([L(1, 0, 'SORT AGGREGATE'), L(2, 1, 'INDEX RANGE SCAN', { rows: 5 })]), { width: 800, scale: 'sqrt' })
    expect(small.nodes[1].h).toBeCloseTo(defaultMaxBand(5))
  })

  it('the leaves get the room their labels need when the columns leave it', () => {
    // plan_change.trc, plan 254283197: the index scan's label is 37 characters
    const f = rowFlow([
      L(1, 0, 'SORT AGGREGATE', { rows: 1, timeUs: 45 }),
      L(2, 1, 'TABLE ACCESS BY INDEX ROWID BATCHED', { object: 'MTK_ORDERS', depth: 1, rows: 5, timeUs: 44, card: 5 }),
      L(3, 2, 'INDEX RANGE SCAN', { object: 'MTK_ORDERS_CUST_IX', depth: 2, rows: 5, timeUs: 5, card: 5 }),
    ])
    const wide = flowLayout(f, { width: 1185, scale: 'sqrt' })
    expect(wide.nodes[2].label.w).toBeGreaterThan(255)
    expect(wide.colStep).toBeGreaterThan(290)
    expect(invariants(f, wide)).toBeNull()
    const narrow = flowLayout(f, { width: 600, scale: 'sqrt' })
    expect(narrow.nodes[2].label.w).toBeLessThanOrEqual(0.3 * 600)
    expect(invariants(f, narrow)).toBeNull()
  })

  it('the figure fills the width it gets, and grows wider only for deep plans', () => {
    const deep: PlanLine[] = Array.from({ length: 20 }, (_, i) => L(i + 1, i, 'OP', { depth: i, rows: 100 - i }))
    const f = rowFlow(deep)
    expect(f.maxDepth).toBe(19)
    const lay = flowLayout(f, { width: 600, scale: 'sqrt' })
    expect(lay.columns).toBe(21)
    expect(lay.colStep).toBe(56)
    expect(lay.width).toBeGreaterThan(600)
    expect(invariants(f, lay)).toBeNull()
    const two = flowLayout(rowFlow(hashJoin), { width: 700, scale: 'sqrt' })
    expect(two.width).toBeCloseTo(700)
  })

  it('an estimate far above the actual rows: the ghost is cut and flagged', () => {
    const f = rowFlow([L(1, 0, 'SORT AGGREGATE'), L(2, 1, 'TABLE ACCESS FULL', { rows: 10, card: 1e9 })])
    const lay = flowLayout(f, { width: 700, scale: 'sqrt' })
    const l = lay.links.find((x) => x.from.line.id === 2)!
    expect(l.estClipped).toBe(true)
    expect(l.estWidth).toBeCloseTo(1.5 * defaultMaxBand(10))
    expect(flowLayout(f, { width: 700, scale: 'sqrt', maxBand: 120 }).links.find((x) => x.from.line.id === 2)!.estWidth).toBe(180)
    expect(invariants(f, lay)).toBeNull()
  })
})

// Documents written by internal/report TestFindingsDocsCurrent: real trace sets (plan_change, parallel, workload …).
describe('fixture pass: every STAT dump of the test documents', () => {
  const dir = fileURLToPath(new URL('./testdata/', import.meta.url))
  const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json.gz'))
  it('has fixtures with plans', () => expect(fixtures.length).toBeGreaterThanOrEqual(4))
  for (const file of fixtures) {
    it(file, () => {
      const doc = (JSON.parse(gunzipSync(readFileSync(dir + file)).toString('utf8')) as { doc: RawDocument }).doc
      const all = doc.planLines ?? []
      let dumps = 0
      for (const p of doc.plans ?? []) {
        const lines = all.slice(p.first, p.first + p.n)
        const f = rowFlow(lines)
        expect(f.root, `${file} plan ${p.id}`).not.toBeNull()
        // every line is in the tree (plus the statement line when several hang off id 0); real dumps have no cycles
        const statement = f.root!.index === -1 ? 1 : 0
        expect(f.nodes.length, `${file} plan ${p.id}: every line in the tree`).toBe(lines.length + statement)
        expect(f.notes.filter((n) => /cycle|twice|not in the dump/.test(n)), `${file} plan ${p.id}`).toEqual([])
        // line.depth from the parser agrees with the tree
        for (const x of f.nodes) expect(x.depth, `${file} plan ${p.id} id ${x.line.id}`).toBe(x.line.depth + statement)
        for (const width of [420, 900, 1400]) for (const scale of ['sqrt', 'linear'] as const) {
          const lay = flowLayout(f, { width, scale })
          expect(invariants(f, lay), `${file} plan ${p.id} at ${width} px ${scale}`).toBeNull()
        }
        dumps++
      }
      expect(dumps).toBe((doc.plans ?? []).length)
    })
  }
})
