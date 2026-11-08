// The numbers of the I/O map's side panel (views/BlockMap.tsx): per object what its waits did, the latency of each event as a
// histogram, and how many blocks a wait moved. All over the rows of an `/api/io/map` answer (the shown rows: a sampled answer
// counts its sample, and the view says so).
import type { ID } from './types'
import { IO, mergeRuns, runBlocks, type BlockRun } from './iomap'

/** A wait continues the previous wait of its object when it starts at most this many blocks after where that one ended (a scan skips a few at an extent's header). */
export const SEQ_GAP = 64

/** What the waits of one object (or the temp waits of a file, or the waits without an object of a file) did. */
export interface ObjStat {
  /** `o108609`, `t203` (temp waits of file 203), `n12` (no object, file 12): the keys of the panels by object */
  key: string
  /** the obj# (-1 for temp and no-object groups) */
  obj: number
  temp: boolean
  /** the files its waits are in, ascending */
  files: number[]
  waits: number
  reads: number
  writes: number
  /** Σ ela, µs */
  us: number
  maxUs: number
  /** blocks moved (Σ blocks) and distinct blocks touched (the union of the block ranges) */
  blocks: number
  distinct: number
  /** blocks read / distinct blocks read: 1 = every block read once */
  readsPerBlock: number
  /**
   * The share of its waits (after the first) that continue the previous one upward within `SEQ_GAP` blocks in the same file:
   * near 1 for a full scan or a spill read back in order, near 0 for single-block lookups all over. NaN below 2 waits.
   */
  seq: number
}

/**
 * Per object: waits, reads, writes, time, blocks moved, distinct blocks, re-reads per block and how sequential the access was.
 * Temp waits are grouped per file (their obj# names the statement's object, not the temp blocks' owner). Sorted by time,
 * largest first.
 */
export function objectStats(rows: readonly number[][], isWrite: (event: ID) => boolean, isTemp: (event: ID) => boolean): ObjStat[] {
  interface Acc { s: ObjStat; read: BlockRun[]; all: BlockRun[]; readBlocks: number; seqN: number; last?: { file: number; end: number }; files: Set<number> }
  const groups = new Map<string, Acc>()
  for (const r of rows) {
    const ev = r[IO.event], file = r[IO.file], obj = r[IO.obj]
    const temp = isTemp(ev)
    const key = temp ? `t${file}` : obj >= 0 ? `o${obj}` : `n${file}`
    let g = groups.get(key)
    if (!g) {
      g = { s: { key, obj: temp ? -1 : obj, temp, files: [], waits: 0, reads: 0, writes: 0, us: 0, maxUs: 0, blocks: 0, distinct: 0, readsPerBlock: 0, seq: NaN }, read: [], all: [], readBlocks: 0, seqN: 0, files: new Set() }
      groups.set(key, g)
    }
    const lo = r[IO.block], n = r[IO.blocks], ela = r[IO.ela]
    const s = g.s
    if (g.last && g.last.file === file && lo - g.last.end >= 0 && lo - g.last.end <= SEQ_GAP) g.seqN++
    g.last = { file, end: lo + n }
    s.waits++
    s.us += ela
    s.maxUs = Math.max(s.maxUs, ela)
    s.blocks += n
    g.files.add(file)
    g.all.push({ lo: file * 2 ** 32 + lo, hi: file * 2 ** 32 + lo + n }) // one number line for all files: block ranges of two files never merge
    if (isWrite(ev)) s.writes++
    else { s.reads++; g.readBlocks += n; g.read.push({ lo: file * 2 ** 32 + lo, hi: file * 2 ** 32 + lo + n }) }
  }
  const out: ObjStat[] = []
  for (const g of groups.values()) {
    const s = g.s
    s.files = [...g.files].sort((a, b) => a - b)
    s.distinct = runBlocks(mergeRuns(g.all))
    const readDistinct = runBlocks(mergeRuns(g.read))
    s.readsPerBlock = readDistinct ? g.readBlocks / readDistinct : 0
    s.seq = s.waits >= 2 ? g.seqN / (s.waits - 1) : NaN
    out.push(s)
  }
  return out.sort((a, b) => b.us - a.us || a.key.localeCompare(b.key))
}

/** The latency bucket of an elapsed time: 0 holds up to 1 µs, bucket b ≥ 1 holds [2^b, 2^(b+1)) µs; the last (`LAT_BUCKETS - 1`, from 2^24 µs ≈ 16.8 s) is open. */
export const LAT_BUCKETS = 25
export const latBucket = (us: number): number => (us < 2 ? 0 : Math.min(LAT_BUCKETS - 1, Math.floor(Math.log2(us))))

/** The lower edge of a latency bucket, µs (bucket 0: 0). */
export const latBucketLo = (b: number): number => (b === 0 ? 0 : 2 ** b)

/** One event's waits by latency. */
export interface LatencyHist {
  event: ID
  n: number
  /** Σ ela, µs */
  us: number
  /** counts per `latBucket` */
  buckets: number[]
  p50: number
  p95: number
  p99: number
  max: number
}

/** The value at quantile `q` of an ascending list (nearest rank). */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

/** Per event: the waits' latency histogram (log2 buckets of µs) and its 50th, 95th and 99th percentile. Sorted by time, largest first. */
export function latencyHists(rows: readonly number[][]): LatencyHist[] {
  const by = new Map<ID, number[]>()
  for (const r of rows) { const l = by.get(r[IO.event]); if (l) l.push(r[IO.ela]); else by.set(r[IO.event], [r[IO.ela]]) }
  const out: LatencyHist[] = []
  for (const [event, elas] of by) {
    elas.sort((a, b) => a - b)
    const buckets = new Array<number>(LAT_BUCKETS).fill(0)
    let us = 0
    for (const e of elas) { buckets[latBucket(e)]++; us += e }
    out.push({ event, n: elas.length, us, buckets, p50: quantile(elas, 0.5), p95: quantile(elas, 0.95), p99: quantile(elas, 0.99), max: elas[elas.length - 1] })
  }
  return out.sort((a, b) => b.us - a.us || a.event - b.event)
}

/** Upper bounds (blocks, inclusive) of the read-size histogram's buckets; the last bucket is open. */
export const SIZE_HIST_BOUNDS = [1, 2, 4, 8, 16, 32, 64, 128] as const
export const SIZE_HIST_LABELS = ['1', '2', '3–4', '5–8', '9–16', '17–32', '33–64', '65–128', '129+'] as const

/** One event's waits by blocks moved per wait. */
export interface SizeHist { event: ID; n: number; buckets: number[]; blocks: number; max: number }

/** Per event: how many blocks each wait moved (the multiblock reads' size against db_file_multiblock_read_count). Sorted by waits, most first. */
export function sizeHists(rows: readonly number[][]): SizeHist[] {
  const by = new Map<ID, SizeHist>()
  for (const r of rows) {
    const ev = r[IO.event], n = r[IO.blocks]
    let h = by.get(ev)
    if (!h) by.set(ev, (h = { event: ev, n: 0, buckets: new Array<number>(SIZE_HIST_BOUNDS.length + 1).fill(0), blocks: 0, max: 0 }))
    let k = 0
    while (k < SIZE_HIST_BOUNDS.length && n > SIZE_HIST_BOUNDS[k]) k++
    h.buckets[k]++
    h.n++
    h.blocks += n
    h.max = Math.max(h.max, n)
  }
  return [...by.values()].sort((a, b) => b.n - a.n || a.event - b.event)
}
