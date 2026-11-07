// The line strip beside the viewer's scroll bar: the whole file down-sampled to the strip's height. It draws the lines of the highlighted statements (from the engine's binned
// answer, `api/lines/stmts?bins=`), and quiet ticks for search hits, bookmarks and hot spots; this is the pixel mapping.

/** The geometry of a binned answer: bucket i holds the lines `i*size+1 .. (i+1)*size` of a file of `total` lines. */
export interface BinShape { total: number; size: number; buckets: number }

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
export function bucketRows(values: ArrayLike<number>, p: BinShape, height: number): Float64Array {
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

/**
 * Per pixel row which of the statements have a line in it: `counts[k]` is statement k's lines per bucket. The result is one array per statement, a row's entry 1 when the statement
 * has a line in the lines the row stands for (a bucket that overlaps the row is enough), else 0. Statements are kept apart so the strip can draw each in its own colour.
 */
export function stmtRows(counts: readonly ArrayLike<number>[], p: BinShape, height: number): Uint8Array[] {
  return counts.map((c) => { const r = bucketRows(c, p, height), out = new Uint8Array(r.length); for (let y = 0; y < r.length; y++) out[y] = r[y] > 0 ? 1 : 0; return out })
}

/**
 * The columns the highlighted statements that are present in one pixel row share `width` px with: one gets all of it, several split it into stripes of at least `minStripe` px
 * (the first statements in the set's order keep theirs when more are present than stripes fit). `[x, width]` per statement drawn, in the order of `present` (statement indexes).
 */
export function stripeSpans(present: readonly number[], width: number, minStripe = 2): { k: number; x: number; w: number }[] {
  const n = present.length
  if (n === 0 || width <= 0) return []
  const fit = Math.max(1, Math.min(n, Math.floor(width / minStripe)))
  const out: { k: number; x: number; w: number }[] = []
  for (let i = 0; i < fit; i++) {
    const x0 = Math.round((i * width) / fit), x1 = Math.round(((i + 1) * width) / fit)
    out.push({ k: present[i], x: x0, w: Math.max(1, x1 - x0) })
  }
  return out
}
