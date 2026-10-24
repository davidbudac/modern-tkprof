import { describe, expect, it } from 'vitest'
import { fmtDurDelta, fmtIntDelta, fmtPctDelta, worse } from './delta'

describe('delta formatting', () => {
  it('signs time deltas with a real minus sign', () => {
    expect(fmtDurDelta(0)).toBe('0')
    expect(fmtDurDelta(1_200_000)).toBe('+1.200 s')
    expect(fmtDurDelta(-35_000)).toBe('−35.0 ms')
  })
  it('signs integer deltas with thousands separators', () => {
    expect(fmtIntDelta(0)).toBe('0')
    expect(fmtIntDelta(1234)).toBe('+1,234')
    expect(fmtIntDelta(-7)).toBe('−7')
  })
  it('formats percent change', () => {
    expect(fmtPctDelta(0, 0)).toBe('–')
    expect(fmtPctDelta(0, 5)).toBe('new')
    expect(fmtPctDelta(100, 100)).toBe('0%')
    expect(fmtPctDelta(100, 150)).toBe('+50%')
    expect(fmtPctDelta(200, 150)).toBe('−25%')
    expect(fmtPctDelta(100, 105)).toBe('+5.0%')
    expect(fmtPctDelta(100, 20000)).toBe('+19,900%')
  })
  it('classifies direction: larger is worse', () => {
    expect(worse(5)).toBe('up')
    expect(worse(-5)).toBe('down')
    expect(worse(0)).toBe('')
  })
})
