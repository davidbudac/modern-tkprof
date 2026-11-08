// The hottest blocks of the I/O map (its Hot blocks tab) and the exact numbers of its side panel: the answer of /api/io/hot and its
// twin over the document's fact columns. ioHotOf is the twin of analyze.IOHotOn (internal/analyze/iohot.go): the same counting
// (BlockCounter: a block's first read only marks it, a re-read gets a counter, a Misra-Gries prune above the cap), the same runs of
// adjacent re-read blocks recounted exactly in a second pass, the same per-object and per-statement numbers. The shared case
// web/src/lib/data/testdata/ioblocks-case.json keeps the two identical.
import type { TraceDoc } from './doc'
import type { ID } from './types'
import type { Scope } from '../state/store'
import { BlockCounter, BlockSet, DEFAULT_OWNER_BYTES } from './blockset'
import { ioScan } from './iomap'

/** A run of adjacent blocks of one file, each read twice or more; every count exact (recounted over the scope). */
export interface IOHotRun {
  file: number
  /** first block, and the end (exclusive) */
  lo: number
  hi: number
  /** Σ reads of its blocks, and Σ (reads − 1): the reads a big enough cache would have saved */
  reads: number
  rereads: number
  /** the most and the fewest reads of one block, and the block read `max` times (the first on a tie) */
  max: number
  min: number
  peak: number
  /** read waits and write waits that touched it */
  waits: number
  writes: number
  /** µs of its reads: each read's ela × its share of the read's blocks */
  us: number
  /** tim of the first and the last read */
  first: number
  last: number
  /** every read was temp I/O */
  temp: boolean
  /** the objects (obj# of the non-temp reads) and statements that read it, by blocks read, at most 3: [id, blocks] */
  objs: [number, number][]
  stmts: [number, number][]
}

/** What one object group's waits did over every wait in scope (`o108609`, temp waits of a file `t203`, no object `n12`). */
export interface IOObjStat {
  key: string
  obj: number
  temp: boolean
  files: number[]
  waits: number
  reads: number
  writes: number
  us: number
  maxUs: number
  /** blocks moved by the reads and writes, and by the reads */
  blocks: number
  readBlocks: number
  /** distinct blocks read */
  distinct: number
  /** waits that start within `IO_SEQ_GAP` blocks after the previous one of the group ended (same file) */
  seq: number
}

/** What one statement did to the blocks of one file, over every wait in scope. */
export interface IOStmtStat {
  stmt: number
  file: number
  reads: number
  readBlocks: number
  readDistinct: number
  writes: number
  writeBlocks: number
  writeDistinct: number
  us: number
}

export interface IOHot {
  /** block I/O waits in scope; of them reads */
  total: number
  reads: number
  /** blocks the reads moved (a multiblock read counts each); distinct blocks read; of them read twice or more */
  blockReads: number
  distinct: number
  reread: number
  /** the runs are what counting every block gives; else a block in no run may have been read up to `bound` times */
  exact: boolean
  bound: number
  /** the distinct counts are exact (false once a seen-block set reached its cap) */
  distinctExact: boolean
  /** runs before the limit */
  runsTotal: number
  runs: IOHotRun[]
  objects: IOObjStat[]
  stmts: IOStmtStat[]
}

/** The orders of the runs (`analyze.HotSorts`): Σ re-reads, the most reads of one block, time. */
export type HotSort = 'rereads' | 'max' | 'us'
export const HOT_SORTS: readonly HotSort[] = ['rereads', 'max', 'us']

/** Options (`analyze.IOHotOpts`): runs at most (100), their order, the blocks recounted (65,536) and the caps of the counting. */
export interface IOHotOpts { limit?: number; sort?: HotSort; candidates?: number; countCap?: number; seenBytes?: number; ownerBytes?: number }

export const DEFAULT_HOT_RUNS = 100
export const MAX_HOT_RUNS = 2000
export const DEFAULT_HOT_CANDIDATES = 65536
/** `analyze.IOSeqGap` (iostats.ts SEQ_GAP) */
export const IO_SEQ_GAP = 64
const HOT_TOP = 3

const cmp = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0)
const strCmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The block reads of every block I/O wait in scope, the hottest blocks as runs, the exact numbers per object and statement. */
export function ioHotOf(doc: TraceDoc, scope: Pick<Scope, 'window' | 'contexts'>, o: IOHotOpts = {}, stmt?: ID, event?: ID): IOHot {
  const limit = o.limit && o.limit >= 1 ? o.limit : DEFAULT_HOT_RUNS
  const candidates = o.candidates && o.candidates >= 1 ? o.candidates : DEFAULT_HOT_CANDIDATES
  const ownerBytes = o.ownerBytes && o.ownerBytes > 0 ? o.ownerBytes : DEFAULT_OWNER_BYTES
  const w = doc.waits
  const sc = ioScan(doc, scope, stmt, event)
  const bc = new BlockCounter(o.seenBytes, o.countCap)
  const owned = new BlockSet()
  let ownedCapped = false
  const out: IOHot = { total: 0, reads: 0, blockReads: 0, distinct: 0, reread: 0, exact: false, bound: 0, distinctExact: false, runsTotal: 0, runs: [], objects: [], stmts: [] }
  interface ObjAcc { s: IOObjStat; owner: number; files: Set<number>; lastFile: number; lastEnd: number; any: boolean }
  interface StmtAcc { s: IOStmtStat; r: number; w: number }
  const objs = new Map<string, ObjAcc>()
  const stmts = new Map<string, StmtAcc>()
  let owners = 0
  for (let i = 0; i < w.n; i++) {
    if (!sc.match(i)) continue
    const n = sc.blocks(i), file = w.p1[i], lo = w.p2[i], hi = lo + n, ela = w.ela[i]
    const write = sc.write(i), temp = sc.temp(i)
    out.total++
    bc.startWait()
    if (!ownedCapped && owned.bytes >= ownerBytes) ownedCapped = true
    const key = temp ? `t${file}` : w.obj[i] >= 0 ? `o${w.obj[i]}` : `n${file}`
    let oa = objs.get(key)
    if (!oa) {
      oa = { s: { key, obj: !temp && w.obj[i] >= 0 ? w.obj[i] : -1, temp, files: [], waits: 0, reads: 0, writes: 0, us: 0, maxUs: 0, blocks: 0, readBlocks: 0, distinct: 0, seq: 0 }, owner: 0, files: new Set(), lastFile: 0, lastEnd: 0, any: false }
      objs.set(key, oa)
    }
    const sk = `${w.stmt[i]}:${file}`
    let sa = stmts.get(sk)
    if (!sa) {
      sa = { s: { stmt: w.stmt[i], file, reads: 0, readBlocks: 0, readDistinct: 0, writes: 0, writeBlocks: 0, writeDistinct: 0, us: 0 }, r: 0, w: 0 }
      stmts.set(sk, sa)
    }
    const s = oa.s
    if (oa.any && oa.lastFile === file && lo - oa.lastEnd >= 0 && lo - oa.lastEnd <= IO_SEQ_GAP) s.seq++
    oa.any = true; oa.lastFile = file; oa.lastEnd = hi
    s.waits++
    s.us += ela
    s.maxUs = Math.max(s.maxUs, ela)
    s.blocks += n
    oa.files.add(file)
    sa.s.us += ela
    const distinct = (own: number): number => (ownedCapped ? n : owned.addRange(own, file, lo, hi))
    if (write) {
      s.writes++
      sa.s.writes++
      sa.s.writeBlocks += n
      if (!sa.w) sa.w = ++owners
      sa.s.writeDistinct += distinct(sa.w)
    } else {
      out.reads++
      out.blockReads += n
      s.reads++
      s.readBlocks += n
      bc.read(file, lo, hi)
      if (!oa.owner) oa.owner = ++owners
      s.distinct += distinct(oa.owner)
      sa.s.reads++
      sa.s.readBlocks += n
      if (!sa.r) sa.r = ++owners
      sa.s.readDistinct += distinct(sa.r)
    }
    bc.endWait()
  }
  out.distinct = bc.distinct
  out.distinctExact = !bc.capped && !ownedCapped
  for (const oa of objs.values()) { oa.s.files = [...oa.files].sort((a, b) => a - b); out.objects.push(oa.s) }
  out.objects.sort((a, b) => b.us - a.us || strCmp(a.key, b.key))
  for (const sa of stmts.values()) out.stmts.push(sa.s)
  out.stmts.sort((a, b) => b.us - a.us || a.stmt - b.stmt || a.file - b.file)

  // the candidates: the most read blocks read twice or more, by count, then file and block
  let cands: [number, number][] = []
  for (const [k, v] of bc.count) if (v >= 2) cands.push([k, v])
  out.reread = cands.length
  cands.sort((a, b) => b[1] - a[1] || a[0] - b[0])
  const cut = cands.length > candidates
  out.bound = 1 + bc.dec
  if (cut) { out.bound = Math.max(out.bound, cands[candidates][1] + bc.dec); cands = cands.slice(0, candidates) }
  out.exact = bc.dec === 0 && !cut
  if (cands.length === 0) return out
  cands.sort((a, b) => a[0] - b[0])

  interface RunAcc { r: IOHotRun; counts: Int32Array; us: number; temps: number; objs: Map<number, number>; stmts: Map<number, number> }
  const runs: RunAcc[] = []
  const byFile = new Map<number, RunAcc[]>()
  for (const [k] of cands) {
    const file = Math.floor(k / 2 ** 32), b = k - file * 2 ** 32
    let l = byFile.get(file)
    if (!l) byFile.set(file, (l = []))
    const last = l[l.length - 1]
    if (last && last.r.hi === b) { last.r.hi++; continue }
    const ra: RunAcc = {
      r: { file, lo: b, hi: b + 1, reads: 0, rereads: 0, max: 0, min: 0, peak: 0, waits: 0, writes: 0, us: 0, first: Infinity, last: -Infinity, temp: false, objs: [], stmts: [] },
      counts: new Int32Array(0), us: 0, temps: 0, objs: new Map(), stmts: new Map(),
    }
    l.push(ra)
    runs.push(ra)
  }
  for (const ra of runs) ra.counts = new Int32Array(ra.r.hi - ra.r.lo)
  out.runsTotal = runs.length
  for (let i = 0; i < w.n; i++) {
    if (!sc.match(i)) continue
    const l = byFile.get(w.p1[i])
    if (!l) continue
    const n = sc.blocks(i), lo = Math.max(w.p2[i], 0), hi = w.p2[i] + n
    const write = sc.write(i), temp = sc.temp(i)
    let a0 = 0, b0 = l.length // the first run that ends after lo
    while (a0 < b0) { const m = (a0 + b0) >> 1; if (l[m].r.hi > lo) b0 = m; else a0 = m + 1 }
    for (let j = a0; j < l.length && l[j].r.lo < hi; j++) {
      const ra = l[j]
      const a = Math.max(lo, ra.r.lo), b = Math.min(hi, ra.r.hi)
      if (write) { ra.r.writes++; continue }
      for (let x = a; x < b; x++) ra.counts[x - ra.r.lo]++
      ra.r.waits++
      ra.us += w.ela[i] * (b - a) / n
      ra.r.first = Math.min(ra.r.first, w.tim[i])
      ra.r.last = Math.max(ra.r.last, w.tim[i])
      if (temp) ra.temps++
      else ra.objs.set(w.obj[i], (ra.objs.get(w.obj[i]) ?? 0) + b - a)
      ra.stmts.set(w.stmt[i], (ra.stmts.get(w.stmt[i]) ?? 0) + b - a)
    }
  }
  const top = (m: Map<number, number>): [number, number][] => [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, HOT_TOP)
  for (const ra of runs) {
    const r = ra.r
    r.min = Infinity
    ra.counts.forEach((v, i) => { r.reads += v; if (v > r.max) { r.max = v; r.peak = r.lo + i } r.min = Math.min(r.min, v) })
    r.rereads = r.reads - (r.hi - r.lo)
    r.us = Math.round(ra.us)
    r.temp = ra.temps > 0 && ra.temps === r.waits
    if (r.waits === 0) { r.first = 0; r.last = 0; r.min = 0 } // cannot happen (a candidate was read twice in scope)
    r.objs = top(ra.objs)
    r.stmts = top(ra.stmts)
  }
  const keyOf = (r: IOHotRun) => (o.sort === 'max' ? r.max : o.sort === 'us' ? r.us : r.rereads)
  runs.sort((x, y) => cmp(keyOf(y.r), keyOf(x.r)) || cmp(y.r.max, x.r.max) || cmp(x.r.file, y.r.file) || cmp(x.r.lo, y.r.lo))
  out.runs = runs.slice(0, limit).map((ra) => ra.r)
  return out
}
