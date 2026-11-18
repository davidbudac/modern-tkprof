// The computed readings of the dump reader (docs/PLAN-DIAG.md § The readings): the TypeScript twins of internal/diag/heap.go (the heap reading and the
// chunk lines of a selection), internal/diag/pga.go (the PGA summary and the PGA detail), internal/diag/stack.go (the call stack), internal/diag/procstate.go
// (the process state) and the digest's `readings` (internal/diag/digest.go).
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

// ---- the call stack reading (stack.go) ------------------------------------------------------------------------------------------------------

/** The dump's start line: "Starting a non-incident diagnostic dump (flags=0x0, level=2, mask=0x0)". `line` is 0 when the node holds none. */
export interface DumpStart { line: number; incident: boolean; level: number; flags: string; mask: string; text?: string }
/** A line of the file with its number. */
export interface DumpLine { line: number; text: string }
/** "about to signal 942" and "Name: MTK_NO_SUCH_TABLE". */
export interface DumpSignal { line: number; code: number; ora: string; name?: string }
/** An incident file's problem: its id, the problem key ("ORA 6544 [pevm_peruws_callback-1]"), the bracketed arguments of the error line that opens the file's error stack. */
export interface DumpIncident { id: string; problem: string; args: string[]; line: number }
/** What a dump says about its error; absent from the reading when it names none. */
export interface DumpError { lines: DumpLine[]; signal?: DumpSignal; incident?: DumpIncident }
/** "Current SQL Statement for this session": `title` the title's line, `from`..`to` the text's lines (from > to: empty). */
export interface DumpStatement { sqlId: string; text: string; truncated?: boolean; title: number; from: number; to: number }
/** A row of the PL/SQL call stack, innermost first (`n` 1 = innermost); `at` the line of the row. */
export interface PLSQLFrame { n: number; handle: string; line: number; object: string; type: string; name: string; at: number }
/** A frame of the call stack, innermost first; `offset` absent for a frame that prints none; `own`: a frame of the dump itself. */
export interface StackFrame { n: number; function: string; offset?: number; text: string; callee: string; line: number; tableLine?: number; own?: boolean; component?: string; errorSignaled?: boolean }
/** A bind of a cursor: `value` as printed (a string keeps its quotes), `line` 0 when the bind prints none. */
export interface DumpBind { pos: number; dty: number; type?: string; noDef?: boolean; avl?: number; value?: string; line?: number; lineTo?: number }
/** A cursor of the session cursor dump: `group` "open" or "cached"; `bindCount` counts all the binds, `binds` lists the first ones. */
export interface DumpCursor { sqlId: string; group: string; number?: number; state?: string; statement?: string; from: number; to: number; bindCount: number; binds: DumpBind[] }
/** A dump nested in this one (a process state, a heap), by node. */
export interface DumpLink { kind: string; node: string; title: string; from: number; to: number }

/** The reading of a diagnostic dump (`api/diag/reading` of a diagdump, an incident and its "Dump for incident" part). */
export interface CallStack {
  kind: 'callstack'
  node: string
  from: number
  to: number
  lines: number
  start: DumpStart
  error?: DumpError
  barriers: DumpLine[]
  statement?: DumpStatement
  plsql: PLSQLFrame[]
  plsqlLine?: number
  frames: StackFrame[]
  /** "binary" (the frame headers of the Binary Stack Dump), "table" (the Call Stack Trace table) or "none" */
  framesSource: string
  framesLine?: number
  binaryFrames: number
  tableFrames: number
  tableAgrees?: boolean
  /** how many leading frames belong to the dump itself */
  own: number
  /** "f1()+off<-f2()+off<-...", innermost first; the second without the dump's own frames */
  shortStack: string
  shortStackNoOwn: string
  cursors: DumpCursor[]
  cursorsTotal: number
  links: DumpLink[]
  notes: string[]
}

// ---- the process state reading (procstate.go) -----------------------------------------------------------------------------------------------

/** The process's own state object. */
export interface ProcInfo { line: number; address: string; pid?: number; serial?: number; ospid?: string; osUser?: string; name?: string; flags?: string; program?: string }
/** A session the dump names ("inst: 1, sid: 52, ser: 41898"). */
export interface SessionRef { inst: number; sid: number; serial: number; key: string; line: number }
/** "row_wait_obj#: 108609, block#: 169252, row#: 6, file# 12". */
export interface RowWait { obj: number; block: number; row: number; file: number; line: number }
/** A session blocked by this one that the dump describes (one, however many there are). */
export interface ProcWaiter extends SessionRef { event?: string; params: string[]; rowWait?: RowWait; minBlockedSec?: number }
/** An entry of the current wait stack (entry 0 is the one waited for now); `seconds` is "total=" of its wait times. */
export interface WaitEntry { level: number; event: string; params?: string; seconds?: number; line: number }
/** An entry of the Session Wait History, latest first. */
export interface WaitHistory { n: number; event: string; params?: string; seconds?: number; line: number }
/** What the session's text says about its wait. */
export interface ProcWait {
  inWait: boolean
  line?: number
  stack: WaitEntry[]
  lastEndedSec?: number
  blocked: boolean
  blockers: SessionRef[]
  blockersCount?: number
  finalBlocker?: SessionRef
  blockedCount: number
  blockedLine?: number
  waiters: ProcWaiter[]
  history: WaitHistory[]
  historyTotal: number
  historyLine?: number
  elapsedSec?: number
}
/** A session state object with what its text says. */
export interface ProcSession {
  address: string
  line: number
  from: number
  to: number
  sid: number
  serial: number
  /** "sid.serial", the 10046 session id */
  key: string
  userId?: number
  user?: string
  containerId?: number
  containerUid?: string
  container?: string
  machine?: string
  program?: string
  clientOsUser?: string
  clientOspid?: string
  module?: string
  action?: string
  service?: string
  command?: number
  commandName?: string
  commandLine?: number
  sql?: string
  sqlId?: string
  sqlText?: string
  sqlLine?: number
  prevSql?: string
  prevSqlId?: string
  prevSqlText?: string
  prevSqlLine?: number
  wait?: ProcWait
}
/** A count of state objects of one type, as printed ("LIBRARY OBJECT LOCK", number 118). */
export interface ObjectType { type: string; number: number; count: number }
export interface ProcObjects { total: number; depth: number; byType: ObjectType[]; typesOther?: number }
/** An "Enqueue Dump" of the state objects: held (`mode`) or requested. */
export interface ProcEnqueue { resource: string; type: string; mode: string; requested?: boolean; flag?: string; in?: string; session?: string; line: number }
/** A row of a transaction's Block List. */
export interface BlockRow { itli: number; rdba: string; sqlId: string; obj: number; line: number }
export interface ProcTransaction { address: string; session?: string; line: number; xid?: string; undoBlocks?: number; undoRecords?: number; begin?: string; blocks: BlockRow[]; blocksTotal: number }
export interface ProcDMLLock { address: string; session?: string; line: number; table: number; flags?: string; mode?: number; modeName?: string }
/** A library object lock or pin. */
export interface ProcLibObject { address: string; session?: string; line: number; handle: string; mode: string; namespace?: string; type?: string; name?: string; sqlId?: string; count?: number }

/** The reading of a process state (a PROCESS STATE dump, or a `PROCESS n: name` of a system state). */
export interface ProcState {
  kind: 'procstate'
  node: string
  from: number
  to: number
  lines: number
  /** "process state" or "process" */
  scope: string
  process?: ProcInfo
  sessions: ProcSession[]
  sessionsTotal: number
  objects: ProcObjects
  enqueues: ProcEnqueue[]
  enqueuesTotal: number
  enqueuesOther?: number
  transactions: ProcTransaction[]
  transactionsTotal: number
  dmlLocks: ProcDMLLock[]
  dmlLocksTotal: number
  locks: ProcLibObject[]
  locksTotal: number
  pins: ProcLibObject[]
  pinsTotal: number
  shortStack?: string
  shortStackNoOwn?: string
  shortStackOwn?: number
  shortStackLine?: number
  notes: string[]
}

// ---- the shape, for the test that compares this file with the Go types ---------------------------------------------------------------------

/**
 * The JSON keys of each Go type as this file declares them: `req` always present in the engine's JSON, `opt` may be left out (Go `omitempty`). The key of a
 * type is its Go name. data/diagreadings.test.ts reads heap.go, pga.go, stack.go, procstate.go and digest.go and fails when a field is there that is missing here.
 */
export const READING_KEYS: Record<string, { req: string[]; opt: string[] }> = {
  HeapReading: {
    req: ['kind', 'node', 'name', 'desc', 'from', 'to', 'lines', 'extents', 'chunks', 'bytes', 'heapSize', 'flags', 'checks', 'byType', 'byComment', 'comments', 'freeLists', 'subheaps', 'subheapsTotal', 'largest', 'run'],
    opt: ['parent', 'parentNode', 'depth', 'pdb', 'otherComments', 'permanent', 'unpinned', 'otherSubheaps', 'runMore', 'runLabel'],
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
  CallStack: { req: ['kind', 'node', 'from', 'to', 'lines', 'start', 'barriers', 'plsql', 'frames', 'framesSource', 'binaryFrames', 'tableFrames', 'own', 'shortStack', 'shortStackNoOwn', 'cursors', 'cursorsTotal', 'links', 'notes'], opt: ['error', 'statement', 'plsqlLine', 'framesLine', 'tableAgrees'] },
  DumpStart: { req: ['line', 'incident', 'level', 'flags', 'mask'], opt: ['text'] },
  DumpLine: { req: ['line', 'text'], opt: [] },
  DumpError: { req: ['lines'], opt: ['signal', 'incident'] },
  DumpSignal: { req: ['line', 'code', 'ora'], opt: ['name'] },
  DumpIncident: { req: ['id', 'problem', 'args', 'line'], opt: [] },
  DumpStatement: { req: ['sqlId', 'text', 'title', 'from', 'to'], opt: ['truncated'] },
  PLSQLFrame: { req: ['n', 'handle', 'line', 'object', 'type', 'name', 'at'], opt: [] },
  StackFrame: { req: ['n', 'function', 'text', 'callee', 'line'], opt: ['offset', 'tableLine', 'own', 'component', 'errorSignaled'] },
  DumpCursor: { req: ['sqlId', 'group', 'from', 'to', 'bindCount', 'binds'], opt: ['number', 'state', 'statement'] },
  DumpBind: { req: ['pos', 'dty'], opt: ['type', 'noDef', 'avl', 'value', 'line', 'lineTo'] },
  DumpLink: { req: ['kind', 'node', 'title', 'from', 'to'], opt: [] },
  ProcState: { req: ['kind', 'node', 'from', 'to', 'lines', 'scope', 'sessions', 'sessionsTotal', 'objects', 'enqueues', 'enqueuesTotal', 'transactions', 'transactionsTotal', 'dmlLocks', 'dmlLocksTotal', 'locks', 'locksTotal', 'pins', 'pinsTotal', 'notes'], opt: ['process', 'enqueuesOther', 'shortStack', 'shortStackNoOwn', 'shortStackOwn', 'shortStackLine'] },
  ProcInfo: { req: ['line', 'address'], opt: ['pid', 'serial', 'ospid', 'osUser', 'name', 'flags', 'program'] },
  ProcSession: { req: ['address', 'line', 'from', 'to', 'sid', 'serial', 'key'], opt: ['userId', 'user', 'containerId', 'containerUid', 'container', 'machine', 'program', 'clientOsUser', 'clientOspid', 'module', 'action', 'service', 'command', 'commandName', 'commandLine', 'sql', 'sqlId', 'sqlText', 'sqlLine', 'prevSql', 'prevSqlId', 'prevSqlText', 'prevSqlLine', 'wait'] },
  ProcWait: { req: ['inWait', 'stack', 'blocked', 'blockers', 'blockedCount', 'waiters', 'history', 'historyTotal'], opt: ['line', 'lastEndedSec', 'blockersCount', 'finalBlocker', 'blockedLine', 'historyLine', 'elapsedSec'] },
  WaitEntry: { req: ['level', 'event', 'line'], opt: ['params', 'seconds'] },
  SessionRef: { req: ['inst', 'sid', 'serial', 'key', 'line'], opt: [] },
  ProcWaiter: { req: ['params'], opt: ['event', 'rowWait', 'minBlockedSec'] },
  RowWait: { req: ['obj', 'block', 'row', 'file', 'line'], opt: [] },
  WaitHistory: { req: ['n', 'event', 'line'], opt: ['params', 'seconds'] },
  ProcObjects: { req: ['total', 'depth', 'byType'], opt: ['typesOther'] },
  ObjectType: { req: ['type', 'number', 'count'], opt: [] },
  ProcEnqueue: { req: ['resource', 'type', 'mode', 'line'], opt: ['requested', 'flag', 'in', 'session'] },
  ProcTransaction: { req: ['address', 'line', 'blocks', 'blocksTotal'], opt: ['session', 'xid', 'undoBlocks', 'undoRecords', 'begin'] },
  BlockRow: { req: ['itli', 'rdba', 'sqlId', 'obj', 'line'], opt: [] },
  ProcDMLLock: { req: ['address', 'line', 'table'], opt: ['session', 'flags', 'mode', 'modeName'] },
  ProcLibObject: { req: ['address', 'line', 'handle', 'mode'], opt: ['session', 'namespace', 'type', 'name', 'sqlId', 'count'] },
  Digest: { req: ['outline'], opt: ['readings', 'readingsOmitted'] },
  DigestNode: { req: ['children'], opt: ['more'] },
}

/** The Go types that embed another and so carry its JSON keys flat (`ProcWaiter` embeds `SessionRef`): the drift test and the fixture check read them so. */
export const READING_EMBEDS: Record<string, string[]> = { ProcWaiter: ['SessionRef'] }

/** Fields this file has before the Go files do (written here first when the Go side is not in yet): the drift test lets them be absent from the Go side. None today. */
export const READING_AHEAD: Record<string, string[]> = {}

// ---- the kinds ------------------------------------------------------------------------------------------------------------------------------

export const isHeap = (r: DiagReading): r is DiagReading & HeapReading => r.kind === 'heap'
export const isPgaSummary = (r: DiagReading): r is DiagReading & PGASummary => r.kind === 'pga-summary'
export const isCallStack = (r: DiagReading): r is DiagReading & CallStack => r.kind === 'callstack'
export const isProcState = (r: DiagReading): r is DiagReading & ProcState => r.kind === 'procstate'
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

/** A call stack reading with the lists Go may leave `null` made empty. */
export function normalizeCallStack(raw: DiagReading): CallStack {
  const r = raw as unknown as CallStack
  return {
    ...r,
    ...(r.error ? { error: { ...r.error, lines: arr(r.error.lines) } } : null),
    barriers: arr(r.barriers),
    plsql: arr(r.plsql),
    frames: arr(r.frames),
    cursors: arr(r.cursors).map((c) => ({ ...c, binds: arr(c.binds) })),
    links: arr(r.links),
    notes: arr(r.notes),
  }
}

const normWait = (w: ProcWait): ProcWait => ({ ...w, stack: arr(w.stack), blockers: arr(w.blockers), waiters: arr(w.waiters).map((x) => ({ ...x, params: arr(x.params) })), history: arr(w.history) })

/** A process state reading with the lists Go may leave `null` made empty. */
export function normalizeProcState(raw: DiagReading): ProcState {
  const r = raw as unknown as ProcState
  return {
    ...r,
    sessions: arr(r.sessions).map((s) => (s.wait ? { ...s, wait: normWait(s.wait) } : s)),
    objects: { ...r.objects, byType: arr(r.objects?.byType) },
    enqueues: arr(r.enqueues),
    transactions: arr(r.transactions).map((t) => ({ ...t, blocks: arr(t.blocks) })),
    dmlLocks: arr(r.dmlLocks),
    locks: arr(r.locks),
    pins: arr(r.pins),
    notes: arr(r.notes),
  }
}
