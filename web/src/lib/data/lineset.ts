import type { LineRange } from './windowlines'

export type { LineRange }

/** A set of lines as ranges: sorted, apart (not even touching), each `from <= to`. Shift+click makes one range, ⌘/Ctrl+click adds or removes a line. */
export type LineSet = readonly LineRange[]

/** The index of the range that holds `n`, -1 for none (binary search). */
function find(set: LineSet, n: number): number {
  let lo = 0, hi = set.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, r = set[mid]
    if (n < r.from) hi = mid - 1
    else if (n > r.to) lo = mid + 1
    else return mid
  }
  return -1
}

export const hasLine = (set: LineSet | null | undefined, n: number): boolean => !!set && set.length > 0 && find(set, n) >= 0

/** The set with lines `from..to` (either order) added: touching or overlapping ranges merge. */
export function addRange(set: LineSet, from: number, to: number): LineRange[] {
  let a = Math.min(from, to), b = Math.max(from, to)
  const out: LineRange[] = []
  let placed = false
  for (const r of set) {
    if (r.to < a - 1) out.push(r)
    else if (r.from > b + 1) { if (!placed) { out.push({ from: a, to: b }); placed = true } out.push(r) }
    else { a = Math.min(a, r.from); b = Math.max(b, r.to) }
  }
  if (!placed) out.push({ from: a, to: b })
  return out
}

/** The set with line `n` taken out (a range around it splits). */
export function removeLine(set: LineSet, n: number): LineRange[] {
  const out: LineRange[] = []
  for (const r of set) {
    if (n < r.from || n > r.to) { out.push(r); continue }
    if (r.from < n) out.push({ from: r.from, to: n - 1 })
    if (n < r.to) out.push({ from: n + 1, to: r.to })
  }
  return out
}

/** ⌘/Ctrl+click: `n` in or out of the set. */
export const toggleLine = (set: LineSet, n: number): LineRange[] => (hasLine(set, n) ? removeLine(set, n) : addRange(set, n, n))

/** How many lines the set has. */
export const lineCount = (set: LineSet): number => set.reduce((s, r) => s + r.to - r.from + 1, 0)

/** "12–40", "12, 15–18, 40", the first `max` ranges then "… (N ranges)". */
export function describeLines(set: LineSet, fmt: (n: number) => string = String, max = 3): string {
  const one = (r: LineRange) => (r.from === r.to ? fmt(r.from) : `${fmt(r.from)}–${fmt(r.to)}`)
  const head = set.slice(0, max).map(one).join(', ')
  return set.length > max ? `${head}, … (${fmt(set.length)} ranges)` : head
}
