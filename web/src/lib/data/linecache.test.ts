import { describe, expect, it, vi } from 'vitest'
import { PageCache, packPage, LINE_KINDS } from './linecache'
import type { AnnotPage } from './lines'

/** A file of `total` lines; line n reads "L<n>" and is a wait when n is a multiple of 3. */
function fakeFile(total: number) {
  const calls: number[] = []
  const fetchPage = vi.fn(async (from: number, n: number): Promise<AnnotPage> => {
    calls.push(from)
    const lines = []
    for (let i = from; i < from + n && i <= total; i++) lines.push({ t: `L${i}`, k: i % 3 === 0 ? ('wait' as const) : ('blank' as const) })
    return { from, total, lines }
  })
  return { fetchPage, calls }
}

describe('PageCache', () => {
  it('maps lines to pages of the page size', () => {
    const c = new PageCache(fakeFile(10).fetchPage, 20, 4)
    expect([1, 4, 5, 8, 9].map((n) => c.pageOf(n))).toEqual([0, 0, 1, 1, 2])
  })

  it('learns the total from the first page and serves lines from it', async () => {
    const c = new PageCache(fakeFile(10).fetchPage, 20, 4)
    expect(c.line(1)).toBeUndefined()
    await c.load(0)
    expect(c.total).toBe(10)
    expect(c.pageCount).toBe(3)
    expect(c.line(3)).toEqual({ text: 'L3', kind: LINE_KINDS.indexOf('wait'), call: -1, stmt: -1, cursor: -1, execNo: -1, wait: -1 })
    expect(c.line(5)).toBeUndefined() // page 1 not loaded
  })

  it('shares one request between askers and answers cached pages without a request', async () => {
    const f = fakeFile(100)
    const c = new PageCache(f.fetchPage, 20, 10)
    await Promise.all([c.load(2), c.load(2)])
    await c.load(2)
    expect(f.calls).toEqual([21])
  })

  it('evicts the least recently used page beyond the capacity', async () => {
    const c = new PageCache(fakeFile(100).fetchPage, 3, 10)
    await c.load(0); await c.load(1); await c.load(2)
    c.peek(0) // 0 is now the most recent, 1 the oldest
    await c.load(3)
    expect([0, 1, 2, 3].map((p) => c.has(p))).toEqual([true, false, true, true])
    expect(c.size).toBe(3)
  })

  it('prefetches the next and previous page, never beyond the file', async () => {
    const f = fakeFile(30)
    const c = new PageCache(f.fetchPage, 20, 10)
    await c.load(0)
    c.prefetch(0)
    await vi.waitFor(() => expect(c.has(1)).toBe(true))
    expect(f.calls).toEqual([1, 11]) // no page -1
    await c.load(2)
    c.prefetch(2)
    expect(f.calls).toEqual([1, 11, 21]) // page 3 is past the end, page 1 is cached
  })

  it('notifies when a page arrives and forgets a failed request', async () => {
    let fail = true
    const c = new PageCache(async (from, n) => { if (fail) throw new Error('boom'); return fakeFile(5).fetchPage(from, n) }, 20, 4)
    const changed = vi.fn()
    c.subscribe(changed)
    await expect(c.load(0)).rejects.toThrow('boom')
    fail = false
    await c.load(0)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('close aborts the requests on the way', () => {
    let signal!: AbortSignal
    const c = new PageCache((_f, _n, s) => { signal = s; return new Promise(() => {}) }, 20, 4)
    void c.load(0)
    expect(signal.aborted).toBe(false)
    c.close()
    expect(signal.aborted).toBe(true)
  })
})

describe('PageCache.keepOnly', () => {
  it('aborts the requests for pages that are no longer wanted', () => {
    const signals = new Map<number, AbortSignal>()
    const c = new PageCache((from, _n, s) => { signals.set(from, s); return new Promise(() => {}) }, 20, 10)
    for (const p of [0, 1, 2]) c.load(p).catch(() => {})
    c.keepOnly(new Set([1]))
    expect([1, 11, 21].map((f) => signals.get(f)!.aborted)).toEqual([true, false, true])
  })
})

describe('packPage', () => {
  it('keeps unknown kinds as 0', () => {
    const p = packPage({ from: 1, total: 2, lines: [{ t: 'a', k: 'wait' }, { t: 'b', k: 'zzz' as never }] })
    expect(Array.from(p.kinds)).toEqual([LINE_KINDS.indexOf('wait'), 0])
  })
})

describe('packPage ids', () => {
  it('fills the id arrays from the line keys, -1 where a line omits them', () => {
    const p = packPage({ from: 5, total: 7, lines: [
      { t: 'a', k: 'call', c: 4, s: 2, u: 9, x: 3, w: -1 },
      { t: 'b', k: 'blank' },
      { t: 'c', k: 'wait', c: 4, s: 2, u: 9, x: 3, w: 11 },
    ] })
    expect(Array.from(p.calls)).toEqual([4, -1, 4])
    expect(Array.from(p.stmts)).toEqual([2, -1, 2])
    expect(Array.from(p.cursors)).toEqual([9, -1, 9])
    expect(Array.from(p.execs)).toEqual([3, -1, 3])
    expect(Array.from(p.waits)).toEqual([-1, -1, 11])
  })

  it('has -1 everywhere for a page fetched without ids', () => {
    const p = packPage({ from: 1, total: 2, lines: [{ t: 'a', k: 'call' }, { t: 'b', k: 'wait' }] })
    for (const a of [p.calls, p.stmts, p.cursors, p.execs, p.waits]) expect(Array.from(a)).toEqual([-1, -1])
  })

  it('PageCache.line returns the ids of the line', async () => {
    const c = new PageCache(async (from) => ({ from, total: 2, lines: [{ t: 'a', k: 'call', c: 1, s: 2, u: 3, x: 4 }, { t: 'b', k: 'blank' }] }), 20, 2)
    await c.load(0)
    expect(c.line(1)).toMatchObject({ call: 1, stmt: 2, cursor: 3, execNo: 4, wait: -1 })
    expect(c.line(2)).toMatchObject({ call: -1, stmt: -1, cursor: -1, execNo: -1, wait: -1 })
  })
})

describe('PageCache.refresh (the file grew)', () => {
  it('drops the page holding the last known line, learns the new total and keeps the earlier pages', async () => {
    let total = 25
    const asked: number[] = []
    const fetchPage = async (from: number, n: number) => {
      asked.push(from)
      const lines = []
      for (let i = from; i <= Math.min(total, from + n - 1); i++) lines.push({ t: `line ${i}`, k: 'call' as const })
      return { from, total, lines } as AnnotPage
    }
    const c = new PageCache(fetchPage, 20, 10)
    await c.load(0)
    await c.load(2) // lines 21..25: partial
    expect(c.total).toBe(25)
    total = 37
    await c.refresh()
    expect(c.total).toBe(37)
    expect(c.has(0)).toBe(true)
    expect(c.line(25)?.text).toBe('line 25')
    expect(c.line(30)?.text).toBe('line 30')
    expect(asked).toEqual([1, 21, 21])
  })
})

describe('PageCache.nextOfKind', () => {
  const W = LINE_KINDS.indexOf('wait')
  // lines 1..10, pages of 4; a wait at every multiple of 3: 3, 6, 9
  it('finds the next and previous line of a kind inside the cached pages', async () => {
    const c = new PageCache(fakeFile(10).fetchPage, 20, 4)
    await Promise.all([c.load(0), c.load(1), c.load(2)])
    expect(c.nextOfKind(1, W, 1)).toBe(3)
    expect(c.nextOfKind(3, W, 1)).toBe(6)
    expect(c.nextOfKind(7, W, 1)).toBe(9)
    expect(c.nextOfKind(9, W, 1)).toBeUndefined() // end of the file
    expect(c.nextOfKind(10, W, -1)).toBe(9)
    expect(c.nextOfKind(3, W, -1)).toBeUndefined() // start of the file
    expect(c.nextOfKind(1, LINE_KINDS.indexOf('call'), 1)).toBeUndefined()
  })

  it('stops at the first page that is not loaded', async () => {
    const c = new PageCache(fakeFile(10).fetchPage, 20, 4)
    await c.load(0)
    await c.load(2)
    expect(c.nextOfKind(4, W, 1)).toBeUndefined() // page 1 (lines 5..8, holding the wait at 6) is missing
    expect(c.nextOfKind(9, W, -1)).toBeUndefined()
    expect(c.nextOfKind(1, W, 1)).toBe(3)
  })
})

describe('the optimizer line kind (a 10053 dump inside a 10046 trace)', () => {
  it('is a kind of its own in a page, not the unknown kind a name outside the list falls back to', () => {
    const p = packPage({ from: 1, total: 3, lines: [{ t: 'Registered qb: SEL$1 0x70da90 (PARSER)', k: 'optimizer' }, { t: 'x', k: 'unknown' }, { t: 'y', k: 'kind-from-the-future' as never }] })
    expect(LINE_KINDS[p.kinds[0]]).toBe('optimizer')
    expect(LINE_KINDS[p.kinds[1]]).toBe('unknown')
    expect(LINE_KINDS[p.kinds[2]]).toBe('unknown')
    expect(p.kinds[0]).not.toBe(0)
  })
})
