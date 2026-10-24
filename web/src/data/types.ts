// Mirrors the JSON document written by internal/report/doc.go (format 2).

export type ID = number // -1 = none
export const NONE: ID = -1

export interface KV { key: string; value: string }

export interface FileInfo {
  path: string
  headers: KV[]
  traceFile: string
  version: string
  instance: string
  node: string
  machine: string
  systemName: string
  processPid: string
  continuedFrom?: string[]
  continuesIn?: string[]
  dumpSizeLimit?: number
  truncated: boolean
  files?: FileEntry[]
}

/** One input file of a trace set (a single-file trace has one entry). */
export interface FileEntry {
  idx: number
  path: string
  name: string
  size: number
  lines: number
  firstTim: number
  lastTim: number
  firstWallUs: number
  lastWallUs: number
  processPid: string
  instance: string
  traceFile: string
  px: boolean
  chain: number
  followed: boolean
  continuedFrom?: string[]
  continuesIn?: string[]
}

export interface Span {
  firstTim: number
  lastTim: number
  firstWallUs: number
  lastWallUs: number
  firstLine: number
  lastLine: number
}

export type StatementKind = 0 | 1 | 2 | 3 | 4 | 5 | 6
export const StmtKind = { sql: 0, unknown: 1, commit: 2, rollback: 3, lob: 4, rpc: 5, parseError: 6 } as const

export interface Statement {
  id: ID
  kind: StatementKind
  sqlId: string
  hashValue: number
  text: string
  len: number
  commandType: number
  commandName: string
  parsingUserId: number
  privilegeUserId: number
  minDepth: number
  firstLine: number
  cursors: ID[]
  /** DBMS_XPLAN text from a reference bundle (mtkprof -ref) */
  refPlan?: string
}

export interface Cursor {
  id: ID
  number: number
  statement: ID
  line: number
  depth: number
  tim: number
  address?: string
  planHash: number
  context: ID
  implicit: boolean
  assumed: boolean
  execs: number
  closed: boolean
}

export interface Context {
  id: ID
  line: number
  sessionId: string
  clientId: string
  service: string
  module: string
  action: string
  clientDriver: string
  containerId: string
  process: string
  fileIdx?: number
  /** PX slave trace; `parent` is then the coordinator's context (-1 = unattached) */
  px?: boolean
  parent?: ID
}

export interface Event {
  id: ID
  name: string
  class: string
  p1Name: string
  p2Name: string
  p3Name: string
  idle: boolean
}

export interface Plan {
  id: ID
  line: number
  cursor: ID
  statement: ID
  planHash: number
  first: number
  n: number
  xPlanMatched?: boolean
}

export interface PlanLine {
  plan: ID
  id: number
  parentId: number
  pos: number
  depth: number
  obj: number
  op: string
  object: string
  rows: number
  starts: number
  cr: number
  pr: number
  pw: number
  timeUs: number
  cost: number
  size: number
  card: number
  hasStats: boolean
  access?: string
  filter?: string
  alias?: string
  qblock?: string
  eRows?: number
}

export interface Transaction {
  id: ID
  line: number
  rollback: number
  readOnly: number
  tim: number
  wallUs: number
  call: ID
  context: ID
}

export interface ErrorEvent {
  id: ID
  line: number
  cursor: ID
  statement: ID
  err: number
  tim: number
  wallUs: number
  parseError: boolean
  text?: string
  context: ID
}

export interface Marker {
  line: number
  kind: number
  text: string
  time: string
  hasTime: boolean
}

export interface Diagnostics {
  lines: number
  bytes: number
  unknownLines: number
  implicitCursors: number
  assumedCursors: number
  orphanCalls: number
  unattributedWaits: number
  timeAnchors: number
  lineKinds: Record<string, number>
  notes?: string[]
}

export interface CallStats {
  count: number
  misses: number
  cpu: number
  elapsed: number
  disk: number
  query: number
  current: number
  rows: number
  waitUs: number
  idleUs: number
  selfCpu: number
  selfElapsed: number
  selfDisk: number
  selfQuery: number
  selfCurrent: number
}

export interface Link { statement: ID; calls: number; elapsed: number }

export interface StmtStats {
  id: ID
  parse: CallStats
  exec: CallStats
  fetch: CallStats
  close: CallStats
  other: CallStats
  total: CallStats
  allCalls: CallStats
  elapsed: number
  selfElapsed: number
  cpu: number
  selfCpu: number
  waitUs: number
  idleUs: number
  childUs: number
  executions: number
  hardParses: number
  cursors: number
  errors: number
  minDepth: number
  maxDepth: number
  topLevel: boolean
  firstWallUs: number
  lastWallUs: number
  firstTim: number
  lastTim: number
  /** work of attached PX slaves (not part of the figures above) */
  pxEla?: number
  pxCpu?: number
  pxSessions?: number
  parents: Link[] | null
  children: Link[] | null
  plans: ID[] | null
  planHashes: number[] | null
}

export interface ProfileRow {
  component: string
  kind: 'cpu' | 'wait' | 'idle' | 'unaccounted'
  class?: string
  us: number
  pct: number
  count: number
  avgUs: number
  minUs: number
  maxUs: number
}

export interface Profile {
  label: string
  totalUs: number
  cpuUs: number
  waitUs: number
  idleUs: number
  unaccountedUs: number
  rows: ProfileRow[]
}

export interface EventAgg {
  event: ID
  name: string
  class: string
  idle: boolean
  count: number
  us: number
  minUs: number
  maxUs: number
}

export interface Bucket {
  startUs: number
  calls: number
  cpuUs: number
  elaUs: number
  waitUs: number
  idleUs: number
  disk: number
  query: number
  rows: number
}

/** One rule hit (internal/analyze/findings.go). */
export type Severity = 'serious' | 'notable' | 'info'

export interface EvidenceRow {
  label: string
  value: string
  statement: ID // -1 when not about one statement
  cursor: ID
  execNo?: number
  call: ID
  line?: number
  us?: number
}

export interface Finding {
  rule: string
  title: string
  severity: Severity
  summary: string
  statement: ID // -1 for trace-level findings
  impactUs: number
  evidence: EvidenceRow[]
}

export interface ColumnDesc { t: 'f64' | 'i32' | 'u8'; off: number; n: number }
export type RawColumn = number[] | ColumnDesc

export interface RawTable { n: number; blob?: string; [col: string]: unknown }

export interface RawFacts {
  packed: boolean
  calls: RawTable
  waits: RawTable
  bindSets: RawTable
  binds: RawTable & { type: string[]; value: string[] }
}

/** Names from a reference bundle (mtkprof -ref); the fact tables keep raw numbers. */
export interface RefObject { id: number; owner: string; name: string; subobject?: string; type?: string }
export interface RefFile { file: number; name: string; tablespace?: string; type?: string }
export interface RefUser { id: number; name: string }

export interface RawDocument {
  tool: string
  version: string
  generated: string
  format: number
  file: FileInfo
  span: Span
  statements: Statement[]
  cursors: Cursor[]
  contexts: Context[]
  events: Event[]
  plans: Plan[]
  planLines: PlanLine[]
  transactions: Transaction[]
  errors: ErrorEvent[]
  markers: Marker[]
  diag: Diagnostics
  unknown: { line: number; text: string }[] | null
  facts?: RawFacts
  planViz?: string
  objects?: RefObject[] | null
  files?: RefFile[] | null
  users?: RefUser[] | null
  stats: {
    statements: StmtStats[]
    profile: Profile
    events: EventAgg[]
    timeline: Bucket[] | null
    bucketUs: number
    findings?: Finding[] | null
    /** effective finding thresholds (analyze.Thresholds JSON keys); absent in older documents */
    findingsConfig?: Record<string, number> | null
    contexts?: ContextStats[] | null
  }
}

/** analyze.ContextStats: activity of one session context (the SESSIONS numbers). */
export interface ContextStats {
  context: ID
  calls: number
  rows: number
  elapsed: number // Σ e of top-level calls
  cpu: number // Σ c of top-level calls
  waitUs: number // non-idle waits
  idleUs: number // idle waits
  firstTim: number
  lastTim: number
}

// Call kinds (trace.CallKind)
export const CallKind = {
  unknown: 0, parse: 1, exec: 2, fetch: 3, close: 4,
  lobRead: 5, lobWrite: 6, lobGetLen: 7, lobPgSize: 8, lobAppend: 9, lobTmpFre: 10,
  lobArrTmpFre: 11, lobArrRead: 12, lobArrWrite: 13, lobTrim: 14, lobOther: 15,
  rpcExec: 16, unmap: 17, xctend: 18,
} as const

export const callKindName: string[] = [
  'UNKNOWN', 'PARSE', 'EXEC', 'FETCH', 'CLOSE', 'LOBREAD', 'LOBWRITE', 'LOBGETLEN', 'LOBPGSIZE', 'LOBAPPEND',
  'LOBTMPFRE', 'LOBARRTMPFRE', 'LOBARRREAD', 'LOBARRWRITE', 'LOBTRIM', 'LOB', 'RPC EXEC', 'UNMAP', 'XCTEND',
]

// ---- comparison (internal/analyze/compare.go; the diff of `mtkprof ... -compare`) ----

export interface CmpMetric { key: string; label: string; unit: 'us' | 'count'; a: number; b: number; delta: number }
export interface CmpProfileRow { component: string; kind: string; class?: string; aUs: number; bUs: number; deltaUs: number; aPct: number; bPct: number }
export interface CmpStmtSide {
  id: ID; elapsed: number; selfElapsed: number; cpu: number; executions: number; perExecUs: number; parses: number; hardParses: number
  fetches: number; rows: number; disk: number; query: number; current: number; planHashes: number[]
}
export type CmpStatus = 'both' | 'onlyA' | 'onlyB'
export interface CmpStmt {
  key: string; sqlId: string; kind: StatementKind; text: string; status: CmpStatus
  a: CmpStmtSide | null; b: CmpStmtSide | null
  dElapsed: number; dPerExecUs: number; dExecutions: number; dCpu: number; dDisk: number; dQuery: number; dRows: number; planChanged: boolean
}
export interface CmpEvent { name: string; class: string; idle: boolean; a: { count: number; us: number }; b: { count: number; us: number }; deltaUs: number; dCount: number }
export interface CmpSide { path: string; traceFile: string; version: string; instance: string; spanUs: number; firstWallUs: number }
export interface Comparison {
  a: CmpSide; b: CmpSide
  totals: CmpMetric[]; classes: CmpMetric[]; profile: CmpProfileRow[]; statements: CmpStmt[]; events: CmpEvent[]
}

/** The document of `-compare`: both trace documents and the diff. */
export interface RawCompareDocument {
  tool: string
  version: string
  format: number
  compare: { a: RawDocument; b: RawDocument; diff: Comparison }
}
