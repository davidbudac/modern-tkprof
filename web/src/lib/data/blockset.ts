// The block counting of the I/O routes: the twin of internal/analyze/blockset.go (blockSet, blockCounter). The sets model their
// size in bytes exactly as the Go code does (chunks of 65,536 blocks of one owner and file; an array chunk costs 2 bytes a block until
// a range would take it past 1,024 blocks, then it is an 8 KB bitmap; 64 bytes a chunk), so a cap stops at the same wait on both
// sides; the shared case web/src/lib/data/testdata/ioblocks-case.json checks it, with caps small enough to prune.

const CHUNK_SHIFT = 16
const CHUNK = 1 << CHUNK_SHIFT
const ARRAY_MAX = 1024
const CHUNK_OVERHEAD = 64
const BITMAP_BYTES = CHUNK / 8

/** Defaults of the caps (`analyze.DefaultSeenBytes`, `DefaultOwnerBytes`, `DefaultCountCap`). */
export const DEFAULT_SEEN_BYTES = 64 * 2 ** 20
export const DEFAULT_OWNER_BYTES = 32 * 2 ** 20
export const DEFAULT_COUNT_CAP = 1_000_000

interface Chunk {
  n: number
  /** the offsets while the chunk is an array */
  set: Set<number> | null
  /** the bitmap once it is one (32 blocks a word) */
  bits: Int32Array | null
}

const cost = (c: Chunk): number => CHUNK_OVERHEAD + (c.bits ? BITMAP_BYTES : 2 * c.n)

/** Set bits of a 32-bit word. */
function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24
}

/** A set of (owner, file, block) keys in chunks (the twin of `blockSet`). */
export class BlockSet {
  /** per owner (owners are small integers): (file · 2^16 + chunk) → chunk, and the last chunk it used */
  private owners: Map<number, Chunk>[] = []
  private lastKey: number[] = []
  private last: (Chunk | undefined)[] = []
  /** the modelled size */
  bytes = 0

  private chunk(owner: number, file: number, h: number, make: boolean): Chunk | undefined {
    const key = file * CHUNK + h
    if (this.lastKey[owner] === key) return this.last[owner]
    let m = this.owners[owner]
    if (!m) { if (!make) return undefined; m = this.owners[owner] = new Map() }
    let c = m.get(key)
    if (!c) {
      if (!make) return undefined
      c = { n: 0, set: new Set(), bits: null }
      m.set(key, c)
      this.bytes += CHUNK_OVERHEAD
    }
    this.lastKey[owner] = key
    this.last[owner] = c
    return c
  }

  /** Adds `[lo, hi)` of `file` to `owner`'s set (blocks below 0 left out); `seen` gets each block already there. Returns how many were not. */
  addRange(owner: number, file: number, lo: number, hi: number, seen?: (b: number) => void): number {
    lo = Math.max(lo, 0)
    let added = 0
    while (lo < hi) {
      const h = Math.floor(lo / CHUNK)
      const base = h * CHUNK, end = Math.min(hi, base + CHUNK)
      const c = this.chunk(owner, file, h, true)!
      const before = cost(c)
      const a = lo - base, b = end - base
      if (!c.bits && c.n + (b - a) > ARRAY_MAX) {
        c.bits = new Int32Array(CHUNK / 32)
        for (const v of c.set!) c.bits[v >>> 5] |= 1 << (v & 31)
        c.set = null
      }
      let add = 0
      if (c.bits) {
        for (let w = a >>> 5; w <= (b - 1) >>> 5; w++) {
          const from = Math.max(a, w << 5), to = Math.min(b, (w + 1) << 5) // the offsets of [a, b) in word w
          const n = to - from
          const mask = (n === 32 ? -1 : ((1 << n) - 1)) << (from & 31)
          let old = c.bits[w] & mask
          add += popcount(mask & ~c.bits[w])
          if (seen) while (old !== 0) { const t = 31 - Math.clz32(old & -old); seen(base + (w << 5) + t); old &= old - 1 }
          c.bits[w] |= mask
        }
      } else {
        for (let v = a; v < b; v++) {
          if (c.set!.has(v)) seen?.(base + v)
          else { c.set!.add(v); add++ }
        }
      }
      c.n += add
      added += add
      this.bytes += cost(c) - before
      lo = end
    }
    return added
  }

  has(owner: number, file: number, b: number): boolean {
    if (b < 0) return false
    const c = this.chunk(owner, file, Math.floor(b / CHUNK), false)
    if (!c) return false
    const v = b % CHUNK
    return c.bits ? (c.bits[v >>> 5] & (1 << (v & 31))) !== 0 : c.set!.has(v)
  }
}

/** The files and blocks a counter key holds (`maxCountFile`, `maxCountBlock`). */
const MAX_COUNT_FILE = 2 ** 31, MAX_COUNT_BLOCK = 2 ** 32

/** The key of a block in the counter map (`blockKey`: file in the high 32 bits); sorts like the Go key for files and blocks below 2^32. */
export const blockKey = (file: number, b: number): number => file * 2 ** 32 + b

/**
 * Counts the reads of every block (the twin of `blockCounter`): a first read marks the block in a `BlockSet`, a read again gives it an
 * entry (2 on its second read); above `countCap` entries a Misra-Gries prune takes the (countCap/2 + 1)-th largest count from every
 * entry, drops those at or below it and adds it to `dec`. Past `seenBytes` the set only answers lookups and a block it does not hold
 * starts at 1 in the map.
 */
export class BlockCounter {
  readonly set = new BlockSet()
  readonly count = new Map<number, number>()
  capped = false
  dec = 0
  distinct = 0
  private readonly seenBytes: number
  private readonly countCap: number

  constructor(seenBytes?: number, countCap?: number) {
    this.seenBytes = seenBytes && seenBytes > 0 ? seenBytes : DEFAULT_SEEN_BYTES
    this.countCap = countCap && countCap >= 2 ? countCap : DEFAULT_COUNT_CAP
  }

  startWait(): void { if (!this.capped && this.set.bytes >= this.seenBytes) this.capped = true }

  /** One read of `[lo, hi)` of `file` (the blocks a key holds: files in [0, 2^31), blocks in [0, 2^32); the others are not counted). */
  read(file: number, lo: number, hi: number): void {
    lo = Math.max(lo, 0); hi = Math.min(hi, MAX_COUNT_BLOCK)
    if (lo >= hi || file < 0 || file >= MAX_COUNT_FILE) return
    const again = (b: number) => { const k = blockKey(file, b); const v = this.count.get(k); this.count.set(k, v === undefined ? 2 : v + 1) }
    if (!this.capped) { this.distinct += this.set.addRange(0, file, lo, hi, again); return }
    for (let b = lo; b < hi; b++) {
      if (this.set.has(0, file, b)) { again(b); continue }
      const k = blockKey(file, b), v = this.count.get(k)
      if (v === undefined) { this.count.set(k, 1); this.distinct++ } else this.count.set(k, v + 1)
    }
  }

  endWait(): void {
    if (this.count.size <= this.countCap) return
    const m = Math.floor(this.countCap / 2)
    const vals = [...this.count.values()].sort((a, b) => b - a)
    const c = vals[m]
    for (const [k, v] of this.count) { if (v <= c) this.count.delete(k); else this.count.set(k, v - c) }
    this.dec += c
  }

  /** The counted reads of one block (exact while `dec` is 0). */
  reads(file: number, b: number): number {
    if (file < 0 || file >= MAX_COUNT_FILE || b < 0 || b >= MAX_COUNT_BLOCK) return 0
    const v = this.count.get(blockKey(file, b))
    if (v !== undefined) return v
    return this.set.has(0, file, b) ? 1 : 0
  }
}
