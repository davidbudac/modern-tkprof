import { describe, expect, it } from 'vitest'
import { LINE_KINDS } from './linecache'
import type { LineKind } from './lines'
import { durOf, gapBefore, timOf } from './gaps'

const EXEC = 'EXEC #140646291810920:c=832,e=1025,p=0,cr=0,cu=0,mis=1,r=0,dep=1,og=1,plh=3937172027,tim=54958079261'
const WAIT = "WAIT #140124363549808: nam='db file sequential read' ela= 100 file#=10 block#=66151 blocks=1 obj#=721 tim=10778995443"
const XCTEND = 'XCTEND rlbk=0, rd_only=1, tim=10817777368'

describe('timOf', () => {
  it('reads tim of calls, waits and XCTEND', () => {
    expect(timOf(EXEC, 'call')).toBe(54958079261)
    expect(timOf(WAIT, 'wait')).toBe(10778995443)
    expect(timOf(XCTEND, 'xctend')).toBe(10817777368)
  })
  it('is undefined for other kinds and lines without tim', () => {
    expect(timOf(EXEC, 'stat')).toBeUndefined()
    expect(timOf('', 'blank')).toBeUndefined()
    expect(timOf('EXEC #1:c=1,e=1', 'call')).toBeUndefined()
    expect(timOf('EXEC #1:c=1,tim=', 'call')).toBeUndefined()
  })
  it('is undefined for tim=0 (timed_statistics=false, stats_basic.trc)', () => {
    expect(timOf("WAIT #140426399032616: nam='SQL*Net message to client' ela= 0 driver id=1952673792 #bytes=1 p3=0 obj#=-1 tim=0", 'wait')).toBeUndefined()
  })
})

describe('durOf', () => {
  it('is e= of a call and ela= of a wait, 0 otherwise', () => {
    expect(durOf(EXEC, 'call')).toBe(1025)
    expect(durOf(WAIT, 'wait')).toBe(100)
    expect(durOf(XCTEND, 'xctend')).toBe(0)
    expect(durOf('EXEC #1:c=1', 'call')).toBe(0)
  })
})

function cacheOf(lines: Map<number, [string, LineKind]>) {
  return {
    line: (n: number) => {
      const l = lines.get(n)
      return l ? { text: l[0], kind: LINE_KINDS.indexOf(l[1]) } : undefined
    },
  }
}
const w = (ela: number, tim: number): [string, LineKind] => [`WAIT #1: nam='x' ela= ${ela} p1=0 p2=0 p3=0 obj#=-1 tim=${tim}`, 'wait']
const c = (e: number, tim: number): [string, LineKind] => [`EXEC #1:c=1,e=${e},p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=${tim}`, 'call']

describe('gapBefore', () => {
  const cache = cacheOf(new Map<number, [string, LineKind]>([
    [1, w(100, 1000)],
    [2, ['', 'blank']],
    [3, w(50, 5000)], // starts at 4950: 3950 after line 1 (blank skipped)
    [4, c(300, 5300)], // starts at 5000: 0 after line 3
    [5, c(1000, 5200)], // starts at 4200: before the end of line 4
    [6, ['STAT #1 id=1', 'stat']],
    [7, c(10, 9000)], // starts at 8990: 3790 after line 5
  ]))
  it('is start minus the tim of the previous line with a tim, for waits and XCTEND', () => {
    expect(gapBefore(cache, 3)).toEqual({ us: 3950, fromLine: 1 })
    const x = cacheOf(new Map<number, [string, LineKind]>([[1, w(100, 1000)], [2, ['XCTEND rlbk=0, rd_only=1, tim=4000', 'xctend']], [3, w(10, 4500)]]))
    expect(gapBefore(x, 2)).toEqual({ us: 3000, fromLine: 1 })
    expect(gapBefore(x, 3)).toEqual({ us: 490, fromLine: 2 })
  })
  it('compares a call with the previous call, not with the waits printed before it', () => {
    const m = cacheOf(new Map<number, [string, LineKind]>([
      [1, c(100, 1000)], // ends at 1000
      [2, w(300, 1900)], // the waits of the next call
      [3, w(200, 2300)],
      [4, c(1500, 2400)], // starts at 900 (before the first wait); against the waits it would be -ve, against line 1 it is -100
      [5, w(50, 9950)],
      [6, c(500, 10000)], // starts at 9500: 7100 after line 4, whatever the wait at 5 says
    ]))
    expect(gapBefore(m, 4)).toBeNull()
    expect(gapBefore(m, 6)).toEqual({ us: 7100, fromLine: 4 })
    // the wait before the call still compares with the line before it
    expect(gapBefore(m, 3)).toEqual({ us: 2100 - 1900, fromLine: 2 })
    const g = cacheOf(new Map<number, [string, LineKind]>([[1, c(100, 1000)], [2, w(300, 4900)], [3, c(5000, 5000)]]))
    expect(gapBefore(g, 3)).toBeNull() // the call starts at 0, before its predecessor ended
    const g2 = cacheOf(new Map<number, [string, LineKind]>([[1, c(100, 1000)], [2, w(300, 4900)], [3, c(3000, 5000)]]))
    expect(gapBefore(g2, 3)).toEqual({ us: 1000, fromLine: 1 }) // starts at 2000, waits at 4600..4900 are inside it
  })
  it('is null for a zero or negative gap', () => {
    expect(gapBefore(cache, 4)).toBeNull()
    expect(gapBefore(cache, 5)).toBeNull()
  })
  it('is null without a tim, without an earlier tim, or at an unloaded line', () => {
    expect(gapBefore(cache, 2)).toBeNull()
    expect(gapBefore(cache, 6)).toBeNull()
    expect(gapBefore(cache, 1)).toBeNull()
    expect(gapBefore(cache, 99)).toBeNull()
    const holes = cacheOf(new Map<number, [string, LineKind]>([[1, w(1, 10)], [3, w(1, 5000)]]))
    expect(gapBefore(holes, 3)).toBeNull()
  })
  it('stops after maxBack lines', () => {
    const m = new Map<number, [string, LineKind]>([[1, w(1, 10)], [5, w(1, 5000)]])
    for (let n = 2; n < 5; n++) m.set(n, ['', 'blank'])
    expect(gapBefore(cacheOf(m), 5)).toEqual({ us: 4989, fromLine: 1 })
    expect(gapBefore(cacheOf(m), 5, 3)).toBeNull()
    expect(gapBefore(cacheOf(m), 5, 4)).toEqual({ us: 4989, fromLine: 1 })
  })
})
