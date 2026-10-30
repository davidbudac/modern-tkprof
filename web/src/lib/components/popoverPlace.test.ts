import { describe, expect, it } from 'vitest'
import { placePopup } from './popoverPlace'

const view = { w: 1000, h: 800 }
describe('placePopup', () => {
  it('opens under the anchor box, aligned to its left edge', () => {
    expect(placePopup({ x: 0, y: 0, rect: { left: 100, top: 200, bottom: 220 } }, { w: 400, h: 300 }, view)).toEqual({ left: 100, top: 224, above: false })
  })
  it('flips above when the bottom would be crossed', () => {
    expect(placePopup({ x: 0, y: 0, rect: { left: 100, top: 600, bottom: 620 } }, { w: 400, h: 300 }, view)).toEqual({ left: 100, top: 296, above: true })
  })
  it('clamps to the right edge and to the left edge', () => {
    expect(placePopup({ x: 950, y: 10 }, { w: 400, h: 100 }, view).left).toBe(592)
    expect(placePopup({ x: -50, y: 10 }, { w: 400, h: 100 }, view).left).toBe(8)
  })
  it('uses the point when there is no box', () => {
    expect(placePopup({ x: 300, y: 100 }, { w: 200, h: 100 }, view)).toEqual({ left: 300, top: 104, above: false })
  })
  it('stays inside the viewport when it fits neither way', () => {
    const p = placePopup({ x: 10, y: 400, rect: { left: 10, top: 390, bottom: 410 } }, { w: 200, h: 780 }, view)
    expect(p.top).toBe(12)
  })
})
