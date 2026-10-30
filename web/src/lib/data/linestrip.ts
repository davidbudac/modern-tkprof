import type { LineProfile } from './lines'

/** The part of a profile the pixel mapping needs. */
type Shape = Pick<LineProfile, 'total' | 'size' | 'buckets'>

/** The 0-based bucket of 1-based `line` when a bucket holds `size` lines. */
export const bucketOf = (line: number, size: number) => Math.max(0, Math.floor((line - 1) / size))

/** The first line (1-based) of bucket `i`. */
export const lineOfBucket = (i: number, size: number) => i * size + 1

/** The line (1-based, within 1..total) under pixel row `y` of a strip `height` pixels high that stands for `total` lines. */
export function lineAtY(y: number, height: number, total: number): number {
  if (height <= 0 || total <= 0) return 1
  return Math.min(total, Math.max(1, 1 + Math.floor((y / height) * total)))
}

/** The pixel rows (0-based, of `height`) that the 1-based `lines` map to; lines outside 1..total are left out. */
export function stripMarks(lines: Iterable<number>, total: number, height: number): Set<number> {
  const rows = new Set<number>()
  if (total <= 0 || height <= 0) return rows
  for (const n of lines) {
    if (n < 1 || n > total) continue
    rows.add(Math.min(height - 1, Math.floor(((n - 1) * height) / total)))
  }
  return rows
}

/**
 * Per pixel row of a strip `height` pixels high the largest of `values` (one per bucket) among the buckets the row overlaps:
 * with more rows than buckets a bucket spans several rows, with fewer a row takes the max of its buckets.
 */
export function bucketRows(values: ArrayLike<number>, p: Shape, height: number): Float64Array {
  const out = new Float64Array(Math.max(0, height))
  const n = Math.min(p.buckets, values.length)
  if (n <= 0 || p.total <= 0 || p.size <= 0 || height <= 0) return out
  const eps = 1e-9
  for (let y = 0; y < height; y++) {
    const lo = (y * p.total) / height, hi = ((y + 1) * p.total) / height // 0-based lines [lo, hi)
    const b0 = Math.min(n - 1, Math.max(0, Math.floor(lo / p.size + eps)))
    const b1 = Math.min(n - 1, Math.max(b0, Math.ceil(hi / p.size - eps) - 1))
    let m = 0
    for (let b = b0; b <= b1; b++) if (values[b] > m) m = values[b]
    out[y] = m
  }
  return out
}

/** Per pixel row the call and wait intensity 0..1 (the buckets' counts against `maxCalls` / `maxWaits`). */
export function densityRows(p: LineProfile, height: number): { calls: Float64Array; waits: Float64Array } {
  const scale = (rows: Float64Array, max: number) => { for (let i = 0; i < rows.length; i++) rows[i] = max > 0 ? Math.min(1, rows[i] / max) : 0; return rows }
  return { calls: scale(bucketRows(p.calls, p, height), p.maxCalls), waits: scale(bucketRows(p.waits, p, height), p.maxWaits) }
}
