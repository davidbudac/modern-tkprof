import { describe, expect, it } from 'vitest'
import { changedChars, sharedEnds } from './motion'

describe('sharedEnds', () => {
  it('finds the shared start and end of a label', () => {
    expect(sharedEnds('Copy line', 'Copied')).toEqual({ start: 3, end: 0 })
    expect(sharedEnds('Follow', 'Following')).toEqual({ start: 6, end: 0 })
    expect(sharedEnds('2.355 s', '638 ms')).toEqual({ start: 0, end: 1 })
  })
  it('never counts a run twice', () => {
    expect(sharedEnds('aa', 'aaa')).toEqual({ start: 2, end: 0 })
    expect(sharedEnds('same', 'same')).toEqual({ start: 4, end: 0 })
    expect(sharedEnds('', 'x')).toEqual({ start: 0, end: 0 })
  })
})

describe('changedChars', () => {
  it('compares a number of the same length digit by digit', () => {
    // 6.459 → 6.519: the 5 and the 9 stay where they are
    expect(changedChars('6.459 s', '6.519 s')).toEqual([false, false, true, true, false, false, false])
    expect(changedChars('41', '42')).toEqual([false, true])
  })
  it('keeps the shared start and end of a number that grows', () => {
    // 99 ms → 100 ms: the unit stays still
    expect(changedChars('99 ms', '100 ms')).toEqual([true, true, true, false, false, false])
    expect(changedChars('9', '10')).toEqual([true, true])
  })
})
