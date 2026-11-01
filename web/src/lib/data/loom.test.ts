import { describe, expect, it } from 'vitest'
import { buildLoom, objectCurve } from './loom'
import type { ExecTrace, TraceCall, TraceWait } from './exectrace'
import { CallKind } from './types'

// Synthetic fixture A of docs/implementing-new-ideas.md § 8 (not a trace file: rows for the pure transform).
const ms = 1000
function trace(base: number, calls: [number, number, number, number][], waits: [number, number, number][]): ExecTrace {
  // calls: kind, e ms, c ms, rows; waits: call index, obj, ela ms
  const cs: TraceCall[] = calls.map(([kind, e, c, r], i) => ({
    id: base + i, owner: base + i, parent: -1, line: 10 + i, ctx: 0, kind, cursor: 1, stmt: 0, dep: 0, execNo: 1,
    c: c * ms, e: e * ms, p: 0, cr: 0, cu: 0, r, tim: 0, selfE: e * ms, plh: 1,
  }))
  const ws: TraceWait[] = waits.map(([ci, obj, ela], i) => ({
    id: base + i, call: base + ci, owner: base + ci, line: 0, ctx: 0, event: 0, ela: ela * ms, p1: 0, p2: 0, p3: 0, obj, tim: 0, dep: 0, between: false,
  }))
  return { calls: cs, children: [], waits: ws, truncated: false }
}
const { exec, fetch } = CallKind

const A = trace(0, [[exec, 90, 20, 0], [fetch, 50, 8, 100], [fetch, 20, 6, 50]],
  [[0, 42, 20], [0, 73, 40], [1, 42, 4], [1, 42, 4], [1, 73, 16], [1, 73, 16], [2, 42, 4], [2, 73, 8]])
const B = trace(100, [[exec, 90, 20, 0], [fetch, 510, 8, 100], [fetch, 20, 6, 50]],
  [[0, 42, 20], [0, 73, 40], [1, 42, 6], [1, 42, 6], [1, 73, 244], [1, 73, 244], [2, 42, 4], [2, 73, 8]])

describe('buildLoom', () => {
  it('fixture A: cumulative curves, added deltas, residuals, objects', () => {
    const l = buildLoom(A, B, { includeParse: false })
    expect(l.phases.map((p) => p.label)).toEqual(['Execute', 'Fetch 1', 'Fetch 2'])
    expect(l.cumA).toEqual([0, 90, 140, 160].map((x) => x * ms))
    expect(l.cumB).toEqual([0, 90, 600, 620].map((x) => x * ms))
    expect(l.phases.map((p) => p.addedUs)).toEqual([0, 460 * ms, 0])
    expect(l.phases.map((p) => p.b!.residual)).toEqual([10, 2, 2].map((x) => x * ms))
    const table = l.objects.find((o) => o.obj === 73)!, index = l.objects.find((o) => o.obj === 42)!
    expect(l.objects[0]).toBe(table)
    expect(objectCurve(table, l, 'b')).toEqual([0, 40, 528, 536].map((x) => x * ms))
    expect(objectCurve(index, l, 'a')).toEqual([0, 20, 28, 32].map((x) => x * ms))
  })

  it('an extra fetch is unmatched, not zero', () => {
    const B2 = trace(100, [[exec, 90, 20, 0], [fetch, 50, 8, 100], [fetch, 20, 6, 50], [fetch, 1, 1, 0]], [])
    const l = buildLoom(A, B2, { includeParse: false })
    expect(l.phases).toHaveLength(4)
    expect(l.phases[3].a).toBeUndefined()
    expect(l.phases[3].addedUs).toBeNull()
    expect(l.cumA[4]).toBeNull()
    expect(l.shape[0]).toMatch(/A has 2 fetches, B 3 fetches/)
  })
})
