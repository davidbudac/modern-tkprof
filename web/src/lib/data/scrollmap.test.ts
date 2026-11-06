import { describe, expect, it } from 'vitest'
import { MAX_SCROLL_H, clampTop, revealTop, scrollFromTop, scrollGeometry, topFromScroll } from './scrollmap'

describe('scroll geometry', () => {
  it('is exactly pixel per row below the cap', () => {
    const g = scrollGeometry(10_000, 600, 20)
    expect(g.scrollH).toBe(200_000)
    expect(topFromScroll(g, 4000)).toBeCloseTo(200, 6)
    expect(scrollFromTop(g, 200)).toBeCloseTo(4000, 6)
  })

  it('caps the scrollable height and still reaches both ends of a huge file', () => {
    const total = 40_000_000 // a 2 GB trace
    const g = scrollGeometry(total, 600, 20)
    expect(g.scrollH).toBe(MAX_SCROLL_H)
    expect(topFromScroll(g, 0)).toBe(0)
    expect(topFromScroll(g, g.maxScroll)).toBeCloseTo(total - 30, 6) // the last 30 rows fill the view
    expect(scrollFromTop(g, total / 2)).toBeGreaterThan(0)
  })

  it('round-trips through the mapping', () => {
    const g = scrollGeometry(3_000_000, 900, 20)
    for (const top of [0, 1, 12345.5, 1_500_000, 2_999_000]) {
      expect(topFromScroll(g, scrollFromTop(g, top))).toBeCloseTo(clampTop(g, top), 3)
    }
  })

  it('has nothing to scroll when the file fits', () => {
    const g = scrollGeometry(10, 600, 20)
    expect(g.maxTop).toBe(0)
    expect(topFromScroll(g, 0)).toBe(0)
    expect(scrollFromTop(g, 5)).toBe(0)
  })
})

describe('revealTop', () => {
  it('centers a line', () => {
    expect(revealTop(0, 100, 31, 'center')).toBe(85)
  })
  it('moves only as far as needed for nearest', () => {
    expect(revealTop(50, 60, 20, 'nearest')).toBe(50)
    expect(revealTop(50, 40, 20, 'nearest')).toBe(40)
    expect(revealTop(50, 75, 20, 'nearest')).toBe(56)
  })
  it('lands on a whole row when the view is not a multiple of the row height', () => {
    // 618 px of 20 px rows = 30.9 rows: the first row must not be a sliver
    expect(revealTop(0, 100, 30.9, 'center')).toBe(85)
    expect(Number.isInteger(revealTop(0, 100, 30.9, 'center'))).toBe(true)
    expect(Number.isInteger(revealTop(0, 100, 30.5, 'center'))).toBe(true)
    expect(Number.isInteger(revealTop(0, 117, 29.1, 'center'))).toBe(true)
    // below the view: the line ends inside the view, never cut off at the bottom
    const t = revealTop(0, 100, 30.9, 'nearest')
    expect(Number.isInteger(t)).toBe(true)
    expect(100 + 1).toBeLessThanOrEqual(t + 30.9)
    expect(t).toBe(71)
    // a whole number of rows needs no rounding
    expect(revealTop(0, 100, 30, 'nearest')).toBe(71)
  })
})
