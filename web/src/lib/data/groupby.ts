import type { NumCol } from './columns'

/** Accumulated measures for one group. */
export interface Agg {
  key: number
  count: number
  sum: number
  min: number
  max: number
  extra: Float64Array // additional summed measures, in the order given
}

export interface GroupSpec {
  /** number of rows in the fact table */
  n: number
  /** row filter (true = keep) */
  filter?: (i: number) => boolean
  /** integer group key per row; return NaN to skip */
  key: (i: number) => number
  /** primary measure (sum/min/max) */
  value: (i: number) => number
  /** additional measures summed per group */
  extra?: ((i: number) => number)[]
}

/** Generic group-by over a columnar fact table. Sorted by sum desc. */
export function groupBy(spec: GroupSpec): Agg[] {
  const m = new Map<number, Agg>()
  const nx = spec.extra?.length ?? 0
  for (let i = 0; i < spec.n; i++) {
    if (spec.filter && !spec.filter(i)) continue
    const k = spec.key(i)
    if (Number.isNaN(k)) continue
    const v = spec.value(i)
    let a = m.get(k)
    if (!a) { a = { key: k, count: 0, sum: 0, min: v, max: v, extra: new Float64Array(nx) }; m.set(k, a) }
    a.count++
    a.sum += v
    if (v < a.min) a.min = v
    if (v > a.max) a.max = v
    for (let j = 0; j < nx; j++) a.extra[j] += spec.extra![j](i)
  }
  return [...m.values()].sort((a, b) => b.sum - a.sum)
}

/** Sum of a column over the rows of an index subarray. */
export function sumOver(col: NumCol, ids: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < ids.length; i++) s += col[ids[i]]
  return s
}

/** Log-spaced histogram buckets (µs): 1, 2, 4, ... */
export function logHistogram(values: Iterable<number>, bins = 24): { edges: number[]; counts: number[]; sums: number[] } {
  const counts = new Array(bins).fill(0)
  const sums = new Array(bins).fill(0)
  for (const v of values) {
    const b = v <= 1 ? 0 : Math.min(bins - 1, Math.floor(Math.log2(v)))
    counts[b]++
    sums[b] += v
  }
  const edges = counts.map((_, i) => 2 ** i)
  return { edges, counts, sums }
}
