import { describe, expect, it } from 'vitest'
import { pickBucket, selectionBucket, statementPhases, statementWaitSpans } from './derive'
import { makeDoc } from './testdoc'
import phasesCase from './testdata/phases-case.json'
import waitSpansCase from './testdata/waitspans-case.json'

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

describe('selectionBucket', () => {
  it('is the selection\'s own bucket while the whole trace stays within the cap', () => {
    expect(selectionBucket(600e6, 5e6)).toBe(pickBucket(5e6))
    expect(selectionBucket(600e6, 600e6)).toBe(pickBucket(600e6))
  })
  it('is raised when the whole trace would give too many buckets', () => {
    const b = selectionBucket(86400e6, 5e6)
    expect(b).toBeGreaterThan(pickBucket(5e6))
    expect(Math.floor(86400e6 / b)).toBeLessThanOrEqual(20000)
  })
  it('falls back to the whole trace\'s bucket for an unknown selection', () => {
    expect(selectionBucket(600e6, 0)).toBe(pickBucket(600e6))
  })
})

// Same case as TestStmtPhasesOnSharedCase in internal/analyze/phases_test.go (one shared JSON file).
describe('statementPhases', () => {
  it('cuts the calls into phase segments like the engine', async () => {
    const doc = await makeDoc(phasesCase.calls.map((c) => ({ ctx: 0, stmt: 0, kind: c.kind, e: c.e, tim: c.tim })))
    expect(statementPhases(doc, 0, phasesCase.gapUs)).toEqual(phasesCase.expect)
  })
  it('skips calls without tim and keeps nothing for an unknown statement', async () => {
    const doc = await makeDoc([{ ctx: 0, stmt: 0, kind: 2, e: 10 }])
    expect(statementPhases(doc, 0, 100)).toEqual([])
    expect(statementPhases(doc, 1, 100)).toEqual([])
  })
})

// Same case as TestStmtWaitSpansOnSharedCase in internal/analyze/waitspans_test.go (one shared JSON file).
describe('statementWaitSpans', () => {
  it('cuts the waits into segments like the engine', async () => {
    const doc = await makeDoc([], { waits: waitSpansCase.waits.map((w) => ({ ctx: 0, stmt: 0, event: w.event, ela: w.ela, tim: w.tim })) })
    expect(statementWaitSpans(doc, 0, waitSpansCase.gapUs)).toEqual(waitSpansCase.expect)
  })
  it('keeps what the filter lets through, skips waits without tim, ignores other statements', async () => {
    const doc = await makeDoc([], { waits: [
      { ctx: 0, stmt: 0, event: 1, ela: 10, tim: 100 }, { ctx: 0, stmt: 0, event: 2, ela: 10, tim: 0 },
      { ctx: 0, stmt: 1, event: 3, ela: 10, tim: 100 }, { ctx: 0, stmt: 0, event: 4, ela: 10, tim: 5000, idle: true },
    ] })
    expect(statementWaitSpans(doc, 0, 0).map((s) => s.event)).toEqual([1, 4])
    expect(statementWaitSpans(doc, 0, 0, (i) => !(doc.waits.flags[i] & 2)).map((s) => s.event)).toEqual([1])
  })
})
