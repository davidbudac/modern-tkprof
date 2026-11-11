import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from './client'
import { dumpCacheOf, KEEP_DUMPS, Recent } from './optcache'
import { httpSource } from './optsource'
import { optDumpOf, optFileOf } from './testdoc'

describe('Recent', () => {
  it('holds the two most recently asked for and lets the others go', async () => {
    const r = new Recent<string>(2)
    const load = vi.fn(async (k: number) => 'v' + k)
    await r.get(0, () => load(0))
    await r.get(1, () => load(1))
    await r.get(0, () => load(0)) // 0 is the most recent again
    expect(load).toHaveBeenCalledTimes(2)
    await r.get(2, () => load(2)) // drops 1, the least recent
    expect(r.keys()).toEqual([0, 2])
    await r.get(1, () => load(1))
    expect(load).toHaveBeenCalledTimes(4)
    expect(r.keys()).toEqual([2, 1])
  })

  it('shares a load in flight and forgets a load that failed', async () => {
    const r = new Recent<number>(2)
    let n = 0
    const a = r.get(5, async () => ++n)
    expect(r.get(5, async () => ++n)).toBe(a)
    await a
    const bad = r.get(6, () => Promise.reject(new Error('boom')))
    await expect(bad).rejects.toThrow('boom')
    await Promise.resolve()
    expect(r.keys()).toEqual([5])
    expect(await r.get(6, async () => 99)).toBe(99)
  })

  it('is the same cache for the same source and another for another', () => {
    const file = optFileOf(2)
    const a = { file, dump: async () => optDumpOf(file, 0), text: async () => ({ from: 1, to: 1, complete: true, get: () => '' }) }
    expect(dumpCacheOf(a)).toBe(dumpCacheOf(a))
    expect(dumpCacheOf({ ...a })).not.toBe(dumpCacheOf(a))
    expect(dumpCacheOf(a).cap).toBe(KEEP_DUMPS)
  })
})

describe('the dumps of a three-dump source', () => {
  const file = optFileOf(3)
  const textOf = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join('\n') + '\n'
  const calls: string[] = []
  const client = {
    base: '',
    fetch: async (path: string) => {
      calls.push(path)
      const i = Number(path.split('=')[1])
      const d = file.dumps[i]
      return path.startsWith('/api/opt/dump') ? Response.json(optDumpOf(file, i)) : new Response(textOf(d.viewFrom, d.viewTo))
    },
  } as unknown as ApiClient

  it('holds the open dump and the one before; the first is asked again when it is opened again', async () => {
    const source = httpSource(file, client)
    const cache = dumpCacheOf<{ text: Awaited<ReturnType<typeof source.text>> }>(source)
    const open = (i: number) => cache.get(i, async () => ({ text: (await Promise.all([source.dump(i), source.text(i)]))[1] }))
    const first = await open(0)
    await open(1)
    expect(cache.keys()).toEqual([0, 1])
    await open(2)
    expect(cache.keys()).toEqual([1, 2]) // dump 0, its text with it, is no longer held by the cache or by the source
    expect(calls).toHaveLength(6)
    const again = await open(0)
    expect(calls).toHaveLength(8) // asked again
    expect(again).not.toBe(first)
    expect(again.text.get(again.text.from)).toBe(first.text.get(first.text.from))
    await open(2)
    expect(calls).toHaveLength(8) // 2 was still held
  })
})
