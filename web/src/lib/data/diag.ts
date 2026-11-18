// The dump reader's data (docs/PLAN-DIAG.md § The reader): the TypeScript twin of internal/diag/model.go (same JSON names), the source the view reads
// from, and an in-memory source for tests, the dev harness and the standalone report.
//
// The Go file is the contract. A field may be added there, never renamed or removed, without changing this file in the same commit
// (data/diag.test.ts compares the two). Line numbers are 1-based positions in the file; a range is inclusive at both ends.
import type { AnnotPage, AnnotLine, SearchEnd, SearchHit, SearchQuery } from './lines'

/** What one pass over a trace file finds (the file's facts, the parser's sections and the top level of the outline). */
export interface DiagFile {
  name: string
  lines: number
  /** prologue line 2; '' when the file has none */
  release: string
  /** "19.27.0.0.0"; '' when the file has none */
  version: string
  /** the version is a 19.x one: the rules were written for 19c, another version is read with them */
  tested: boolean
  /** the lines that are 10046 records; 0 for a file this reader is the default view of */
  records10046: number
  incident?: DiagIncident
  /** the diagnostic dumps the parser found, in file order */
  sections: DiagSection[]
  /** the lines outside the header and every section that are none of: blank, a marker, a rule line, a 10046 record */
  unplaced: number
  /** the top level: the nodes tile the file; at most 2,000 (see outlineTotal) */
  outline: DiagNode[]
  outlineTotal: number
}

export interface DiagSection { kind: string; first: number; last: number; cut?: boolean }

export interface DiagIncident { dumpFile: string; continuedFrom?: string; id?: string; problem?: string }

/** A row of the outline: a part of the file with a title and a range of lines. */
export interface DiagNode {
  /** unique in the file and stable for it ("heap:32-923:1:200"); `root` is the top level */
  id: string
  /** header, other, trace10046; a section (heap, pga-summary, pga-detail, diagdump, procstate, sysstate, hang, deadlock, incident); inside one: title, banner, frame, process, so, chain, toc, extents, extent, freelists, bucket, unpinned, permanent, subheaps */
  kind: string
  title: string
  sub?: string
  from: number
  to: number
  lines: number
  hasChildren: boolean
  /** process, frame, chain, extent, bucket: its number; toc: the number of the marker */
  n?: number
  /** heap: the heap name; process: the process name */
  name?: string
  /** heap: "dsx heap depth" of the header */
  depth?: number
  /** heap: "dsx heap size", bytes */
  size?: number
  /** trace10046: the number of 10046 records in the run */
  records?: number
  /** a section whose end line was not reached */
  cut?: boolean
  /** the node has a computed reading of this kind (`api/diag/reading?node=`): heap, pga-summary, pga-detail, ... Absent when it has none */
  reading?: string
}

/** The children of a node. */
export interface DiagOutline {
  node: string
  /** at most 2,000, in file order, inside the node, not overlapping */
  children: DiagNode[]
  /** how many children follow those listed */
  more: number
  /** when `more` > 0, the `after` of the next page (the children already seen) */
  next?: number
}

/** What a source answers for a node: the engine's answer, and, from the standalone report's digest, `unlisted`: children that exist and are not in the report (they cannot be asked for). */
export interface DiagChildren extends DiagOutline { unlisted?: number }

/** The digest of a diag file in a standalone report: every node of the top level with its own children (one level down, at most 100). */
export interface DiagDigest { outline: DiagDigestNode[] }
export interface DiagDigestNode extends DiagNode { children: DiagNode[]; more?: number }

/** The `dump` member of the document of a diag session. */
export interface RawDump { file: DiagFile; digest?: DiagDigest | null }

/** The computed reading of a node (`api/diag/reading?node=ID`): a `kind` and what that kind carries. */
export interface DiagReading { kind: string; [key: string]: unknown }

/** The root of the outline: the id the top level's overflow is asked for with. */
export const ROOT = 'root'

/** The largest answer of `api/diag/outline` (diag.Cap). */
export const OUTLINE_CAP = 2000

/** The node has no reading (the server answered 404): not an error to show, the view says so. */
export class NoReading extends Error {
  constructor(message = 'no reading for this node') { super(message); this.name = 'NoReading' }
}

/** The text of the file, in pages, and search over it. */
export interface DiagText {
  /** `n` lines (at most 2,000) from line `from`, each with its kind (`api/lines?annot=1`) */
  page(from: number, n: number, signal: AbortSignal): Promise<AnnotPage>
  /** literal or regular expression; hits arrive in line order (`api/search`) */
  search(q: Omit<SearchQuery, 'file'>, onHit: (h: SearchHit) => void, signal: AbortSignal): Promise<SearchEnd>
}

/** What the dump reader reads: three implementations (HTTP for the apps, the document's digest for the standalone report, memory for tests and the harness). */
export interface DiagSource {
  file: DiagFile
  /** the file's text; null where there is none (the standalone report keeps the outline only) */
  text: DiagText | null
  /** the report holds the outline to a depth only: nodes below it cannot be asked for (`outline` rejects) */
  digest: boolean
  /** answers already in hand (the digest's children of the top-level nodes), by node id */
  preloaded?: ReadonlyMap<string, DiagChildren>
  /** the children of a node (`root` for the top level beyond `file.outline`), `after` of them skipped */
  outline(node: string, after?: number): Promise<DiagChildren>
  /** the reading of a node; rejects with `NoReading` for a node that has none */
  reading(node: string): Promise<DiagReading>
}

// ---- the shape, for the test that compares this file with the Go types --------------------------------------------------------------------

/**
 * The JSON keys of each type as this file declares them: `req` always present in the engine's JSON, `opt` may be left out (Go `omitempty`).
 * data/diag.test.ts reads internal/diag/model.go and fails when a field is there that is missing here.
 */
export const DIAG_KEYS: Record<string, { req: string[]; opt: string[] }> = {
  File: { req: ['name', 'lines', 'release', 'version', 'tested', 'records10046', 'sections', 'unplaced', 'outline', 'outlineTotal'], opt: ['incident'] },
  Section: { req: ['kind', 'first', 'last'], opt: ['cut'] },
  Incident: { req: ['dumpFile'], opt: ['continuedFrom', 'id', 'problem'] },
  Node: { req: ['id', 'kind', 'title', 'from', 'to', 'lines', 'hasChildren'], opt: ['sub', 'n', 'name', 'depth', 'size', 'records', 'cut', 'reading'] },
  Outline: { req: ['node', 'children', 'more'], opt: ['next'] },
}

/** Fields this file has before model.go does (a new one is written here first when the Go side is not in yet): the drift test lets them be absent from the Go side. None today. */
export const DIAG_AHEAD: Record<string, string[]> = {}

// ---- normalising what Go leaves null -------------------------------------------------------------------------------------------------------

/** A node as the engine's JSON gives it: nothing to fix today (every list is made non-null in Go), kept as the one place to do it. */
export const normalizeNode = (n: DiagNode): DiagNode => n

/** A file as the JSON gives it, with the lists Go may leave `null` made empty. */
export function normalizeFile(raw: DiagFile): DiagFile {
  return { ...raw, sections: raw.sections ?? [], outline: (raw.outline ?? []).map(normalizeNode) }
}

export function normalizeOutline(raw: DiagOutline): DiagOutline {
  return { ...raw, children: (raw.children ?? []).map(normalizeNode), more: raw.more ?? 0 }
}

// ---- the lines of a memory source ---------------------------------------------------------------------------------------------------------------

/** The parser's line kind as far as the reader needs it for a text that has no parser behind it (the harness, the tests): a blank, a `*** ` marker, or a diagnostic line. */
export function kindOfLine(text: string): AnnotLine['k'] {
  if (text.trim() === '') return 'blank'
  if (text.startsWith('*** ')) return 'marker'
  return 'diagnostic'
}

/** Lines (`all[0]` is line 1) as a text: pages and a literal or regular expression search, as the server answers them. `at` makes a line on demand (a file too big to hold). */
export function memoryText(lines: readonly string[] | { count: number; at(line: number): string }): DiagText {
  const count = Array.isArray(lines) ? lines.length : (lines as { count: number }).count
  const at = (n: number): string => (Array.isArray(lines) ? (lines as readonly string[])[n - 1] : (lines as { at(line: number): string }).at(n))
  return {
    page: (from, n) => {
      const out: AnnotLine[] = []
      for (let i = from; i < from + n && i <= count; i++) { const t = at(i); out.push({ t, k: kindOfLine(t) }) }
      return Promise.resolve({ from, total: count, lines: out })
    },
    search: (q, onHit, signal) => {
      let re: RegExp
      try {
        re = new RegExp(q.regex ? q.q : q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), q.caseSensitive ? '' : 'i')
      } catch (e) {
        return Promise.reject(e)
      }
      let hits = 0
      let scanned = 0
      for (let i = Math.max(1, q.from); i <= count; i++) {
        if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
        scanned++
        const t = at(i)
        const m = re.exec(t)
        if (m) {
          onHit({ line: i, col: m.index, text: t.slice(0, 400) })
          if (++hits >= q.limit) return Promise.resolve({ scanned, truncated: true, done: true })
        }
      }
      return Promise.resolve({ scanned, truncated: false, done: true })
    },
  }
}

/**
 * An in-memory source. `children` are the outlines the source can answer by node id (a node with `hasChildren` and no entry answers with none; `root` is the
 * whole top level, `file.outline` when it has no entry);
 * `readings` by node id (a node without one rejects with `NoReading`); `text` is the file's lines, or null for a source without text.
 */
export function memoryDiagSource(
  file: DiagFile,
  children: Readonly<Record<string, DiagNode[]>>,
  text: readonly string[] | { count: number; at(line: number): string } | null,
  opts: { digest?: boolean; readings?: Readonly<Record<string, DiagReading>>; pageSize?: number } = {},
): DiagSource {
  const cap = opts.pageSize ?? OUTLINE_CAP
  return {
    file,
    text: text ? memoryText(text) : null,
    digest: !!opts.digest,
    outline: (node, after = 0) => {
      const all = node === ROOT ? (children[ROOT] ?? file.outline) : children[node]
      if (!all) return Promise.resolve({ node, children: [], more: 0 })
      const page = all.slice(after, after + cap)
      const more = Math.max(0, all.length - after - page.length)
      return Promise.resolve({ node, children: page, more, ...(more > 0 ? { next: after + page.length } : null) })
    },
    reading: (node) => {
      const r = opts.readings?.[node]
      return r ? Promise.resolve(r) : Promise.reject(new NoReading())
    },
  }
}
