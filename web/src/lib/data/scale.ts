// Axis helpers shared by the Overview ledger and the lanes.

export interface Tick { us: number; label: string }

/** A "nice" step (1, 2, 5 × 10^k µs) giving 4–10 ticks over the span. */
export function niceStep(spanUs: number, target = 7): number {
  if (spanUs <= 0) return 1
  const raw = spanUs / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag
  return 10 * mag
}

/** Short duration label for a tick of the given step: "1", "2.5", "500 ms", "1 min". */
export function tickLabel(us: number, stepUs: number): string {
  if (us === 0) return '0'
  if (stepUs >= 60e6) return `${(us / 60e6).toFixed(0)} min`
  if (stepUs >= 1e6) return (us / 1e6).toFixed(0)
  if (stepUs >= 100_000) return `${(us / 1e6).toFixed(1)}`
  if (stepUs >= 1000) return `${(us / 1000).toFixed(0)} ms`
  return `${us.toFixed(0)} µs`
}

/** Unit the tick labels are in, for the first tick ("0 s"). */
export function tickUnit(stepUs: number): string {
  if (stepUs >= 60e6) return 'min'
  if (stepUs >= 100_000) return 's'
  if (stepUs >= 1000) return 'ms'
  return 'µs'
}

export function ticks(spanUs: number, target = 7): { step: number; at: number[] } {
  const step = niceStep(spanUs, target)
  const at: number[] = []
  for (let t = 0; t < spanUs - step * 0.35; t += step) at.push(t)
  return { step, at }
}

/** The shortest stretch the zoomed lanes show, µs. */
export const MIN_ZOOM_US = 50

/**
 * The range the zoomed Overview lanes show: `zoom` (the top of the zoom stack) padded by 5 % of its length on each side, at
 * least `MIN_ZOOM_US` long (centred on the zoom), in whole µs, cut to the axis `full`. Null when there is no zoom or it misses the
 * axis (the selection changed): the lanes then show the whole axis.
 */
export function zoomedAxis(full: { base: number; span: number }, zoom: { startTim: number; endTim: number } | null | undefined): { base: number; span: number } | null {
  if (!zoom || full.span <= 0) return null
  const end = full.base + full.span
  if (zoom.endTim <= full.base || zoom.startTim >= end) return null
  const len = Math.max(0, zoom.endTim - zoom.startTim)
  let lo = zoom.startTim - 0.05 * len, hi = zoom.endTim + 0.05 * len
  if (hi - lo < MIN_ZOOM_US) { const mid = (zoom.startTim + zoom.endTim) / 2; lo = mid - MIN_ZOOM_US / 2; hi = mid + MIN_ZOOM_US / 2 }
  lo = Math.max(Math.floor(lo), full.base)
  hi = Math.min(Math.ceil(hi), end)
  return hi > lo ? { base: lo, span: hi - lo } : null
}

const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
export function numberWord(n: number): string { return words[n] ?? String(n) }
