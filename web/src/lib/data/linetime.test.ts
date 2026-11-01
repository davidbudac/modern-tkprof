import { describe, expect, it } from 'vitest'
import { LINE_KINDS } from './linecache'
import type { LineKind } from './lines'
import { anchorOf, clockCell, fmtDelta, lineTim, lineTimesOf } from './linetime'

const EXEC = 'EXEC #140646291810920:c=832,e=1025,p=0,cr=0,cu=0,mis=1,r=0,dep=1,og=1,plh=3937172027,tim=1000500'
const WAIT = "WAIT #140124363549808: nam='db file sequential read' ela= 100 file#=10 block#=66151 blocks=1 obj#=721 tim=1000000"
const PARSE = "PARSING IN CURSOR #140605542739672 len=22 dep=0 uid=165 oct=47 lid=165 tim=999000 hv=1526946288 ad='8cf16998' sqlid='f9p8d99dh6qgh'"
const XCTEND = 'XCTEND rlbk=0, rd_only=1, tim=2752000'
const k = (kind: LineKind) => LINE_KINDS.indexOf(kind)

// 2026-03-04 05:06:07.000000 UTC as the wall clock of tim 1000000
const WALL0 = Date.UTC(2026, 2, 4, 5, 6, 7) * 1000
const withWall = { wallOffsetUs: WALL0 - 1_000_000, tzOffsetMin: 60, span: { firstTim: 990_000 } }
const noWall = { wallOffsetUs: 0, tzOffsetMin: 0, span: { firstTim: 990_000 } }

describe('lineTim', () => {
  it('reads tim of calls, waits, XCTEND and PARSING IN CURSOR', () => {
    expect(lineTim(EXEC, 'call')).toBe(1000500)
    expect(lineTim(WAIT, 'wait')).toBe(1000000)
    expect(lineTim(XCTEND, 'xctend')).toBe(2752000)
    expect(lineTim(PARSE, 'parsing-in-cursor')).toBe(999000)
  })
  it('is undefined for lines that print no time of their own', () => {
    expect(lineTim(' Bind#0', 'bind-line')).toBeUndefined()
    expect(lineTim('select 1 from dual', 'sql-text')).toBeUndefined()
    expect(lineTim('*** 2026-03-04T05:06:07.000000+01:00', 'marker')).toBeUndefined()
  })
})

describe('clockCell', () => {
  it('shows the wall clock in the trace zone, with date and µs in the title', () => {
    expect(clockCell(1_000_250, withWall)).toEqual({ text: '06:06:07.000', title: '2026-03-04 06:06:07.000250 UTC+01:00' })
  })
  it('falls back to the offset from the first tim without a wall clock', () => {
    const c = clockCell(1_002_345, noWall)
    expect(c.text).toBe('+0.012 s')
    expect(c.title).toContain('12,345 µs')
  })
})

describe('fmtDelta', () => {
  it('is signed, with a unit that fits', () => {
    expect(fmtDelta(412)).toBe('+412 µs')
    expect(fmtDelta(-1830)).toBe('−1.83 ms')
    expect(fmtDelta(138_200)).toBe('+138 ms')
    expect(fmtDelta(1_752_000)).toBe('+1.752 s')
    expect(fmtDelta(0)).toBe('+0 µs')
  })
})

describe('lineTimesOf', () => {
  it('is undefined with both columns off', () => {
    expect(lineTimesOf(withWall, { clock: false, delta: false }, null)).toBeUndefined()
  })
  it('gives the clock and the delta from the anchor; the anchor row is marked', () => {
    const t = lineTimesOf(withWall, { clock: true, delta: true }, { line: 10, tim: 1_000_000 })!
    expect(t.at(10, WAIT, k('wait'))).toMatchObject({ clock: '06:06:07.000', anchor: true })
    expect(t.at(10, WAIT, k('wait')).delta).toBeUndefined()
    expect(t.at(11, EXEC, k('call'))).toMatchObject({ delta: '+500 µs', anchor: false })
    expect(t.at(9, PARSE, k('parsing-in-cursor')).delta).toBe('−1.00 ms')
    expect(t.at(11, EXEC, k('call')).deltaTitle).toBe('+500 µs from line 10')
  })
  it('leaves the cells of a line without a tim empty', () => {
    const t = lineTimesOf(withWall, { clock: true, delta: true }, { line: 10, tim: 1_000_000 })!
    expect(t.at(12, ' Bind#0', k('bind-line'))).toEqual({ anchor: false })
  })
  it('only fills the columns that are on', () => {
    const t = lineTimesOf(withWall, { clock: false, delta: true }, { line: 10, tim: 1_000_000 })!
    expect(t.at(11, EXEC, k('call')).clock).toBeUndefined()
    const c = lineTimesOf(withWall, { clock: true, delta: false }, { line: 10, tim: 1_000_000 })!
    expect(c.at(11, EXEC, k('call')).delta).toBeUndefined()
  })
})

describe('anchorOf', () => {
  const lines: Record<number, { text: string; kind: number }> = {
    1: { text: PARSE, kind: k('parsing-in-cursor') },
    2: { text: 'select 1 from dual', kind: k('sql-text') },
    3: { text: WAIT, kind: k('wait') },
    4: { text: ' Bind#0', kind: k('bind-line') },
    5: { text: EXEC, kind: k('call') },
  }
  const cache = { line: (n: number) => lines[n] }
  it('is the selected line when it is in view and has a tim', () => {
    expect(anchorOf(cache, 2, 4, 5)).toEqual({ line: 5, tim: 1000500 })
  })
  it('is the first timed line in view when the selection is out of view or has no tim', () => {
    expect(anchorOf(cache, 2, 4, 40)).toEqual({ line: 3, tim: 1000000 })
    expect(anchorOf(cache, 2, 4, 4)).toEqual({ line: 3, tim: 1000000 })
  })
  it('is null when no line in view has a tim (or none is loaded)', () => {
    expect(anchorOf(cache, 4, 1, 4)).toBeNull()
    expect(anchorOf(cache, 100, 10, 1)).toBeNull()
  })
})
