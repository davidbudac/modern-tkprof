import { describe, expect, it } from 'vitest'
import { LINE_KINDS } from './linecache'
import type { LineKind } from './lines'
import { GAP_MIN_US, anchorOf, barFrac, clockCell, fmtDelta, gapDelta, lineTim, lineTimesOf, magnitudeOf, unexplainedGap } from './linetime'

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

describe('unexplainedGap: where the line started minus where the line before ended, never negative', () => {
  it('is tim − own time − the previous tim', () => {
    expect(unexplainedGap(1000, 100, 500)).toBe(400) // started at 900, the line before ended at 500
    expect(unexplainedGap(1000, 0, 1000)).toBe(0) // no time of its own: tim to tim
    expect(unexplainedGap(1000, 0, 700)).toBe(300)
  })
  it('a line that started before the one above ended (its e= covers the waits above it; a PARSE tim before its CURSOR line) has no gap, not a negative one', () => {
    expect(unexplainedGap(1000, 637_000, 990)).toBe(0)
    expect(unexplainedGap(10804500099, 121, 10804500100)).toBe(0) // io_waits line 39: tim to tim −1 µs
    expect(unexplainedGap(1000, 100, 901)).toBe(0)
  })
  it('a missing (−1) or negative own time counts as none', () => {
    expect(unexplainedGap(1000, -1, 700)).toBe(300)
  })
})

describe('gapDelta: what the Δ column shows of a gap', () => {
  it('is blank under 50 µs', () => {
    expect(GAP_MIN_US).toBe(50)
    expect(gapDelta(0, 0)).toBeUndefined()
    expect(gapDelta(49, 0)).toBeUndefined()
    expect(gapDelta(49.9, 0)).toBeUndefined()
    expect(gapDelta(50, 0)).toEqual({ us: 50, emph: false })
    expect(gapDelta(Number.NaN, 0)).toBeUndefined()
  })
  it('is emphasised from 1 ms and twice the duration of the line before, both', () => {
    expect(gapDelta(999, 0)?.emph).toBe(false) // under 1 ms
    expect(gapDelta(1000, 0)?.emph).toBe(true)
    expect(gapDelta(1500, 750)?.emph).toBe(true) // exactly twice
    expect(gapDelta(1499, 750)?.emph).toBe(false) // just under twice
    expect(gapDelta(5000, 2600)?.emph).toBe(false) // a long line before explains a long gap after it
    expect(gapDelta(900, 10)?.emph).toBe(false) // twice the line before, but under 1 ms
  })
})

describe('barFrac: the Duration bar, log scale from 1 µs (empty) to 10 s (full)', () => {
  it('is 0 at 1 µs and below, 1 at 10 s and above, a seventh a decade', () => {
    expect(barFrac(0)).toBe(0)
    expect(barFrac(0.5)).toBe(0)
    expect(barFrac(-3)).toBe(0)
    expect(barFrac(1)).toBe(0)
    expect(barFrac(10)).toBeCloseTo(1 / 7, 10)
    expect(barFrac(1000)).toBeCloseTo(3 / 7, 10) // 1 ms
    expect(barFrac(1_000_000)).toBeCloseTo(6 / 7, 10) // 1 s
    expect(barFrac(10_000_000)).toBe(1)
    expect(barFrac(3_600_000_000)).toBe(1) // longer: clamped
  })
  it('grows with the time and tells 9 µs from 637 ms', () => {
    expect(barFrac(9)).toBeLessThan(barFrac(637_000))
    expect(barFrac(637_000)).toBeCloseTo(Math.log10(637_000) / 7, 10)
    expect(barFrac(9) * 56).toBeGreaterThan(7) // a 56 px track: a fill that shows
  })
})

describe('magnitudeOf: the weight class of a duration', () => {
  it('splits at 1 ms and 1 s', () => {
    expect(magnitudeOf(0)).toBe('us')
    expect(magnitudeOf(999)).toBe('us')
    expect(magnitudeOf(1000)).toBe('ms')
    expect(magnitudeOf(999_999)).toBe('ms')
    expect(magnitudeOf(1_000_000)).toBe('s')
    expect(magnitudeOf(2_448_000)).toBe('s')
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
