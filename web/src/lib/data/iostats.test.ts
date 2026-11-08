import { describe, expect, it } from 'vitest'
import { latBucket, latencyHists, objectStats, quantile, SEQ_GAP, sizeHists } from './iostats'

// [tim, ela, event, file, block, blocks, obj, stmt, call, line, ctx, dep]
const row = (o: { ela?: number; event?: number; file?: number; block?: number; blocks?: number; obj?: number }) =>
  [0, o.ela ?? 1, o.event ?? 1, o.file ?? 12, o.block ?? 1, o.blocks ?? 1, o.obj ?? 42, 0, -1, 1, 0, 0]
const isWrite = (e: number) => e === 2
const isTemp = (e: number) => e === 2 || e === 3

describe('objectStats', () => {
  it('counts per object: a scan is sequential, lookups are not; re-reads per block; temp waits per file', () => {
    const scan = [0, 128, 256, 384 + SEQ_GAP].map((b) => row({ block: b, blocks: 128, obj: 7, ela: 100 }))
    const lookups = [5000, 100, 9000, 100].map((b) => row({ block: b, obj: 8, event: 0, ela: 400 }))
    const temp = [row({ file: 203, block: 1, blocks: 8, event: 2, obj: 7 }), row({ file: 203, block: 1, blocks: 8, event: 3, obj: 7 }), row({ file: 203, block: 1, blocks: 8, event: 3, obj: 7 })]
    const s = objectStats([...scan, ...lookups, ...temp], isWrite, isTemp)
    expect(s.map((x) => [x.key, x.waits, x.us])).toEqual([['o8', 4, 1600], ['o7', 4, 400], ['t203', 3, 3]])
    const o7 = s.find((x) => x.key === 'o7')!
    expect([o7.seq, o7.blocks, o7.distinct, o7.readsPerBlock]).toEqual([1, 512, 512, 1])
    const o8 = s.find((x) => x.key === 'o8')!
    expect([o8.seq, o8.distinct, o8.readsPerBlock]).toEqual([0, 3, 4 / 3])
    const t = s.find((x) => x.key === 't203')!
    expect([t.obj, t.temp, t.reads, t.writes, t.distinct, t.readsPerBlock]).toEqual([-1, true, 2, 1, 8, 2])
    expect(objectStats([row({ block: 1 })], isWrite, isTemp)[0].seq).toBeNaN()
  })
})

describe('latencyHists and sizeHists', () => {
  it('bucket the latency in powers of two and give the percentiles', () => {
    expect([0, 1, 2, 3, 4, 1023, 1024, 1e9].map(latBucket)).toEqual([0, 0, 1, 1, 2, 9, 10, 24])
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10)
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2)
    const h = latencyHists([row({ ela: 3 }), row({ ela: 5 }), row({ ela: 900 }), row({ ela: 7, event: 0 })])
    expect(h.map((x) => [x.event, x.n, x.us, x.p50, x.max])).toEqual([[1, 3, 908, 5, 900], [0, 1, 7, 7, 7]])
    expect(h[0].buckets[1] + h[0].buckets[2] + h[0].buckets[9]).toBe(3)
  })
  it('count the blocks per wait', () => {
    const z = sizeHists([row({ block: 1 }), row({ block: 1, blocks: 8 }), row({ block: 1, blocks: 128 }), row({ block: 1, blocks: 200 })])
    expect(z).toHaveLength(1)
    expect(z[0].buckets).toEqual([1, 0, 0, 1, 0, 0, 0, 1, 1])
    expect([z[0].blocks, z[0].max]).toEqual([337, 200])
  })
})
