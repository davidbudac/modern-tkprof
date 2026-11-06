import { LINE_KINDS } from './linecache'

/**
 * Folding in the line viewer. A fold hides lines `from+1 .. to` and keeps line `from` (the handle) visible with a summary; the
 * hidden lines keep their numbers. The viewer lays out "visual rows"; these functions map visual rows (0-based) to lines
 * (1-based) and back through the sorted, non-overlapping list of folds.
 */
export interface Fold {
  from: number; to: number; summary: string
  /** a fold of repeats (the readable view's Fold repeats): its short label (`12×`) */
  label?: string
  /** the time the folded lines took, µs (the readable row's duration column, with its bar) */
  us?: number
  /** a fold the view made itself (not the user's) */
  auto?: boolean
  /**
   * not a fold: a table head, one row of its own laid out above line `from` (lines `from..to` are the table's rows, all shown). The
   * formatted view gives each plan dump one, so its STAT lines read as one table under one header
   */
  head?: boolean
  /** a fold that does not read as one: its handle line is shown as itself, with no summary or ▸ (a bind's attribute lines under its row) */
  quiet?: boolean
  /** a BINDS block drawn as chips on its header row (the handle): its `Bind#` and attribute lines are the lines the fold hides */
  inline?: boolean
  /** framing lines (a `=====` rule, END OF STMT) folded under the line above them */
  frame?: boolean
  /** a fold of the Δ filter: the lines below a line that reaches the threshold, up to the next one (quiet; its handle shows a break under it) */
  filter?: boolean
}

/**
 * The folds of the Δ filter: every line but `keep` (ascending, 1-based) is hidden. Each kept line is the quiet handle of a fold over
 * the lines up to the next kept one (the last: up to `total`, when known); the lines above the first kept line fold under line 1,
 * the one line that shows without reaching the threshold (its summary says so). `what` words that summary.
 */
export function filterFolds(keep: readonly number[], total: number, what: string): Fold[] {
  const out: Fold[] = []
  const first = keep.length > 0 ? keep[0] : total + 1
  if (first > 1) {
    const n = Math.max(0, Math.min(first, total + 1) - 1)
    out.push({ from: 1, to: Math.max(1, first - 1), summary: keep.length > 0 ? `${n.toLocaleString('en-US')} ${n === 1 ? 'line' : 'lines'} before the first ${what}` : `no ${what} in this file`, auto: true, filter: true })
  }
  for (let i = 0; i < keep.length; i++) {
    const from = keep[i], to = i + 1 < keep.length ? keep[i + 1] - 1 : total
    if (to > from) out.push({ from, to, summary: '', auto: true, filter: true, quiet: true })
  }
  return out
}

/** The rows a fold takes away from the layout: its hidden lines; a table head adds one. */
const hides = (f: Fold) => (f.head ? -1 : f.to - f.from)

/** The folds with the cumulative hidden line counts: `hiddenBefore[i]` is what folds `0..i-1` hide, the last entry the total. Built once per change of the folds. */
export interface FoldIndex { folds: readonly Fold[]; hiddenBefore: number[] }

export function indexFolds(folds: readonly Fold[]): FoldIndex {
  const hiddenBefore = new Array<number>(folds.length + 1)
  hiddenBefore[0] = 0
  for (let i = 0; i < folds.length; i++) hiddenBefore[i + 1] = hiddenBefore[i] + hides(folds[i])
  return { folds, hiddenBefore }
}

type Folds = readonly Fold[] | FoldIndex
const ix = (f: Folds): FoldIndex => (Array.isArray(f) ? indexFolds(f as readonly Fold[]) : (f as FoldIndex))

/** The rows the file has with its folds: the handle stays, the hidden lines go. */
export function visibleCount(total: number, folds: Folds): number {
  const x = ix(folds)
  return Math.max(0, total - x.hiddenBefore[x.folds.length])
}

/** The visual row of fold `k`'s handle line (a table head's: the head row, its line `from` is the row after it). */
const handleRow = (x: FoldIndex, k: number) => x.folds[k].from - 1 - x.hiddenBefore[k]

/** The line (1-based) shown in visual row `row` (0-based); rows past the end continue the numbering. A table head's row gives its first line. */
export function lineOfRow(row: number, folds: Folds): number {
  const x = ix(folds)
  // c = the folds whose handle is above `row`: their hidden lines are skipped
  let lo = 0, hi = x.folds.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (handleRow(x, mid) < row) lo = mid + 1; else hi = mid }
  return row + 1 + x.hiddenBefore[lo]
}

/** The visual row (0-based) of a line; a hidden line maps to the row of its handle. */
export function rowOfLine(line: number, folds: Folds): number {
  const x = ix(folds)
  // c = the folds that start above `line`
  let lo = 0, hi = x.folds.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x.folds[mid].from < line) lo = mid + 1; else hi = mid }
  if (lo > 0 && line <= x.folds[lo - 1].to && !x.folds[lo - 1].head) return handleRow(x, lo - 1)
  // the first line of a table is the row after its head
  if (lo < x.folds.length && x.folds[lo].from === line && x.folds[lo].head) return handleRow(x, lo) + 1
  return line - 1 - x.hiddenBefore[lo]
}

/** The table head laid out in visual row `row`, if that row is one. */
export function headAtRow(row: number, folds: Folds): Fold | undefined {
  const x = ix(folds)
  let lo = 0, hi = x.folds.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (handleRow(x, mid) < row) lo = mid + 1; else hi = mid }
  return lo < x.folds.length && x.folds[lo].head && handleRow(x, lo) === row ? x.folds[lo] : undefined
}

/** The table whose rows include `line` (a table head's `from..to`). */
export function tableOf(line: number, folds: Folds): Fold | undefined {
  const x = ix(folds)
  let lo = 0, hi = x.folds.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x.folds[mid].from <= line) lo = mid + 1; else hi = mid }
  const f = lo > 0 ? x.folds[lo - 1] : undefined
  return f && f.head && line <= f.to ? f : undefined
}

/** The folds with a table head for each of `tables` (`[from, to]`, apart) that no fold overlaps. */
export function withHeads(folds: readonly Fold[], tables: readonly (readonly [number, number])[]): readonly Fold[] {
  if (tables.length === 0) return folds
  const out: Fold[] = []
  let i = 0
  for (const [from, to] of [...tables].sort((a, b) => a[0] - b[0])) {
    while (i < folds.length && folds[i].to < from) out.push(folds[i++])
    if (i < folds.length && folds[i].from <= to) continue // a fold covers part of the table: the fold wins
    out.push({ from, to, summary: '', head: true })
  }
  while (i < folds.length) out.push(folds[i++])
  return out
}

/** The fold whose handle is `line`. */
export function foldAt(line: number, folds: Folds): Fold | undefined {
  const x = ix(folds)
  let lo = 0, hi = x.folds.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x.folds[mid].from < line) lo = mid + 1; else hi = mid }
  return lo < x.folds.length && x.folds[lo].from === line && !x.folds[lo].head ? x.folds[lo] : undefined
}

/** The fold that hides `line` (a line below a handle, up to the fold's last line). */
export function foldHiding(line: number, folds: Folds): Fold | undefined {
  const x = ix(folds)
  let lo = 0, hi = x.folds.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x.folds[mid].from < line) lo = mid + 1; else hi = mid }
  return lo > 0 && line <= x.folds[lo - 1].to && !x.folds[lo - 1].head ? x.folds[lo - 1] : undefined
}

/** The folds with `fold` added, or removed when a fold with its handle is there; sorted by handle, a fold that overlaps the new one is dropped. */
export function toggleFold(folds: readonly Fold[], fold: Fold): Fold[] {
  if (folds.some((f) => f.from === fold.from)) return folds.filter((f) => f.from !== fold.from)
  const out = folds.filter((f) => f.to < fold.from || f.from > fold.to)
  out.push(fold)
  return out.sort((a, b) => a.from - b.from)
}

// ---- foldable blocks ------------------------------------------------------------------------------------------------------

/** The lines `blockAt` reads: a `PageCache` has them. */
export interface LineSource { total: number; line(n: number): { text: string; kind: number } | undefined }

const K = (name: string) => LINE_KINDS.indexOf(name as (typeof LINE_KINDS)[number])
const K_BINDS = K('binds'), K_BIND = K('bind-line'), K_STAT = K('stat'), K_PARSING = K('parsing-in-cursor')
const K_SQL = K('sql-text'), K_END = K('end-of-stmt'), K_BLANK = K('blank'), K_UNKNOWN = K('unknown')

/** The least number of lines of a SQL text that is worth a fold (more than this). */
export const SQL_FOLD_LINES = 12
/** The longest block `blockAt` follows (a runaway dump is not folded). */
const MAX_BLOCK = 20_000

/**
 * The foldable block that starts at `line`, read from the cached lines, or null: a BINDS line with its `Bind#` lines (2+ lines), a
 * STAT dump (2+ consecutive STAT lines), or a PARSING IN CURSOR line whose SQL text is longer than 12 lines. `to` is the block's last
 * line (the SQL's last text line: END OF STMT stays visible). Null too while a line of the block is not loaded.
 */
export function blockAt(cache: LineSource, line: number): Fold | null {
  const first = cache.line(line)
  if (!first) return null
  /** the last line index of the run of lines for which `inRun` holds, starting after `line`; -1 when a line is not loaded */
  const runEnd = (inRun: (kind: number) => boolean): number => {
    let n = line
    for (let steps = 0; steps < MAX_BLOCK; steps++) {
      if (n + 1 > cache.total) return n
      const l = cache.line(n + 1)
      if (!l) return -1
      if (!inRun(l.kind)) return n
      n++
    }
    return -1
  }
  if (first.kind === K_BINDS) {
    const end = runEnd((k) => k === K_BIND || k === K_BLANK || k === K_UNKNOWN)
    if (end < 0) return null
    let to = end
    let binds = 0
    for (let n = line + 1; n <= end; n++) if (/^\s*Bind#\d+/.test(cache.line(n)!.text)) binds++
    // trailing blank / unknown lines belong to what follows, not to the block
    while (to > line && (cache.line(to)!.kind === K_BLANK || cache.line(to)!.kind === K_UNKNOWN)) to--
    if (to - line + 1 < 2) return null
    return { from: line, to, summary: `BINDS: ${binds} ${binds === 1 ? 'bind' : 'binds'}` }
  }
  if (first.kind === K_STAT) {
    const prev = line > 1 ? cache.line(line - 1) : undefined
    if (line > 1 && !prev) return null
    if (prev && prev.kind === K_STAT) return null // not the first line of the dump
    const end = runEnd((k) => k === K_STAT)
    if (end < 0 || end - line + 1 < 2) return null
    const n = end - line + 1
    return { from: line, to: end, summary: `STAT: ${n} plan ${n === 1 ? 'line' : 'lines'}` }
  }
  if (first.kind === K_PARSING) {
    const end = runEnd((k) => k === K_SQL)
    if (end < 0) return null
    const n = end - line
    if (n <= SQL_FOLD_LINES) return null
    const stop = cache.line(end + 1)
    if (end + 1 <= cache.total && (!stop || stop.kind !== K_END)) return null // the text did not end with END OF STMT
    return { from: line, to: end, summary: `SQL text: ${n} lines` }
  }
  return null
}

/** Whether a line of this kind can start a foldable block (a cheap test before `blockAt`). */
export const startsBlock = (kind: number) => kind === K_BINDS || kind === K_STAT || kind === K_PARSING
