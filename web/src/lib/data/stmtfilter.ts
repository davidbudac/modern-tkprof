// The statement filter of the Trace pane: only the lines of the filtered statements' cursors are shown, the rest folded the way the Δ filter folds. The lines come
// from the engine for the whole file (`api/lines/stmts`, as line runs), so the folds are global like every fold.
import type { Fold } from './folds'
import { fmtInt } from './format'

/** A run of lines, 1-based and inclusive. */
export type Run = readonly [number, number]

/** The runs with the ones that touch or overlap merged (input in line order). */
export function mergeRuns(runs: readonly Run[]): Run[] {
  const out: [number, number][] = []
  for (const [a, b] of runs) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/**
 * The lines of `lines` (ascending) that lie in `runs` (sorted, apart), as single-line runs merged where adjacent: what shows when the Δ filter and the statement
 * filter are both on (a row shown passes both).
 */
export function linesInRuns(runs: readonly Run[], lines: readonly number[]): Run[] {
  const out: Run[] = []
  let r = 0
  for (const n of lines) {
    while (r < runs.length && runs[r][1] < n) r++
    if (r === runs.length) break
    if (runs[r][0] <= n) out.push([n, n])
  }
  return mergeRuns(out)
}

/** How many lines the runs hold. */
export const runLines = (runs: readonly Run[]) => runs.reduce((n, [a, b]) => n + b - a + 1, 0)

/**
 * The folds of a line filter that keeps `keep` (sorted, apart) of a file of `total` lines and hides the rest: each stretch between kept runs is a quiet fold under the
 * last kept line before it (a dashed rule under that row, `z` shows the lines), and the lines above the first run fold under line 1, whose summary says how many
 * (`what` words it: `statement`). With `truncated` the list stops at the last run the engine sent: the lines after it are not folded (the filter does not know them).
 */
export function runFolds(keep: readonly Run[], total: number, what: string, truncated = false): Fold[] {
  const out: Fold[] = []
  if (keep.length === 0) {
    if (total > 0) out.push({ from: 1, to: Math.max(1, total), summary: `no ${what} in this file`, auto: true, filter: true })
    return out
  }
  const first = keep[0][0]
  if (first > 1) {
    const n = first - 1
    out.push({ from: 1, to: first - 1, summary: `${fmtInt(n)} ${n === 1 ? 'line' : 'lines'} before the first ${what}`, auto: true, filter: true })
  }
  for (let i = 0; i < keep.length; i++) {
    const from = keep[i][1]
    const to = i + 1 < keep.length ? keep[i + 1][0] - 1 : truncated ? from : total
    if (to > from) out.push({ from, to, summary: '', auto: true, filter: true, quiet: true })
  }
  return out
}

/** The words of the statement-filter chip, in the pieces a narrow toolbar drops one after the other (the last piece first): see `filterChipParts`. */
export interface FilterChip { word: string; name: string; unit: string; doing: string }

/**
 * The words of the toolbar's statement-filter chip, `Filter: 2 statements · 1,204 lines`, in the pieces the bar folds as it narrows: what it is (`Filter: `), what it names (the
 * sql_id of a single statement, else the number of statements) with its unit (` statements`), and, folding first, what it shows (` · 1,204 lines`, with a `+` while the engine's
 * list is cut; once the engine has answered). The tooltip and the label say all of them (`filterChipText`).
 */
export function filterChipParts(labels: readonly string[], lines?: number, truncated?: boolean): FilterChip {
  const one = labels.length === 1
  return {
    word: 'Filter: ', name: one ? labels[0] : fmtInt(labels.length), unit: one ? '' : ' statements',
    doing: lines === undefined ? '' : ` · ${fmtInt(lines)}${truncated ? '+' : ''} ${lines === 1 && !truncated ? 'line' : 'lines'}`,
  }
}

/** The chip's whole text. */
export const filterChipText = (c: FilterChip) => c.word + c.name + c.unit + c.doing

/**
 * Where the highlighted statements show up in a file: `starts` are the first lines of their runs (each statement's runs from `api/lines/stmts`, all merged, in line order, each line once),
 * the places `m` and `M` step between; `first` and `last` bound every line of theirs (the search scope "highlighted statements" reads the lines in between). `truncated`: the engine's
 * list was cut, the stops after the last run it sent are not known.
 */
export interface HlStops { starts: number[]; first: number; last: number; runs: number; truncated: boolean }

export function hlStops(stmts: readonly { runs: readonly Run[] }[], truncated = false): HlStops {
  const starts: number[] = []
  let first = Infinity, last = 0
  for (const s of stmts) for (const [a, b] of s.runs) { starts.push(a); if (a < first) first = a; if (b > last) last = b }
  starts.sort((x, y) => x - y)
  const unique = starts.filter((n, i) => i === 0 || n !== starts[i - 1])
  return { starts: unique, first: unique.length > 0 ? first : 0, last, runs: starts.length, truncated }
}
