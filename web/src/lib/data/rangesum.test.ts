import { describe, expect, it } from 'vitest'
import { LINE_KINDS } from './linecache'
import type { LineKind } from './lines'
import { describeRange, summarizeLines, summarizeRange, type RangeSum } from './rangesum'

const L: [string, LineKind][] = [
  ['BINDS #1:', 'binds'], // 1
  [' Bind#0', 'bind-line'], // 2
  ['  oacdty=02 mxl=22(22)', 'bind-line'], // 3
  [' Bind#1', 'bind-line'], // 4
  ['EXEC #1:c=800,e=1200,p=0,cr=0,cu=0,mis=0,r=3,dep=0,og=1,plh=0,tim=5000', 'call'], // 5
  ["WAIT #1: nam='db file sequential read' ela= 4000 file#=1 block#=2 blocks=1 obj#=-1 tim=6000", 'wait'], // 6
  ["WAIT #1: nam='SQL*Net message from client' ela= 150 driver id=1 #bytes=1 p3=0 obj#=-1 tim=6200", 'wait'], // 7
  ['FETCH #1:c=100,e=300,p=0,cr=0,cu=0,mis=0,r=9,dep=0,og=1,plh=0,tim=6500', 'call'], // 8
  ['ERROR #1:err=1 tim=6600', 'error'], // 9
  ['XCTEND rlbk=0, rd_only=1, tim=6700', 'xctend'], // 10
]
const cache = {
  line: (n: number) => {
    const l = L[n - 1]
    return l ? { text: l[0], kind: LINE_KINDS.indexOf(l[1]) } : undefined
  },
}

describe('summarizeRange', () => {
  it('sums calls, waits, binds, errors and commits', () => {
    expect(summarizeRange(cache, 1, 10)).toEqual({
      lines: 10, loaded: 10, calls: 2, callUs: 1500, cpuUs: 900, rows: 12, waits: 2, waitUs: 4150, binds: 2, errors: 1, commits: 1,
    })
  })
  it('takes a sub range in either order', () => {
    const s = summarizeRange(cache, 7, 5)
    expect(s).toMatchObject({ lines: 3, loaded: 3, calls: 1, callUs: 1200, rows: 3, waits: 2 })
  })
  it('skips unloaded lines', () => {
    const s = summarizeRange(cache, 9, 14)
    expect(s).toMatchObject({ lines: 6, loaded: 2, errors: 1, commits: 1 })
  })
  it('adds up the ranges of a line set', () => {
    expect(summarizeLines(cache, [{ from: 5, to: 5 }, { from: 8, to: 9 }])).toMatchObject({ lines: 3, loaded: 3, calls: 2, callUs: 1500, rows: 12, errors: 1, waits: 0 })
  })
})

describe('describeRange', () => {
  const zero: RangeSum = { lines: 1, loaded: 1, calls: 0, callUs: 0, cpuUs: 0, rows: 0, waits: 0, waitUs: 0, binds: 0, errors: 0, commits: 0 }
  it('omits zero groups', () => {
    expect(describeRange(zero)).toBe('1 line')
    expect(describeRange({ ...zero, lines: 12, loaded: 12, calls: 3, callUs: 1200, cpuUs: 800, waits: 4, waitUs: 8100, rows: 12 }))
      .toBe('12 lines · 3 calls 1.20 ms (CPU 800 µs) · 4 waits 8.10 ms · 12 rows')
  })
  it('lists binds, errors and commits and singular counts', () => {
    expect(describeRange({ ...zero, lines: 4, loaded: 4, binds: 1, errors: 1, commits: 2, rows: 1 })).toBe('4 lines · 1 row · 1 bind · 1 error · 2 commits')
  })
  it('notes the lines that are not loaded', () => {
    expect(describeRange({ ...zero, lines: 6, loaded: 2, errors: 1 })).toBe('6 lines · 1 error (4 not loaded)')
    expect(describeRange(summarizeRange(cache, 1, 10))).toBe('10 lines · 2 calls 1.50 ms (CPU 900 µs) · 2 waits 4.15 ms · 12 rows · 2 binds · 1 error · 1 commit')
  })
})
