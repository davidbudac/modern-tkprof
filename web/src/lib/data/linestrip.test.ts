import { describe, expect, it } from 'vitest'
import { bucketOf, bucketRows, lineAtY, lineOfBucket, stmtRows, stripMarks, stripeSpans, type BinShape } from './linestrip'

const shape = (total: number, size: number, buckets: number): BinShape => ({ total, size, buckets })

describe('buckets and lines', () => {
  it('maps a line to its bucket and back to the bucket\'s first line', () => {
    expect(bucketOf(1, 50)).toBe(0)
    expect(bucketOf(50, 50)).toBe(0)
    expect(bucketOf(51, 50)).toBe(1)
    expect(lineOfBucket(0, 50)).toBe(1)
    expect(lineOfBucket(3, 50)).toBe(151)
    for (const n of [1, 7, 50, 51, 999]) expect(bucketOf(lineOfBucket(bucketOf(n, 50), 50), 50)).toBe(bucketOf(n, 50))
  })

  it('maps a pixel row to a line within the file', () => {
    expect(lineAtY(0, 100, 1000)).toBe(1)
    expect(lineAtY(50, 100, 1000)).toBe(501)
    expect(lineAtY(99.9, 100, 1000)).toBe(1000)
    expect(lineAtY(-5, 100, 1000)).toBe(1)
    expect(lineAtY(500, 100, 1000)).toBe(1000)
    expect(lineAtY(10, 100, 0)).toBe(1)
  })
})

describe('stripMarks', () => {
  it('collapses lines to the pixel rows they fall in', () => {
    expect([...stripMarks([1, 2, 3, 500, 1000], 1000, 100)].sort((a, b) => a - b)).toEqual([0, 49, 99])
  })
  it('keeps lines apart when the file is shorter than the strip', () => {
    expect([...stripMarks([1, 2, 3], 3, 30)].sort((a, b) => a - b)).toEqual([0, 10, 20])
  })
  it('skips lines outside the file and handles empty input', () => {
    expect(stripMarks([0, 5, -1], 4, 10).size).toBe(0)
    expect(stripMarks([1], 0, 10).size).toBe(0)
    expect(stripMarks([1], 10, 0).size).toBe(0)
    expect(stripMarks(new Map([[3, 1]]).keys(), 10, 10).has(2)).toBe(true)
  })
})

describe('bucketRows', () => {
  it('spreads a bucket over several rows when there are more rows than buckets', () => {
    expect([...bucketRows([10, 5], shape(100, 50, 2), 4)]).toEqual([10, 10, 5, 5])
  })

  it('takes the maximum of the buckets a row covers when there are fewer rows than buckets', () => {
    expect([...bucketRows([1, 2, 3, 4, 8, 2, 1, 1, 1, 1], shape(100, 10, 10), 2)]).toEqual([8, 2]) // buckets 0-4 hold the max (8), buckets 5-9 at most 2
  })

  it('does not bleed into a neighbouring bucket at exact edges', () => {
    expect([...bucketRows([0, 9, 0, 0, 0, 0, 0, 0, 0, 0], shape(100, 10, 10), 10)]).toEqual([0, 9, 0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('handles a last bucket shorter than the rest', () => {
    expect([...bucketRows([1, 1, 5], shape(25, 10, 3), 5)]).toEqual([1, 1, 1, 1, 5]) // 5 lines per row
  })

  it('is empty for a file without lines or a strip without height', () => {
    expect([...bucketRows([], shape(0, 1, 0), 3)]).toEqual([0, 0, 0])
    expect(bucketRows([1], shape(10, 10, 1), 0).length).toBe(0)
  })
})

describe('stmtRows', () => {
  it('marks the pixel rows each statement has a line in, the statements apart', () => {
    // 100 lines in 10 buckets, a strip of 5 rows (20 lines each): statement 0 in buckets 0 and 9, statement 1 in bucket 4 only
    const r = stmtRows([[3, 0, 0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 2, 0, 0, 0, 0, 0]], shape(100, 10, 10), 5)
    expect(r.map((a) => [...a])).toEqual([[1, 0, 0, 0, 1], [0, 0, 1, 0, 0]])
  })
  it('keeps a single line visible: one line of a 112,000-line file lights its pixel row', () => {
    const counts = new Array<number>(2000).fill(0)
    counts[1000] = 1 // the lines 56,001..56,056
    const r = stmtRows([counts], shape(112_000, 56, 2000), 700)
    expect(r[0].reduce((a, b) => a + b, 0)).toBe(1)
    expect(r[0][350]).toBe(1)
  })
  it('a statement with no lines draws nothing', () => {
    expect(stmtRows([[0, 0, 0]], shape(30, 10, 3), 6)[0].every((v) => v === 0)).toBe(true)
    expect(stmtRows([], shape(30, 10, 3), 6)).toEqual([])
  })
})

describe('stripeSpans', () => {
  it('one statement takes the whole width', () => {
    expect(stripeSpans([3], 10)).toEqual([{ k: 3, x: 0, w: 10 }])
  })
  it('several split the width into stripes, in order', () => {
    expect(stripeSpans([0, 2], 10)).toEqual([{ k: 0, x: 0, w: 5 }, { k: 2, x: 5, w: 5 }])
    expect(stripeSpans([1, 2, 4], 10).map((s) => s.w)).toEqual([3, 4, 3])
  })
  it('keeps the first statements when more are present than stripes fit', () => {
    const s = stripeSpans([5, 6, 7, 8, 9, 10, 11], 10)
    expect(s.map((x) => x.k)).toEqual([5, 6, 7, 8, 9])
    expect(s.every((x) => x.w >= 2)).toBe(true)
    expect(s[s.length - 1].x + s[s.length - 1].w).toBe(10)
  })
  it('nothing present or no width draws nothing', () => {
    expect(stripeSpans([], 10)).toEqual([])
    expect(stripeSpans([1], 0)).toEqual([])
  })
})
