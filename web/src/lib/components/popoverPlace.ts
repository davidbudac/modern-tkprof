/** Where a popup of `size` goes (viewport coordinates, top-left corner): under the anchor box (or the point), flipped above it when the bottom edge would be crossed, clamped inside the viewport. */
export interface PopAnchor { x: number; y: number; rect?: { left: number; top: number; bottom: number } }

export function placePopup(anchor: PopAnchor, size: { w: number; h: number }, view: { w: number; h: number }, gap = 4, edge = 8): { left: number; top: number; above: boolean } {
  const left = Math.max(edge, Math.min(anchor.rect ? anchor.rect.left : anchor.x, view.w - size.w - edge))
  const below = (anchor.rect ? anchor.rect.bottom : anchor.y) + gap
  const upper = (anchor.rect ? anchor.rect.top : anchor.y) - gap - size.h
  if (below + size.h <= view.h - edge) return { left, top: below, above: false }
  if (upper >= edge) return { left, top: upper, above: true }
  // fits neither way: stay as low as the viewport allows (the popup scrolls inside its own max height)
  return { left, top: Math.max(edge, view.h - size.h - edge), above: false }
}
