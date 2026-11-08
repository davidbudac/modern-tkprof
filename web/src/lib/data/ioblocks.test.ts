import { describe, expect, it } from 'vitest'
import { makeDoc, type WaitSpec } from './testdoc'
import type { Event } from './types'
import { ioMapOf, MAX_WAIT_BLOCKS, type IOMap, type IOMapOpts } from './iomap'
import { ioHotOf, type IOHotOpts } from './iohot'
import { densityParams, ioDensityOf, xBin, type DensityReq } from './iodensity'
import { BlockCounter, BlockSet } from './blockset'
import blocksCase from './testdata/ioblocks-case.json'

// Same file as TestIOBlocksSharedCase in internal/analyze/ioblocks_case_test.go: the Go routes and their twins give the same answers,
// the pruned and capped ones included.
interface Scoped { stmt?: number; from?: number; to?: number }
const w = blocksCase.waits
const waits: WaitSpec[] = Array.from({ length: w.n }, (_, i) => ({
  ctx: w.ctx[i], stmt: w.stmt[i], event: w.event[i], ela: w.ela[i], tim: w.tim[i], line: w.line[i], call: w.call[i],
  p1: w.p1[i], p2: w.p2[i], p3: w.p3[i], obj: w.obj[i], dep: w.dep[i], flags: w.flags[i],
}))
/** mulberry32: integers in [0, n) */
function rng(seed: number): (n: number) => number {
  let a = seed >>> 0
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}
const docOf = () => makeDoc([], { waits, events: blocksCase.events as Event[] })
const scopeOf = (q: Scoped) => ({ window: q.from || q.to ? { startTim: q.from || -Infinity, endTim: q.to || Infinity } : null, contexts: null })

describe('the shared case of the I/O routes', () => {
  it.each(blocksCase.hot.map((c, k) => [k, c] as const))('hot %d gives the engine\'s answer', async (_, c) => {
    const doc = await docOf()
    expect(ioHotOf(doc, scopeOf(c), c.opts as IOHotOpts, c.stmt)).toEqual(c.expect)
  })
  it.each(blocksCase.density.map((c, k) => [k, c] as const))('density %d gives the engine\'s answer', async (_, c) => {
    const doc = await docOf()
    expect(ioDensityOf(doc, scopeOf(c), c.req as DensityReq, c.stmt)).toEqual(c.expect)
  })
  it.each(blocksCase.reads.map((c, k) => [k, c] as const))('reads %d gives the engine\'s answer', async (_, c) => {
    const doc = await docOf()
    const got: IOMap = ioMapOf(doc, scopeOf(c), c.limit, c.stmt, undefined, c.opts as IOMapOpts)
    // the engine leaves out an empty reads list and a false readsExact (omitempty)
    expect({ ...got, reads: got.reads?.length ? got.reads : undefined, readsExact: got.readsExact || undefined }).toEqual(c.expect)
  })
  it('exercises re-reads, a prune and the caps', () => {
    const [all, , , , pruned, , seenCapped, ownerCapped] = blocksCase.hot.map((c) => c.expect)
    expect(all.exact && all.reread > 100 && all.runs.length > 0).toBe(true)
    expect(pruned.exact).toBe(false)
    expect(seenCapped.exact && !seenCapped.distinctExact && !ownerCapped.distinctExact).toBe(true)
    expect(blocksCase.reads[2].expect.readsExact).toBeUndefined()
  })
})

describe('BlockSet', () => {
  it('gives what a plain set gives, arrays and bitmaps, across chunk edges', () => {
    const s = new BlockSet()
    const ref = new Set<string>()
    const rnd = rng(7)
    for (let i = 0; i < 4000; i++) {
      const owner = rnd(2), file = rnd(2)
      const lo = rnd(3) === 0 ? 65530 + rnd(12) : rnd(2) ? rnd(3000) : rnd(1 << 22)
      const n = rnd(15) === 0 ? 1 + rnd(1500) : 1 + rnd(4)
      const seen: number[] = [], want: number[] = []
      let wantAdded = 0
      for (let b = lo; b < lo + n; b++) {
        const k = `${owner}:${file}:${b}`
        if (ref.has(k)) want.push(b); else { ref.add(k); wantAdded++ }
      }
      expect(s.addRange(owner, file, lo, lo + n, (b) => seen.push(b))).toBe(wantAdded)
      expect(seen).toEqual(want)
    }
    for (const k of ref) { const [o, f, b] = k.split(':').map(Number); expect(s.has(o, f, b)).toBe(true) }
    expect(s.has(0, 0, -1)).toBe(false)
  })
  it('models its size: 64 bytes a chunk, 2 a block in an array, 8 KB a bitmap', () => {
    const s = new BlockSet()
    s.addRange(0, 1, 0, 10)
    expect(s.bytes).toBe(64 + 20)
    s.addRange(0, 1, 100, 1200) // past 1,024 blocks: a bitmap
    expect(s.bytes).toBe(64 + 8192)
    s.addRange(1, 1, 0, 1) // another owner: another chunk
    expect(s.bytes).toBe(64 + 8192 + 64 + 2)
  })
})

describe('BlockCounter', () => {
  it('counts exactly until it prunes, then a count is low by at most dec', () => {
    const bc = new BlockCounter(1, 64) // the seen set capped at once: every block goes to the map, which prunes
    const truth = new Map<number, number>()
    const rnd = rng(11)
    for (let i = 0; i < 20000; i++) {
      const hot = rnd(4) === 0
      const lo = hot ? rnd(20) : rnd(1 << 20), n = hot ? 1 : 1 + rnd(8)
      bc.startWait(); bc.read(3, lo, lo + n); bc.endWait()
      for (let b = lo; b < lo + n; b++) truth.set(b, (truth.get(b) ?? 0) + 1)
    }
    expect(bc.dec).toBeGreaterThan(0)
    for (const [b, n] of truth) {
      const v = bc.reads(3, b)
      expect(v).toBeLessThanOrEqual(n)
      expect(v).toBeGreaterThanOrEqual(n - bc.dec - 1)
    }
  })
})

describe('densityParams and xBin', () => {
  it('write the query as the engine reads it', () => {
    expect(densityParams({ x: 'time', xsegs: [[0, 10, 4], [10, 20, 2]], panels: [{ key: 'f12', segs: [[12, 0, 100, 5], [12, 200, 300, 5]] }, { key: 'rest', segs: [[12, 0, 9, 3]] }] }))
      .toEqual([['x', 'time'], ['xs', '0.10.4,10.20.2'], ['p', 'f12:12.0.100.5,12.200.300.5'], ['p', 'rest:12.0.9.3']])
    expect(densityParams({})).toEqual([])
  })
  it('bins a position, clamping the time axis', () => {
    const segs: [number, number, number][] = [[0, 10, 5], [20, 30, 2]], off = [0, 5, 7]
    expect([0, 1.9, 2, 9.99].map((p) => xBin(segs, off, false, p))).toEqual([0, 0, 1, 4])
    expect([15, 20, 29, 30, -1].map((p) => xBin(segs, off, false, p))).toEqual([-1, 5, 6, -1, -1])
    expect([15, 30, -1].map((p) => xBin(segs, off, true, p))).toEqual([5, 6, 0])
  })
})

describe('odd waits', () => {
  it('count a corrupt p3 as at most MAX_WAIT_BLOCKS and leave out blocks no counter key holds (TestIOHotOddWaits)', async () => {
    const events = [{ id: 0, name: 'direct path read', class: 'User I/O', p1Name: 'file number', p2Name: 'first dba', p3Name: 'block cnt', idle: false }] as Event[]
    const spec = (tim: number, p1: number, p2: number, p3: number): WaitSpec => ({ ctx: 0, stmt: 1, event: 0, ela: 5, tim, line: tim, call: -1, p1, p2, p3, obj: -1, dep: 0, flags: 0 })
    const doc = await makeDoc([], { events, waits: [spec(10, 4, 0, 2 ** 40), spec(20, -1, 7, 1), spec(30, -1, 7, 1), spec(40, 5, 2 ** 32 + 100, 1), spec(50, 5, 100, 1), spec(60, 5, 2 ** 32 + 100, 1), spec(70, 4, 3, 2)] })
    const h = ioHotOf(doc, { window: null, contexts: null })
    expect(h.blockReads).toBe(MAX_WAIT_BLOCKS + 7)
    expect(h.runs.map((r) => [r.file, r.lo, r.hi, r.reads, r.first, r.last])).toEqual([[4, 3, 5, 4, 10, 70]])
    const m = ioMapOf(doc, { window: null, contexts: null }, 100, undefined, undefined, { reads: true })
    expect(m.rows[0][5]).toBe(MAX_WAIT_BLOCKS)
    expect([m.reads![1], m.reads![3], m.reads![4], m.reads![6]]).toEqual([0, 0, 1, 2])
  })
})
