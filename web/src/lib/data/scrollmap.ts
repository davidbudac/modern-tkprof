/**
 * Scroll geometry of the line viewer. A browser cannot scroll an element tens of millions of pixels high (Chrome stops near
 * 33 M px, Firefox near 18 M px), and a 2 GB trace has tens of millions of lines. So the scroll bar covers at most `maxH`
 * pixels and its position is mapped linearly to the first visible line; the viewer moves the rows itself.
 * Below `maxH` the mapping is exactly `scrollTop / rowH`.
 */
export interface ScrollGeometry {
  /** height of the scrollable content */
  scrollH: number
  /** largest scrollTop */
  maxScroll: number
  /** largest first-line offset (0-based, fractional): the last line ends at the bottom edge */
  maxTop: number
}

export const MAX_SCROLL_H = 8_000_000

export function scrollGeometry(total: number, viewH: number, rowH: number, maxH = MAX_SCROLL_H): ScrollGeometry {
  const scrollH = Math.max(viewH, Math.min(total * rowH, maxH))
  return { scrollH, maxScroll: Math.max(0, scrollH - viewH), maxTop: Math.max(0, total - viewH / rowH) }
}

export const clampTop = (g: ScrollGeometry, top: number) => Math.min(g.maxTop, Math.max(0, top))

export function topFromScroll(g: ScrollGeometry, scrollTop: number): number {
  return g.maxScroll > 0 ? clampTop(g, (scrollTop / g.maxScroll) * g.maxTop) : 0
}

export function scrollFromTop(g: ScrollGeometry, top: number): number {
  return g.maxTop > 0 ? (clampTop(g, top) / g.maxTop) * g.maxScroll : 0
}

/**
 * First-line offset that brings 0-based line `idx` into view: `center` puts it in the middle, `nearest` moves as little as
 * possible (no move when it is fully visible). `rows` = lines that fit (fractional).
 * The offset is a whole number of rows (a multiple of the row height): when the view's height is not a multiple of the row
 * height, a fractional offset would leave a sliver of the row above under the sticky lane row (the line goes slightly off the
 * exact middle instead; `nearest` rounds toward the line so it stays fully visible).
 */
export function revealTop(top: number, idx: number, rows: number, how: 'center' | 'nearest'): number {
  if (how === 'center') return Math.round(idx - (rows - 1) / 2)
  if (idx < top) return idx
  if (idx + 1 > top + rows) return Math.ceil(idx + 1 - rows - 1e-9)
  return top
}
