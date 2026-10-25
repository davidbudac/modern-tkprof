import { describe, expect, it } from 'vitest'
import { pickBucket } from './derive'

// Same table as TestBucketForSpan in internal/analyze/pivot_test.go: the two implementations must stay identical.
describe('pickBucket', () => {
  it.each([
    [-5, 0], [0, 0],
    [1, 1000], [400_999, 1000], [401_000, 10_000],
    [4_009_999, 10_000], [4_010_000, 100_000],
    [40_100_000, 1_000_000],
    [24_000_000_000, 60_000_000],
    [24_060_000_000, 600_000_000],
    [240_600_000_000, 3_600_000_000],
    [1_443_599_999_999, 3_600_000_000], // floor(span/1h) = 400
    [1_443_600_000_000, 1_443_600_000_000 / 400], // 401 h: span/400
  ])('span %d µs -> bucket %d µs', (span, want) => {
    expect(pickBucket(span)).toBe(want)
  })
})
