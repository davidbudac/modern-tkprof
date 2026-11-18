// The computed readings of the dump reader (docs/PLAN-DIAG.md § The readings): the TypeScript twins of internal/diag/heap.go (the heap reading and the
// chunk lines of a selection), internal/diag/pga.go (the PGA summary and the PGA detail) and the digest's `readings` (internal/diag/digest.go).
//
// The Go files are the contract. A field may be added there, never renamed or removed, without changing this file in the same commit
// (data/diagreadings.test.ts compares the two). A line number is a 1-based position in the file. A size is `{ text, bytes }`: as the dump printed it,
// and in bytes.
import type { DiagReading } from './diag'

// ---- the heap reading (heap.go) ------------------------------------------------------------------------------------------------------------

/** What limits a heap reading: each flag that is set says how to read the numbers. */
export interface HeapFlags {
  /** the dump holds memory contents ("Dump of memory" blocks): skipped, and counted */
  contents?: { blocks: number; lines: number }
  /** the dump was taken inside a PDB and leaves out the chunks of other containers; the PDB id */
  pdbFiltered?: number
  /** "Heap has significant amount of free memory (N percent)": some extents only, no totals */
  sampled?: boolean
  sampledPercent?: number
  /** the header is followed by no extent */
  noExtents?: boolean
  /** the dump stops before its end */
  cut?: boolean
}

export type HeapCheckState = 'match' | 'differ' | 'none'

/** One comparison of a sum with a total the dump prints. */
export interface HeapCheck {
  /** heap, free, perm, reserved */
  name: string
  what: string
  state: HeapCheckState
  computed: number
  printed?: number
  line?: number
  /** computed - printed, for `differ` */
  diff?: number
  /** why a check could not be made (`none`) */
  reason?: string
}

export interface HeapVariant { type: string; chunks: number; bytes: number }
export interface HeapType { type: string; chunks: number; bytes: number; variants?: HeapVariant[] }
export interface HeapTypeShare { type: string; chunks: number; bytes: number }

export interface HeapComment {
  /** '' for the blank comment of a free chunk */
  comment: string
  types: HeapTypeShare[]
  chunks: number
  bytes: number
  /** the line of its first chunk */
  line: number
  /** how many distinct "^suffix" values the group holds; absent for a comment without one */
  suffixes?: number
}

/** What a bounded list leaves out, summed. */
export interface HeapOther { count: number; chunks: number; bytes: number }

export interface HeapBucket { n: number; size: number; chunks: number; bytes: number }
export interface HeapReserved { title: string; line: number; chunks: number; bytes: number; printed?: number; buckets: HeapBucket[] }
export interface HeapFreeLists { present: boolean; line?: number; chunks: number; bytes: number; printed?: number; buckets: HeapBucket[]; reserved?: HeapReserved[] }
export interface HeapPermanent { line: number; chunks: number; bytes: number; printed?: number }
export interface HeapUnpinned { line: number; bytes: number; rcr: number; trn: number }

export interface HeapSub {
  desc: string
  name: string
  /** the ds line's sz= (the sub-heap's own size); absent when the dump has no ds line for it */
  size?: number
  /** bytes of this heap's chunks that carry ds=<desc> */
  held: number
  chunks: number
  extents?: number
  line: number
  /** the node of its own dump, when the file holds it */
  node?: string
}

/** A line of the "N LARGEST SUB HEAPS" block. */
export interface HeapLargest { desc: string; name: string; size: number; line: number; node?: string }

/** A heap of the same dump run, in file order. */
export interface HeapRun { node: string; name: string; desc: string; parent?: string; depth?: number; size: number; from: number; to: number }

export interface HeapReading {
  kind: 'heap'
  node: string
  name: string
  desc: string
  parent?: string
  parentNode?: string
  depth?: number
  pdb?: number
  from: number
  to: number
  lines: number
  extents: number
  chunks: number
  bytes: number
  heapSize: number
  flags: HeapFlags
  checks: HeapCheck[]
  byType: HeapType[]
  byComment: HeapComment[]
  otherComments?: HeapOther
  comments: number
  freeLists: HeapFreeLists
  permanent?: HeapPermanent
  unpinned?: HeapUnpinned
  subheaps: HeapSub[]
  subheapsTotal: number
  otherSubheaps?: HeapOther
  largest: HeapLargest[]
  run: HeapRun[]
  runMore?: number
}

/** An answer of `api/diag/reading/lines`: the chunk lines of a selection, ascending. */
export interface HeapLines {
  node: string
  lines: number[]
  /** how many matching lines follow those listed */
  more: number
  /** when `more` > 0, the `after` of the next page */
  next?: number
  /** how many chunk lines match in all */
  total: number
}

/** What a heap reading's chunk lines are asked for: a comment group (`''` is the blank comment) and/or a type, after a line. */
export interface HeapLinesQuery { comment?: string; type?: string; after?: number }

// ---- the PGA readings (pga.go) ------------------------------------------------------------------------------------------------------------

/** A size as the dump prints it ("3429 KB", "3512312 bytes") and in bytes. */
export interface PGASize { text: string; bytes: number }

/** A row of the top uses, of the estimated uses, or of a pga_detail_dump. */
export interface PGAUse {
  line: number
  /** absent in a pga_detail_dump */
  percent?: number
  size: PGASize
  /** chunks, processes or heaps, per `unit` */
  count: number
  unit: string
  comment: string
  category?: string
  heap?: string
  ds?: string
  dsParent?: string
  /** estimated uses: the chunks of the line under the row */
  chunks?: number
}

export interface PGABlockRow { line: number; size: PGASize; count: number; unit: string; comment: string; freeHeld?: PGASize }

/** A block of the private heap summary: the heap itself (depth 0) or the sub-heaps at one depth. */
export interface PGABlock {
  line: number
  title: string
  depth: number
  total: PGASize
  commented?: PGASize
  permanent?: PGASize
  free?: PGASize
  emptyExtents?: PGASize
  rows: PGABlockRow[]
}

export interface PGAInstance { line: number; scope: string; name: string; value: string }
export interface PGAKV { line: number; name: string; value: string }

/** "Begin session detail for pid N" ... "End session detail". */
export interface PGASession {
  from: number
  to: number
  pid: number
  sid: number
  serial: number
  user?: string
  pdb?: string
  ospid?: string
  image?: string
  machine?: string
  program?: string
  currentSql?: string
}

export interface PGAProc {
  line: number
  percent?: number
  ospid: string
  name: string
  pdb?: string
  used: PGASize
  alloc: PGASize
  freeable?: PGASize
  session?: PGASession
}

export interface PGAProcesses {
  line: number
  totalAllocated?: PGASize
  mga?: string
  top: PGAProc[]
  all: PGAProc[]
  allOmitted?: number
}

export interface PGAEstimated { line: number; snapshots: number; processes: number; rows: PGAUse[]; omitted?: number }

export interface PGASummary {
  kind: 'pga-summary'
  node: string
  from: number
  to: number
  lines: number
  note: string
  top: PGAUse[]
  topLine?: number
  private: PGABlock[]
  instance: PGAInstance[]
  processes?: PGAProcesses
  estimated?: PGAEstimated
  swap: PGAKV[]
}

export interface PGADetail {
  kind: 'pga-detail'
  node: string
  from: number
  to: number
  lines: number
  pid?: number
  ospid?: number
  rows: PGAUse[]
  bytes: number
  chunks: number
  omitted?: number
}

// ---- the shape, for the test that compares this file with the Go types ---------------------------------------------------------------------

/**
 * The JSON keys of each Go type as this file declares them: `req` always present in the engine's JSON, `opt` may be left out (Go `omitempty`). The key of a
 * type is its Go name. data/diagreadings.test.ts reads heap.go, pga.go and digest.go and fails when a field is there that is missing here.
 */
export const READING_KEYS: Record<string, { req: string[]; opt: string[] }> = {
  HeapReading: {
    req: ['kind', 'node', 'name', 'desc', 'from', 'to', 'lines', 'extents', 'chunks', 'bytes', 'heapSize', 'flags', 'checks', 'byType', 'byComment', 'comments', 'freeLists', 'subheaps', 'subheapsTotal', 'largest', 'run'],
    opt: ['parent', 'parentNode', 'depth', 'pdb', 'otherComments', 'permanent', 'unpinned', 'otherSubheaps', 'runMore'],
  },
  HeapFlags: { req: [], opt: ['contents', 'pdbFiltered', 'sampled', 'sampledPercent', 'noExtents', 'cut'] },
  HeapContents: { req: ['blocks', 'lines'], opt: [] },
  HeapCheck: { req: ['name', 'what', 'state', 'computed'], opt: ['printed', 'line', 'diff', 'reason'] },
  HeapType: { req: ['type', 'chunks', 'bytes'], opt: ['variants'] },
  HeapVariant: { req: ['type', 'chunks', 'bytes'], opt: [] },
  HeapComment: { req: ['comment', 'types', 'chunks', 'bytes', 'line'], opt: ['suffixes'] },
  HeapTypeShare: { req: ['type', 'chunks', 'bytes'], opt: [] },
  HeapOther: { req: ['count', 'chunks', 'bytes'], opt: [] },
  HeapFreeLists: { req: ['present', 'chunks', 'bytes', 'buckets'], opt: ['line', 'printed', 'reserved'] },
  HeapBucket: { req: ['n', 'size', 'chunks', 'bytes'], opt: [] },
  HeapReserved: { req: ['title', 'line', 'chunks', 'bytes', 'buckets'], opt: ['printed'] },
  HeapPermanent: { req: ['line', 'chunks', 'bytes'], opt: ['printed'] },
  HeapUnpinned: { req: ['line', 'bytes', 'rcr', 'trn'], opt: [] },
  HeapSub: { req: ['desc', 'name', 'held', 'chunks', 'line'], opt: ['size', 'extents', 'node'] },
  HeapLargest: { req: ['desc', 'name', 'size', 'line'], opt: ['node'] },
  HeapRun: { req: ['node', 'name', 'desc', 'size', 'from', 'to'], opt: ['parent', 'depth'] },
  HeapLines: { req: ['node', 'lines', 'more', 'total'], opt: ['next'] },
  PGASize: { req: ['text', 'bytes'], opt: [] },
  PGAUse: { req: ['line', 'size', 'count', 'unit', 'comment'], opt: ['percent', 'category', 'heap', 'ds', 'dsParent', 'chunks'] },
  PGASummary: { req: ['kind', 'node', 'from', 'to', 'lines', 'note', 'top', 'private', 'instance', 'swap'], opt: ['topLine', 'processes', 'estimated'] },
  PGABlock: { req: ['line', 'title', 'depth', 'total', 'rows'], opt: ['commented', 'permanent', 'free', 'emptyExtents'] },
  PGABlockRow: { req: ['line', 'size', 'count', 'unit', 'comment'], opt: ['freeHeld'] },
  PGAInstance: { req: ['line', 'scope', 'name', 'value'], opt: [] },
  PGAKV: { req: ['line', 'name', 'value'], opt: [] },
  PGAProcesses: { req: ['line', 'top', 'all'], opt: ['totalAllocated', 'mga', 'allOmitted'] },
  PGAProc: { req: ['line', 'ospid', 'name', 'used', 'alloc'], opt: ['percent', 'pdb', 'freeable', 'session'] },
  PGASession: { req: ['from', 'to', 'pid', 'sid', 'serial'], opt: ['user', 'pdb', 'ospid', 'image', 'machine', 'program', 'currentSql'] },
  PGAEstimated: { req: ['line', 'snapshots', 'processes', 'rows'], opt: ['omitted'] },
  PGADetail: { req: ['kind', 'node', 'from', 'to', 'lines', 'rows', 'bytes', 'chunks'], opt: ['pid', 'ospid', 'omitted'] },
  Digest: { req: ['outline'], opt: ['readings', 'readingsOmitted'] },
  DigestNode: { req: ['children'], opt: ['more'] },
}

/** Fields this file has before the Go files do (written here first when the Go side is not in yet): the drift test lets them be absent from the Go side. None today. */
export const READING_AHEAD: Record<string, string[]> = {}

// ---- the kinds ------------------------------------------------------------------------------------------------------------------------------

export const isHeap = (r: DiagReading): r is DiagReading & HeapReading => r.kind === 'heap'
export const isPgaSummary = (r: DiagReading): r is DiagReading & PGASummary => r.kind === 'pga-summary'
export const isPgaDetail = (r: DiagReading): r is DiagReading & PGADetail => r.kind === 'pga-detail'

const arr = <T>(v: T[] | null | undefined): T[] => v ?? []

/** A heap reading with the lists Go may leave `null` made empty. */
export function normalizeHeap(raw: DiagReading): HeapReading {
  const r = raw as unknown as HeapReading
  const fl = r.freeLists ?? ({} as Partial<HeapFreeLists>)
  return {
    ...r,
    flags: r.flags ?? {},
    checks: arr(r.checks),
    byType: arr(r.byType).map((t) => (t.variants ? { ...t, variants: arr(t.variants) } : t)),
    byComment: arr(r.byComment).map((c) => ({ ...c, types: arr(c.types) })),
    freeLists: { ...fl, present: !!fl.present, chunks: fl.chunks ?? 0, bytes: fl.bytes ?? 0, buckets: arr(fl.buckets), ...(fl.reserved ? { reserved: arr(fl.reserved).map((x) => ({ ...x, buckets: arr(x.buckets) })) } : null) },
    subheaps: arr(r.subheaps),
    subheapsTotal: r.subheapsTotal ?? arr(r.subheaps).length,
    largest: arr(r.largest),
    run: arr(r.run),
  }
}

/** A PGA summary with the lists Go may leave `null` made empty. */
export function normalizePgaSummary(raw: DiagReading): PGASummary {
  const r = raw as unknown as PGASummary
  return {
    ...r,
    top: arr(r.top),
    private: arr(r.private).map((b) => ({ ...b, rows: arr(b.rows) })),
    instance: arr(r.instance),
    swap: arr(r.swap),
    ...(r.processes ? { processes: { ...r.processes, top: arr(r.processes.top), all: arr(r.processes.all) } } : null),
    ...(r.estimated ? { estimated: { ...r.estimated, rows: arr(r.estimated.rows) } } : null),
  }
}

/** A PGA detail with the lists Go may leave `null` made empty. */
export function normalizePgaDetail(raw: DiagReading): PGADetail {
  const r = raw as unknown as PGADetail
  return { ...r, rows: arr(r.rows) }
}
