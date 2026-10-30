import { describe, expect, it } from 'vitest'
import type { LineProfile } from './lines'
import { bucketOf, bucketRows, densityRows, lineAtY, lineOfBucket, stripMarks } from './linestrip'

const profile = (total: number, size: number, calls: number[], waits: number[] = calls.map(() => 0)): LineProfile => ({
  total, buckets: calls.length, size, calls, waits, cursors: calls.map(() => 0), errors: calls.map(() => 0), commits: calls.map(() => 0),
  maxCalls: Math.max(0, ...calls), maxWaits: Math.max(0, ...waits),
})

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

describe('densityRows', () => {
  it('spreads a bucket over several rows when there are more rows than buckets', () => {
    const p = profile(100, 50, [10, 5], [0, 4])
    const d = densityRows(p, 4)
    expect([...d.calls]).toEqual([1, 1, 0.5, 0.5])
    expect([...d.waits]).toEqual([0, 0, 1, 1])
  })

  it('takes the maximum of the buckets a row covers when there are fewer rows than buckets', () => {
    const p = profile(100, 10, [1, 2, 3, 4, 8, 2, 1, 1, 1, 1])
    const d = densityRows(p, 2)
    expect([...d.calls]).toEqual([1, 0.25]) // buckets 0-4 hold the max (8), buckets 5-9 at most 2
  })

  it('is flat zero when the maximum is zero or the file has no lines', () => {
    expect([...densityRows(profile(10, 10, [0]), 3).calls]).toEqual([0, 0, 0])
    expect(densityRows(profile(0, 1, []), 5).calls.every((v) => v === 0)).toBe(true)
  })

  it('does not bleed into a neighbouring bucket at exact edges', () => {
    const p = profile(100, 10, [0, 9, 0, 0, 0, 0, 0, 0, 0, 0])
    const rows = [...bucketRows(p.calls, p, 10)]
    expect(rows).toEqual([0, 9, 0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('handles a last bucket shorter than the rest', () => {
    const p = profile(25, 10, [1, 1, 5])
    const rows = bucketRows(p.calls, p, 5) // 5 lines per row
    expect([...rows]).toEqual([1, 1, 1, 1, 5])
  })
})
