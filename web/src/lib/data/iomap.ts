// The physical I/O waits with a block address (the Blocks view): the answer of /api/io/map and its twin over the fact columns,
// plus the numbers the view derives from the rows (object ranges, re-reads, a brushed range as a time window).
//
// ioMapOf is the twin of analyze.IOMapOn (internal/analyze/iomap.go): same classification (Event.IsBlockIO / BlocksParam from
// the parameter names), same scope rule (a wait is in the window when [tim-ela, tim] overlaps it; idle ignored: block I/O is
// never idle), same deterministic every-k-th sampling with total, files and events over all matches. The shared case
// web/src/lib/data/testdata/iomap-case.json keeps the two identical. One known difference: the document's ela and obj columns
// are 32-bit and clamp at 2^31-1, the engine keeps 64 bits (an obj# of 4294967295, seen in a 21c fixture, reads 2147483647 here).
import type { TraceDoc } from './doc'
import type { Event, ID } from './types'
import type { Scope } from '../state/store'

/** The columns of `IOMap.rows`, in order (`analyze.IOMapCols`). */
export const IOMAP_COLS = ['tim', 'ela', 'event', 'file', 'block', 'blocks', 'obj', 'stmt', 'call', 'line', 'ctx', 'dep'] as const

/** Index of each column in a row. */
export const IO = { tim: 0, ela: 1, event: 2, file: 3, block: 4, blocks: 5, obj: 6, stmt: 7, call: 8, line: 9, ctx: 10, dep: 11 } as const

/** The block range `[lo, hi)` one file's block I/O waits touch (hi = the largest block + blocks: exclusive) and their count. */
export interface IOMapFile { file: number; lo: number; hi: number; n: number }

export interface IOMap {
  /** block I/O waits in scope */
  total: number
  /** more than the limit matched: every k-th is kept, k = ceil(total / limit) */
  sampled: boolean
  cols: string[]
  /** `[tim, ela, event, file, block, blocks, obj, stmt, call, line, ctx, dep]` in trace order; obj, stmt, call -1 when none */
  rows: number[][]
  /** over all matches, not only the kept rows; sorted by file */
  files: IOMapFile[]
  /** the event ids that occurred, sorted */
  events: ID[]
}

/** The every-k-th step of an answer: 1 when nothing was left out. */
export const sampleStep = (m: Pick<IOMap, 'total' | 'rows'>): number => (m.rows.length > 0 && m.total > m.rows.length ? Math.ceil(m.total / m.rows.length) : 1)

/** Twin of `model.Event.IsFileP1`. */
const isFileP1 = (ev: Event) => ev.p1Name === 'file#' || ev.p1Name === 'file number'

/** The event's parameters are a file number and a block address (twin of `model.Event.IsBlockIO`; data-driven on the parameter names). */
export function isBlockIO(ev: Event): boolean {
  return isFileP1(ev) && (ev.p2Name === 'block#' || ev.p2Name === 'first dba')
}

/** p3 is a block count, else a wait moves one block (twin of `model.Event.BlocksParam`). */
export function blocksParam(ev: Event): boolean {
  return ev.p3Name === 'blocks' || ev.p3Name === 'block cnt'
}

/**
 * The block I/O waits of the scope from the document's fact columns (the twin of `analyze.IOMapOn`): two passes, the first counts
 * and fills `files` / `events`, the second keeps every k-th match (the 1st, the (k+1)-th, ...), k = ceil(total / limit).
 * `scope.includeIdle` changes nothing; `stmt` and `event` narrow it further.
 */
export function ioMapOf(doc: TraceDoc, scope: Pick<Scope, 'window' | 'contexts'>, limit: number, stmt?: ID, event?: ID): IOMap {
  const w = doc.waits
  const isBlock = doc.events.map(isBlockIO)
  const countP3 = doc.events.map(blocksParam)
  const win = scope.window, ctxs = scope.contexts
  const match = (i: number): boolean => {
    const ev = w.event[i]
    if (ev < 0 || ev >= isBlock.length || !isBlock[ev] || w.flags[i] & 2) return false
    if (win && (w.tim[i] - w.ela[i] > win.endTim || w.tim[i] < win.startTim)) return false
    if (ctxs && !ctxs.has(w.ctx[i])) return false
    if (stmt !== undefined && w.stmt[i] !== stmt) return false
    return event === undefined || ev === event
  }
  const blocks = (i: number): number => (countP3[w.event[i]] && w.p3[i] > 0 ? w.p3[i] : 1)
  const out: IOMap = { total: 0, sampled: false, cols: [...IOMAP_COLS], rows: [], files: [], events: [] }
  const files = new Map<number, IOMapFile>()
  const seen = new Uint8Array(isBlock.length)
  for (let i = 0; i < w.n; i++) {
    if (!match(i)) continue
    out.total++
    seen[w.event[i]] = 1
    const f = w.p1[i], lo = w.p2[i], hi = lo + blocks(i)
    const r = files.get(f)
    if (!r) files.set(f, { file: f, lo, hi, n: 1 })
    else { r.n++; r.lo = Math.min(r.lo, lo); r.hi = Math.max(r.hi, hi) }
  }
  out.files = [...files.values()].sort((a, b) => a.file - b.file)
  for (let e = 0; e < seen.length; e++) if (seen[e]) out.events.push(e)
  if (out.total === 0) return out
  const k = Math.ceil(out.total / Math.max(1, Math.floor(limit) || 1))
  out.sampled = k > 1
  let n = 0
  for (let i = 0; i < w.n; i++) {
    if (!match(i)) continue
    if (n % k === 0) out.rows.push([w.tim[i], w.ela[i], w.event[i], w.p1[i], w.p2[i], blocks(i), w.obj[i], w.stmt[i], w.call[i], w.line[i], w.ctx[i], w.dep[i]])
    n++
  }
  return out
}

/** An answer whose `cols` are in another order (a future engine): its rows in `IOMAP_COLS` order; the same object when they already are. */
export function normalizeIOMap(m: IOMap): IOMap {
  if (m.cols.length === IOMAP_COLS.length && m.cols.every((c, i) => c === IOMAP_COLS[i])) return m
  const at = IOMAP_COLS.map((c) => m.cols.indexOf(c))
  return { ...m, cols: [...IOMAP_COLS], rows: m.rows.map((r) => at.map((k) => (k < 0 ? -1 : r[k]))) }
}

// ---- derived from the rows -------------------------------------------------------

/** A block range `[lo, hi)`. */
export interface BlockRun { lo: number; hi: number }

/** The union of `ranges`, overlapping ones merged; touching ones stay apart (two extents side by side are two runs). Sorted by `lo`. */
export function mergeRuns(ranges: BlockRun[]): BlockRun[] {
  const sorted = [...ranges].sort((a, b) => a.lo - b.lo || a.hi - b.hi)
  const out: BlockRun[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.lo < last.hi) last.hi = Math.max(last.hi, r.hi)
    else out.push({ lo: r.lo, hi: r.hi })
  }
  return out
}

/** Blocks a set of runs covers. */
export const runBlocks = (runs: BlockRun[]): number => runs.reduce((a, r) => a + r.hi - r.lo, 0)

/**
 * The block ranges an object's waits touched in one file: the union of `[block, block + blocks)` of its rows (`rows` indices
 * `idx`, else all), merged into runs (the faint extent bands of the view). Only rows that `keep` lets through count: the view
 * leaves out the temp waits, whose obj# names the statement's object, not the owner of the temp blocks.
 */
export function extentsOf(rows: readonly number[][], obj: number, file: number, keep?: (row: number[]) => boolean): BlockRun[] {
  const ranges: BlockRun[] = []
  for (const r of rows) {
    if (r[IO.obj] !== obj || r[IO.file] !== file || (keep && !keep(r))) continue
    ranges.push({ lo: r[IO.block], hi: r[IO.block] + r[IO.blocks] })
  }
  return mergeRuns(ranges)
}

/** What one statement (or object) did to the blocks of one file: the "how often did it come back" numbers. */
export interface Reread {
  /** the statement id (`by: 'stmt'`) or obj# (`by: 'obj'`) */
  key: number
  file: number
  reads: number
  /** blocks moved by the reads (Σ blocks) */
  readBlocks: number
  /** distinct blocks the reads touched */
  readDistinct: number
  writes: number
  writeBlocks: number
  writeDistinct: number
  /** readBlocks / readDistinct: 1 = every block read once; the multipass hash join of io_waits reads its 276 temp blocks 20.3 times */
  readsPerBlock: number
  /** Σ ela of the reads and writes, µs */
  us: number
}

/**
 * Re-reads per statement (or object) and file over the rows: reads and writes (by `isWrite(event)`), blocks moved, distinct
 * blocks touched (the union of the block ranges) and reads per distinct block. Sorted by time, largest first.
 */
export function rereadOf(rows: readonly number[][], isWrite: (event: ID) => boolean, by: 'stmt' | 'obj' = 'stmt'): Reread[] {
  const col = by === 'stmt' ? IO.stmt : IO.obj
  const groups = new Map<string, { r: Reread; read: BlockRun[]; write: BlockRun[] }>()
  for (const row of rows) {
    const key = row[col], file = row[IO.file]
    const id = `${key}:${file}`
    let g = groups.get(id)
    if (!g) groups.set(id, (g = { r: { key, file, reads: 0, readBlocks: 0, readDistinct: 0, writes: 0, writeBlocks: 0, writeDistinct: 0, readsPerBlock: 0, us: 0 }, read: [], write: [] }))
    const run = { lo: row[IO.block], hi: row[IO.block] + row[IO.blocks] }
    g.r.us += row[IO.ela]
    if (isWrite(row[IO.event])) { g.r.writes++; g.r.writeBlocks += row[IO.blocks]; g.write.push(run) }
    else { g.r.reads++; g.r.readBlocks += row[IO.blocks]; g.read.push(run) }
  }
  const out: Reread[] = []
  for (const g of groups.values()) {
    g.r.readDistinct = runBlocks(mergeRuns(g.read))
    g.r.writeDistinct = runBlocks(mergeRuns(g.write))
    g.r.readsPerBlock = g.r.readDistinct ? g.r.readBlocks / g.r.readDistinct : 0
    out.push(g.r)
  }
  return out.sort((a, b) => b.us - a.us || a.key - b.key || a.file - b.file)
}

/**
 * A brushed stretch of rows `i0..i1` (inclusive, either order, clamped) as a time window: from the start of the first wait
 * (tim - ela) to the end of the last (tim). Null without rows. The window then holds every wait of the stretch (and whatever
 * else overlaps it); the view re-queries inside it.
 */
export function orderToTime(rows: readonly number[][], i0: number, i1: number): { startTim: number; endTim: number } | null {
  if (rows.length === 0) return null
  const a = Math.max(0, Math.min(rows.length - 1, Math.floor(Math.min(i0, i1))))
  const b = Math.max(0, Math.min(rows.length - 1, Math.ceil(Math.max(i0, i1))))
  let start = Infinity, end = -Infinity
  for (let i = a; i <= b; i++) { // rows are in trace order, which is not strictly tim order across contexts: take the extremes
    start = Math.min(start, rows[i][IO.tim] - rows[i][IO.ela])
    end = Math.max(end, rows[i][IO.tim])
  }
  return { startTim: start, endTim: end }
}
