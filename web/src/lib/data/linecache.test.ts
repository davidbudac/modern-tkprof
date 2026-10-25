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
    expect(c.line(3)).toEqual({ text: 'L3', kind: LINE_KINDS.indexOf('wait') })
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
