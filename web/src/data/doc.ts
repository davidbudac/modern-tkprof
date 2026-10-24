import type {
  RawDocument, Statement, Cursor, Context, Event, Plan, PlanLine, Transaction, ErrorEvent,
  StmtStats, Profile, EventAgg, Bucket, FileInfo, Span, Diagnostics, Marker, ID, Finding,
} from './types'
import { NONE } from './types'
import { unpackTable, type NumCol } from './columns'

const callCols = ['line', 'kind', 'cursor', 'stmt', 'c', 'e', 'p', 'cr', 'cu', 'mis', 'r', 'dep', 'og', 'plh', 'tim', 'type',
  'parent', 'selfE', 'selfC', 'selfP', 'selfCR', 'selfCU', 'ctx', 'execNo', 'bindSet', 'waitEla', 'idleEla', 'nWaits', 'flags'] as const
const waitCols = ['line', 'cursor', 'stmt', 'call', 'event', 'ela', 'p1', 'p2', 'p3', 'obj', 'tim', 'ctx', 'dep', 'flags'] as const
const bindSetCols = ['line', 'cursor', 'stmt', 'call', 'first', 'count', 'flags'] as const
const bindCols = ['set', 'pos', 'dty', 'flags', 'mal', 'avl'] as const

export type Calls = Record<(typeof callCols)[number], NumCol> & { n: number }
export type Waits = Record<(typeof waitCols)[number], NumCol> & { n: number }
export type BindSets = Record<(typeof bindSetCols)[number], NumCol> & { n: number }
export type Binds = Record<(typeof bindCols)[number], NumCol> & { n: number; type: string[]; value: string[] }

/** CSR index: ids grouped by an integer key. */
export class Index {
  readonly offsets: Int32Array
  readonly ids: Int32Array
  constructor(keys: NumCol, nKeys: number) {
    const counts = new Int32Array(nKeys + 1)
    for (let i = 0; i < keys.length; i++) { const k = keys[i]; if (k >= 0 && k < nKeys) counts[k + 1]++ }
    for (let k = 0; k < nKeys; k++) counts[k + 1] += counts[k]
    this.offsets = counts
    this.ids = new Int32Array(counts[nKeys])
    const fill = counts.slice(0, nKeys)
    for (let i = 0; i < keys.length; i++) { const k = keys[i]; if (k >= 0 && k < nKeys) this.ids[fill[k]++] = i }
  }
  get(key: number): Int32Array {
    if (key < 0 || key + 1 >= this.offsets.length) return new Int32Array(0)
    return this.ids.subarray(this.offsets[key], this.offsets[key + 1])
  }
  count(key: number): number {
    if (key < 0 || key + 1 >= this.offsets.length) return 0
    return this.offsets[key + 1] - this.offsets[key]
  }
}

/** The loaded trace: dimension tables as objects, facts as typed columns, plus indexes. */
export class TraceDoc {
  readonly version: string
  readonly file: FileInfo
  readonly span: Span
  readonly statements: Statement[]
  readonly cursors: Cursor[]
  readonly contexts: Context[]
  readonly events: Event[]
  readonly plans: Plan[]
  readonly planLines: PlanLine[]
  readonly transactions: Transaction[]
  readonly errors: ErrorEvent[]
  readonly markers: Marker[]
  readonly diag: Diagnostics
  readonly unknown: { line: number; text: string }[]
  readonly stats: { statements: StmtStats[]; profile: Profile; events: EventAgg[]; timeline: Bucket[]; bucketUs: number; findings: Finding[] }

  readonly hasFacts: boolean
  /** base URL of the plan visualizer set by the CLI (optional) */
  readonly planViz?: string
  readonly calls: Calls
  readonly waits: Waits
  readonly bindSets: BindSets
  readonly binds: Binds

  // indexes (built lazily)
  private _callsByStmt?: Index
  private _waitsByStmt?: Index
  private _waitsByCall?: Index
  private _childCalls?: Index
  private _plansByStmt?: Map<ID, Plan[]>
  private _bindSetsByStmt?: Index

  /** microseconds to add to a tim value to get wall-clock µs since the epoch (0 = unknown) */
  readonly wallOffsetUs: number
  /** the trace file's UTC offset in minutes, from its first timestamp marker */
  readonly tzOffsetMin: number

  private constructor(raw: RawDocument, calls: Calls, waits: Waits, bindSets: BindSets, binds: Binds) {
    this.version = raw.version
    this.file = raw.file
    this.span = raw.span
    this.statements = raw.statements
    this.cursors = raw.cursors
    this.contexts = raw.contexts ?? []
    this.events = raw.events ?? []
    this.plans = raw.plans ?? []
    this.planLines = raw.planLines ?? []
    this.transactions = raw.transactions ?? []
    this.errors = raw.errors ?? []
    this.markers = raw.markers ?? []
    this.diag = raw.diag
    this.unknown = raw.unknown ?? []
    this.stats = { ...raw.stats, timeline: raw.stats.timeline ?? [], findings: raw.stats.findings ?? [] }
    this.hasFacts = !!raw.facts
    this.planViz = raw.planViz || undefined
    this.calls = calls
    this.waits = waits
    this.bindSets = bindSets
    this.binds = binds
    this.wallOffsetUs = raw.span.firstWallUs ? raw.span.firstWallUs - raw.span.firstTim : 0
    this.tzOffsetMin = tzOffsetOf(raw.markers)
  }

  static async fromRaw(raw: RawDocument): Promise<TraceDoc> {
    if (raw.format !== 2) throw new Error(`unsupported document format ${raw.format}`)
    const empty = { n: 0 } as Record<string, unknown> & { n: number }
    const f = raw.facts
    const [c, w, s, b] = await Promise.all([
      unpackTable(f?.calls ?? empty, callCols),
      unpackTable(f?.waits ?? empty, waitCols),
      unpackTable(f?.bindSets ?? empty, bindSetCols),
      unpackTable(f?.binds ?? empty, bindCols),
    ])
    const calls = Object.assign(c, { n: f?.calls.n ?? 0 }) as Calls
    const waits = Object.assign(w, { n: f?.waits.n ?? 0 }) as Waits
    const bindSets = Object.assign(s, { n: f?.bindSets.n ?? 0 }) as BindSets
    const binds = Object.assign(b, { n: f?.binds.n ?? 0, type: f?.binds.type ?? [], value: f?.binds.value ?? [] }) as Binds
    return new TraceDoc(raw, calls, waits, bindSets, binds)
  }

  get callsByStmt(): Index { return (this._callsByStmt ??= new Index(this.calls.stmt, this.statements.length)) }
  get waitsByStmt(): Index { return (this._waitsByStmt ??= new Index(this.waits.stmt, this.statements.length)) }
  get waitsByCall(): Index { return (this._waitsByCall ??= new Index(this.waits.call, this.calls.n)) }
  get childCalls(): Index { return (this._childCalls ??= new Index(this.calls.parent, this.calls.n)) }
  get bindSetsByStmt(): Index { return (this._bindSetsByStmt ??= new Index(this.bindSets.stmt, this.statements.length)) }
  plansOf(stmt: ID): Plan[] {
    if (!this._plansByStmt) {
      this._plansByStmt = new Map()
      for (const p of this.plans) {
        const l = this._plansByStmt.get(p.statement)
        if (l) l.push(p); else this._plansByStmt.set(p.statement, [p])
      }
    }
    return this._plansByStmt.get(stmt) ?? []
  }

  wallOf(tim: number): number { return this.wallOffsetUs ? tim + this.wallOffsetUs : 0 }
  spanUs(): number { return Math.max(0, this.span.lastTim - this.span.firstTim) }

  stmt(id: ID): Statement | undefined { return id === NONE ? undefined : this.statements[id] }
  event(id: ID): Event | undefined { return id === NONE ? undefined : this.events[id] }
  context(id: ID): Context | undefined { return id === NONE ? undefined : this.contexts[id] }

  /** Short identity for a statement: sql_id or a synthetic label. */
  label(s: Statement): string {
    switch (s.kind) {
      case 0: return s.sqlId || `hv:${s.hashValue}`
      case 1: return 'unknown'
      case 2: return 'commit'
      case 3: return 'rollback'
      case 4: return 'lob'
      case 5: return 'rpc'
      case 6: return 'parse error'
    }
    return '?'
  }
}

function tzOffsetOf(markers: Marker[]): number {
  for (const m of markers) {
    if (!m.hasTime) continue
    const mt = /([+-])(\d\d):(\d\d)$/.exec(m.time)
    if (mt) return (mt[1] === '-' ? -1 : 1) * (parseInt(mt[2]) * 60 + parseInt(mt[3]))
    if (m.time.endsWith('Z')) return 0
  }
  return 0
}
