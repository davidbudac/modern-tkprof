import { describe, expect, it } from 'vitest'
import { addRange, describeLines, hasLine, lineCount, removeLine, toggleLine } from './lineset'

describe('lineset', () => {
  it('adds ranges in order and merges touching or overlapping ones', () => {
    let s = addRange([], 10, 12)
    s = addRange(s, 20, 20)
    s = addRange(s, 1, 2)
    expect(s).toEqual([{ from: 1, to: 2 }, { from: 10, to: 12 }, { from: 20, to: 20 }])
    expect(addRange(s, 13, 19)).toEqual([{ from: 1, to: 2 }, { from: 10, to: 20 }])
    expect(addRange(s, 15, 3)).toEqual([{ from: 1, to: 15 }, { from: 20, to: 20 }])
  })
  it('toggles a line in and out, splitting a range', () => {
    let s = toggleLine([{ from: 5, to: 9 }], 7)
    expect(s).toEqual([{ from: 5, to: 6 }, { from: 8, to: 9 }])
    s = toggleLine(s, 7)
    expect(s).toEqual([{ from: 5, to: 9 }])
    expect(removeLine([{ from: 5, to: 5 }], 5)).toEqual([])
  })
  it('finds lines, counts and describes', () => {
    const s = [{ from: 1, to: 3 }, { from: 8, to: 8 }, { from: 20, to: 25 }, { from: 40, to: 40 }]
    expect([0, 1, 3, 4, 8, 25, 26, 40].map((n) => hasLine(s, n))).toEqual([false, true, true, false, true, true, false, true])
    expect(hasLine(null, 1)).toBe(false)
    expect(lineCount(s)).toBe(11)
    expect(describeLines(s.slice(0, 3))).toBe('1–3, 8, 20–25')
    expect(describeLines(s)).toBe('1–3, 8, 20–25, … (4 ranges)')
  })
})
