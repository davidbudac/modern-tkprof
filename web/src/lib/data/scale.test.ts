import { describe, expect, it } from 'vitest'
import { MIN_ZOOM_US, zoomedAxis } from './scale'

const full = { base: 1_000_000, span: 10_000_000 }
const win = (startTim: number, endTim: number) => ({ startTim, endTim })

describe('zoomedAxis', () => {
  it('is null without a zoom, on an empty axis, and when the zoom misses the axis', () => {
    expect(zoomedAxis(full, null)).toBeNull()
    expect(zoomedAxis(full, undefined)).toBeNull()
    expect(zoomedAxis({ base: 5, span: 0 }, win(1, 9))).toBeNull()
    expect(zoomedAxis(full, win(0, 1_000_000))).toBeNull() // ends where the axis starts
    expect(zoomedAxis(full, win(11_000_000, 12_000_000))).toBeNull() // starts where it ends
    expect(zoomedAxis(full, win(20_000_000, 21_000_000))).toBeNull()
  })

  it('pads the zoom by 5 % of its length on each side', () => {
    expect(zoomedAxis(full, win(4_000_000, 6_000_000))).toEqual({ base: 3_900_000, span: 2_200_000 })
  })

  it('cuts to the axis', () => {
    expect(zoomedAxis(full, win(1_000_000, 3_000_000))).toEqual({ base: 1_000_000, span: 2_100_000 }) // the left edge is the axis'
    expect(zoomedAxis(full, win(9_000_000, 11_000_000))).toEqual({ base: 8_900_000, span: 2_100_000 }) // the right edge is the axis'
    expect(zoomedAxis(full, win(0, 20_000_000))).toEqual(full) // a zoom wider than the axis shows all of it
    expect(zoomedAxis(full, win(500_000, 2_000_000))?.base).toBe(1_000_000) // starting before the axis
  })

  it('is at least MIN_ZOOM_US long, centred on the zoom, in whole µs', () => {
    expect(MIN_ZOOM_US).toBe(50)
    expect(zoomedAxis(full, win(5_000_000, 5_000_010))).toEqual({ base: 4_999_980, span: 50 })
    expect(zoomedAxis(full, win(5_000_000, 5_000_000))).toEqual({ base: 4_999_975, span: 50 })
    const odd = zoomedAxis(full, win(5_000_001, 5_000_100))!
    expect(Number.isInteger(odd.base) && Number.isInteger(odd.span)).toBe(true)
    expect(odd.base).toBeLessThanOrEqual(5_000_001)
    expect(odd.base + odd.span).toBeGreaterThanOrEqual(5_000_100)
  })

  it('never leaves the axis, even when the axis is shorter than the minimum', () => {
    expect(zoomedAxis({ base: 100, span: 20 }, win(105, 106))).toEqual({ base: 100, span: 20 })
    const edge = zoomedAxis(full, win(1_000_000, 1_000_010))!
    expect(edge.base).toBe(1_000_000)
    expect(edge.span).toBeGreaterThan(0)
  })
})
