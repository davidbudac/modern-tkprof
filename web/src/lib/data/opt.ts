// The 10053 reader's data: the TypeScript twin of internal/opt/model.go (same JSON names), the source the view reads from, and an
// in-memory source for tests, the dev harness and the standalone report.
//
// The Go file is the contract. A field may be added there, never renamed or removed, without changing this file in the same commit
// (data/opt.test.ts compares the two). Line numbers are 1-based positions in the file; a range is inclusive at both ends.
import type { Actions, Bookmark } from '../state/store'

/** A run of lines, from..to inclusive. */
export interface OptRange { from: number; to: number }

/** What one pass over a trace file finds (the file summary: the header and the dump list). */
export interface OptFile {
  name: string
  lines: number
  release: string
  version: string
  /** the version is a 19.x one: the rules were written for 19c */
  tested: boolean
  /** the 10046 records in the file; a file is a 10053 file when it has a dump and this is 0 */
  records10046: number
  dumps: OptDumpInfo[]
}

/** The summary of one dump: what the dump list shows, and what a 10046 tab needs to link to it. */
export interface OptDumpInfo {
  idx: number
  /** from..end is the dump itself; viewFrom..viewTo is what the reader shows for it (the views of a file's dumps tile the file) */
  from: number
  end: number
  viewFrom: number
  viewTo: number
  lineCount: number
  /** the file ended, or another dump began, before the end line */
  truncated?: boolean
  sqlId: string
  /** 1-based count among the file's dumps of this sql_id */
  nth: number
  stmtText: string
  /** the statement on one line, white space collapsed, cut at 240 characters */
  sqlStart: string
  tables: string[]
  /** "" when absent */
  planHash: string
  runCount: number
  /** lines of from..end directly under a phase or the dump node, in no known section */
  unplaced: number
}

/** The whole model of one dump. */
export interface OptDump extends OptDumpInfo {
  stmtLine: number
  stmtTo: number
  /** the outline; the root is the dump (kind "dump", viewFrom..viewTo) */
  tree: OptNode
  landmarks: OptLandmark[]
  folds: OptFold[]
  runs: OptRun[]
  sql: OptSql[]
  plan?: OptPlan | null
  legend: OptTerm[]
  banners: OptBanner[]
  /** by line number: "bt" banner top, "bh" banner title, "bb" banner bottom, "uh" a heading line, "ul" a lone rule line */
  roles: Record<string, string>
  hints: OptHint[]
  binds: OptBind[]
  altered: OptParam[]
  /** the lines that print a bind value (what -redact-binds and -binds none act on) */
  bindLines: number[]
  /** the line ranges the digest keeps, ascending, not overlapping */
  digest: OptRange[]
}

/** A section of the outline. */
export interface OptNode {
  id: string
  kind: string
  label: string
  crumb: string
  from: number
  to: number
  lvl: number
  children?: OptNode[]
  qb?: string
  qbn?: string
  n?: number
  of?: number
  title?: string
  count?: number
  prefix?: string
  space?: string
  /** iteration: ids of its runs, nested iterations' runs included */
  runs?: string[]
  verdict?: OptVerdict | null
  iter?: string
  iterLabel?: string
  final?: boolean
  /** run: the number of the earlier run with the same text; 0 none */
  sameAs?: number
  bestJo?: number
  table?: string
  best?: string
  tables?: string[]
  cost?: string
  /** join-order: the run's "Best join order" names it */
  isBest?: boolean
  method?: string
  /** the right-hand text of the outline row, in the trace's words */
  result?: string
  bannerBottom?: number
}

/** The line that closes a cost-based iteration. */
export interface OptVerdict { text: string; line: number; kept: boolean }

export type OptLandmarkKind = 'best-ap' | 'best-jm' | 'final-cost' | 'aborted' | 'verdict' | 'refused' | 'hint-error'
export type OptTone = 'kept' | 'rejected' | 'problem'

/** A key line. */
export interface OptLandmark { line: number; kind: string; tone: string; text: string }

/** A run of lines the formatted text closes by default (kinds: params, state, fix, ap, same-run, stmt-again, same-sql). */
export interface OptFold { id: string; from: number; to: number; lines: number; kind: string; label: string; closed: boolean }

/** A costing run, also a node of the tree (id is the node's). */
export interface OptRun {
  id: string
  n: number
  of: number
  qb: string
  qbn: string
  from: number
  to: number
  verdict?: OptVerdict | null
  iter: string
  final: boolean
  sameAs: number
  bestJo: number
}

/** One "UNPARSED QUERY IS" statement. */
export interface OptSql {
  n: number
  head: number
  line: number
  label: string
  text: string
  /** the line of the earlier identical statement; 0 none */
  sameAs: number
  /** the line of the previous different statement; 0 none */
  prev: number
}

/** The dump's plan table with what follows it. */
export interface OptPlan {
  from: number
  head: number
  tableTo: number
  to: number
  cols: string[]
  rows: OptPlanRow[]
  /** by operation id */
  qbs: Record<string, OptPlanQB>
  preds: Record<string, OptPlanPred[]>
}

/** One operation; the numbers are kept as printed ("96K"). */
export interface OptPlanRow { line: number; id: number; depth: number; op: string; name: string; rows: string; bytes: string; cost: string; time: string }
export interface OptPlanQB { qb: string; alias: string; line: number }
export interface OptPlanPred { text: string; line: number }

/** An entry of the trace's own Legend. */
export interface OptTerm { term: string; text: string; line: number; codes: [string, string][] }

/** A title between two rule lines. */
export interface OptBanner { top: number; title: number; bottom: number; text: string }

/** One line of "Dumping Hints" or of the Hint Report. */
export interface OptHint {
  line: number
  text: string
  err: number
  used: number
  note?: string
  /** which section the line is from: "dump" (Dumping Hints) or "report" (Hint Report) */
  src?: string
}

/** A peeked bind. */
export interface OptBind {
  pos: number
  type: string
  value: string
  line: number
  /** the position of the bind this one repeats; 0 (left out) when it is not a repeat */
  dup?: number
}

/** An altered parameter or fix control. `from`: "altered", "opt_param". */
export interface OptParam { name: string; value: string; line: number; from: string }

// ---- the source the view reads from ------------------------------------------------------------------------------------------------

/** The lines of one dump's view range that a source holds. */
export interface OptText {
  from: number
  to: number
  /** every line of from..to is there (false: a digest, the lines the report keeps) */
  complete: boolean
  /** the line's text; undefined: the line is not included (digest) */
  get(line: number): string | undefined
}

/** What the 10053 view reads. A source over HTTP, over the standalone report's document, or over memory. */
export interface OptSource {
  file: OptFile
  dump(idx: number): Promise<OptDump>
  text(idx: number): Promise<OptText>
}

/** Bookmarks and notes on lines, as the view uses them. `bookmarks` maps a bookmarked line to its note ('' for none). The owner re-renders the view with a new object when it changes. */
export interface OptAnnotations {
  bookmarks: ReadonlyMap<number, string>
  /** bookmark a line, or take its bookmark (and its note) away */
  toggle(line: number): void
  /** set the note of a line (bookmarking it when it is not); '' removes the note, not the bookmark */
  setNote(line: number, note: string): void
  remove(line: number): void
}

/** The view's links to a 10046 tab: whether a statement of this sql_id is in another open tab, and the jump to it. */
export interface Opt10046Link { has(sqlId: string): boolean; open(sqlId: string): void }

/**
 * The view's bookmarks and notes over the lib's own model (`State.bookmarks`, which a shell persists as annotations): the bookmarks of input file `file`
 * as the view's map, and the three changes as the store's actions. The owner passes the store's current `bookmarks` and re-renders when they change.
 * `labelOf` gives a new bookmark its label (the Trace pane uses the line's text).
 */
export function storeAnnotations(
  bookmarks: readonly Bookmark[], file: number,
  actions: Pick<Actions, 'addBookmark' | 'setBookmarkNote' | 'removeBookmark'>,
  labelOf: (line: number) => string = () => '',
): OptAnnotations {
  const m = new Map<number, string>()
  for (const b of bookmarks) if (b.file === file) m.set(b.line, b.note ?? '')
  return {
    bookmarks: m,
    toggle: (line) => (m.has(line) ? actions.removeBookmark(file, line) : actions.addBookmark(file, line, labelOf(line))),
    setNote: (line, note) => actions.setBookmarkNote(file, line, note, labelOf(line)),
    remove: (line) => actions.removeBookmark(file, line),
  }
}

// ---- texts -------------------------------------------------------------------------------------------------------------------------

/** The lines of a file's text (a trailing newline does not make a line). */
export function splitLines(content: string): string[] {
  const out = content.split('\n')
  if (out.length > 0 && out[out.length - 1] === '') out.pop()
  for (let i = 0; i < out.length; i++) if (out[i].endsWith('\r')) out[i] = out[i].slice(0, -1)
  return out
}

/** A complete text of lines from..to, out of the file's lines (`all[0]` is line 1). */
export function completeText(all: readonly string[], from: number, to: number): OptText {
  return { from, to, complete: true, get: (line) => (line >= from && line <= to ? all[line - 1] : undefined) }
}

/** A sparse text: only the lines in `ranges` (inside from..to) are there. `getLine` reads the file's line (1-based). */
export function sparseText(from: number, to: number, ranges: readonly OptRange[], getLine: (line: number) => string | undefined): OptText {
  const keep = new Set<number>()
  for (const r of ranges) for (let i = Math.max(from, r.from); i <= Math.min(to, r.to); i++) keep.add(i)
  return { from, to, complete: false, get: (line) => (keep.has(line) ? getLine(line) : undefined) }
}

/** The number of lines a text holds (all of from..to, or the digest's). */
export function textLineCount(t: OptText): number {
  if (t.complete) return t.to - t.from + 1
  let n = 0
  for (let i = t.from; i <= t.to; i++) if (t.get(i) !== undefined) n++
  return n
}

// ---- normalising a dump from JSON -------------------------------------------------------------------------------------------------

/** A dump as the engine's JSON gives it, with what Go leaves `null` (an empty slice or map) made empty, so the view never tests for it. */
export function normalizeDump(raw: OptDump): OptDump {
  const d = raw as OptDump & Record<string, unknown>
  const arr = <T>(v: T[] | null | undefined): T[] => v ?? []
  const plan = d.plan ? { ...d.plan, cols: arr(d.plan.cols), rows: arr(d.plan.rows), qbs: d.plan.qbs ?? {}, preds: d.plan.preds ?? {} } : null
  return {
    ...d,
    tables: arr(d.tables),
    landmarks: arr(d.landmarks), folds: arr(d.folds), runs: arr(d.runs), sql: arr(d.sql), legend: arr(d.legend).map((t) => ({ ...t, codes: arr(t.codes) })),
    banners: arr(d.banners), hints: arr(d.hints), binds: arr(d.binds), altered: arr(d.altered), bindLines: arr(d.bindLines), digest: arr(d.digest),
    roles: d.roles ?? {}, plan,
  }
}

/**
 * An in-memory source: the file summary, the dumps and the file's text (a string, or its lines). `digest`: each dump's text is cut to the
 * line ranges of the dump's digest (what the standalone report holds), so `complete` is false and the view shows gap rows.
 */
export function memoryOptSource(file: OptFile, dumps: readonly OptDump[], text: string | readonly string[], opts: { digest?: boolean } = {}): OptSource {
  const all = typeof text === 'string' ? splitLines(text) : text
  const norm = dumps.map(normalizeDump)
  return {
    file,
    dump: (idx) => (norm[idx] ? Promise.resolve(norm[idx]) : Promise.reject(new Error(`no dump ${idx}`))),
    text: (idx) => {
      const d = norm[idx]
      if (!d) return Promise.reject(new Error(`no dump ${idx}`))
      return Promise.resolve(opts.digest ? sparseText(d.viewFrom, d.viewTo, d.digest, (l) => all[l - 1]) : completeText(all, d.viewFrom, d.viewTo))
    },
  }
}

// ---- the shape, for the test that compares this file with the Go types ------------------------------------------------------------------

/**
 * The JSON keys of each type as this file declares them: `req` always present in the engine's JSON, `opt` may be left out (Go `omitempty`).
 * data/opt.test.ts reads internal/opt/model.go and fails when a field is there that is missing here, or the other way round.
 */
export const OPT_KEYS: Record<string, { req: string[]; opt: string[] }> = {
  Range: { req: ['from', 'to'], opt: [] },
  File: { req: ['name', 'lines', 'release', 'version', 'tested', 'records10046', 'dumps'], opt: [] },
  DumpInfo: { req: ['idx', 'from', 'end', 'viewFrom', 'viewTo', 'lineCount', 'sqlId', 'nth', 'stmtText', 'sqlStart', 'tables', 'planHash', 'runCount', 'unplaced'], opt: ['truncated'] },
  Dump: { req: ['stmtLine', 'stmtTo', 'tree', 'landmarks', 'folds', 'runs', 'sql', 'legend', 'banners', 'roles', 'hints', 'binds', 'altered', 'bindLines', 'digest'], opt: ['plan'] },
  Node: {
    req: ['id', 'kind', 'label', 'crumb', 'from', 'to', 'lvl'],
    opt: ['children', 'qb', 'qbn', 'n', 'of', 'title', 'count', 'prefix', 'space', 'runs', 'verdict', 'iter', 'iterLabel', 'final', 'sameAs', 'bestJo', 'table', 'best', 'tables', 'cost', 'isBest', 'method', 'result', 'bannerBottom'],
  },
  Verdict: { req: ['text', 'line', 'kept'], opt: [] },
  Landmark: { req: ['line', 'kind', 'tone', 'text'], opt: [] },
  Fold: { req: ['id', 'from', 'to', 'lines', 'kind', 'label', 'closed'], opt: [] },
  Run: { req: ['id', 'n', 'of', 'qb', 'qbn', 'from', 'to', 'iter', 'final', 'sameAs', 'bestJo'], opt: ['verdict'] },
  SQL: { req: ['n', 'head', 'line', 'label', 'text', 'sameAs', 'prev'], opt: [] },
  Plan: { req: ['from', 'head', 'tableTo', 'to', 'cols', 'rows', 'qbs', 'preds'], opt: [] },
  PlanRow: { req: ['line', 'id', 'depth', 'op', 'name', 'rows', 'bytes', 'cost', 'time'], opt: [] },
  PlanQB: { req: ['qb', 'alias', 'line'], opt: [] },
  PlanPred: { req: ['text', 'line'], opt: [] },
  Term: { req: ['term', 'text', 'line', 'codes'], opt: [] },
  Banner: { req: ['top', 'title', 'bottom', 'text'], opt: [] },
  Hint: { req: ['line', 'text', 'err', 'used'], opt: ['note', 'src'] },
  Bind: { req: ['pos', 'type', 'value', 'line'], opt: ['dup'] },
  Param: { req: ['name', 'value', 'line', 'from'], opt: [] },
}
