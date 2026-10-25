// Notes on a trace: statements, executions, time windows and lines (bookmarks with a note). The
// store keeps them (`State.annotations`, `State.bookmarks`); a shell that persists them (the
// desktop app, per content identity) uses the file format and merge rules here.
import type { ID, Statement } from './types'
import type { Bookmark } from '../state/store'

export type AnnotationKind = 'statement' | 'execution' | 'window' | 'line'

/** A statement by what survives a re-parse: sql_id and a hash of kind and text (ids are positions). */
export interface StmtRef { sqlId: string; hash: string }

export interface Annotation {
  id: string
  kind: AnnotationKind
  note: string
  /** ms since the epoch */
  created: number
  updated: number
  /** statement, execution */
  stmt?: StmtRef
  /** execution: the execution number and the trace line of its cursor (which cursor of the statement) */
  execNo?: number
  cursorLine?: number
  /** window: tim (µs) */
  from?: number
  to?: number
  /** window: a short title; line: the bookmark's label */
  label?: string
  /** line */
  file?: number
  line?: number
}

/** What resolving an annotation against a document needs (a TraceDoc has all of it). */
export interface AnnotDoc {
  statements: Statement[]
  cursors: { id: ID; statement: ID; line: number }[]
}

/** FNV-1a 32 of a string, 8 hex digits. */
export function textHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export const stmtRef = (st: Statement): StmtRef => ({ sqlId: st.sqlId, hash: textHash(`${st.kind}\n${st.text}`) })

/** The statement `ref` names: same sql_id and text; else the only statement with that sql_id; else null. */
export function resolveStmt(doc: Pick<AnnotDoc, 'statements'>, ref: StmtRef): ID | null {
  let bySql: ID | null = null, n = 0
  for (const st of doc.statements) {
    if (st.sqlId !== ref.sqlId) continue
    if (stmtRef(st).hash === ref.hash) return st.id
    bySql = st.id
    n++
  }
  return ref.sqlId && n === 1 ? bySql : null
}

/** An execution annotation's statement and cursor in `doc`, else null. */
export function resolveExec(doc: AnnotDoc, a: Annotation): { stmt: ID; cursor: ID; execNo: number } | null {
  if (!a.stmt || a.execNo === undefined) return null
  const stmt = resolveStmt(doc, a.stmt)
  if (stmt === null) return null
  const cursors = doc.statements[stmt].cursors
  const cursor = cursors.find((c) => doc.cursors[c]?.line === a.cursorLine) ?? cursors[0]
  return cursor === undefined ? null : { stmt, cursor, execNo: a.execNo }
}

const sameRef = (a: StmtRef | undefined, b: StmtRef) => !!a && a.sqlId === b.sqlId && a.hash === b.hash

/** The note on a statement (not its executions). */
export const stmtNote = (list: Annotation[], ref: StmtRef) => list.find((a) => a.kind === 'statement' && sameRef(a.stmt, ref))

/** The notes on a statement's executions, by execution number. */
export function execNotes(list: Annotation[], ref: StmtRef): Map<number, Annotation> {
  const m = new Map<number, Annotation>()
  for (const a of list) if (a.kind === 'execution' && a.execNo !== undefined && sameRef(a.stmt, ref)) m.set(a.execNo, a)
  return m
}

let seq = 0
export const newAnnotationId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** A new annotation with a fresh id and both times now. */
export function makeAnnotation(a: Omit<Annotation, 'id' | 'created' | 'updated'>, now = Date.now()): Annotation {
  return { ...a, id: newAnnotationId(), created: now, updated: now }
}

// ---- bookmarks as line annotations ------------------------------------------------------------

const lineId = (file: number, line: number) => `line:${file}:${line}`

export function bookmarkToAnnotation(b: Bookmark): Annotation {
  const t = b.updated ?? 0
  return { id: lineId(b.file, b.line), kind: 'line', note: b.note ?? '', created: t, updated: t, label: b.label, file: b.file, line: b.line }
}

export function annotationToBookmark(a: Annotation): Bookmark | null {
  if (a.kind !== 'line' || a.file === undefined || a.line === undefined) return null
  const b: Bookmark = { file: a.file, line: a.line, label: a.label ?? '' }
  if (a.note) b.note = a.note
  if (a.updated) b.updated = a.updated
  return b
}

// ---- merge (import): by id, the newer one wins --------------------------------------------------

export function mergeAnnotations(cur: Annotation[], incoming: Annotation[]): Annotation[] {
  const byId = new Map(cur.map((a) => [a.id, a]))
  for (const a of incoming) {
    const old = byId.get(a.id)
    if (!old || a.updated > old.updated) byId.set(a.id, a)
  }
  return [...byId.values()].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
}

export function mergeBookmarks(cur: Bookmark[], incoming: Bookmark[]): Bookmark[] {
  const key = (b: Bookmark) => lineId(b.file, b.line)
  const m = new Map(cur.map((b) => [key(b), b]))
  for (const b of incoming) {
    const old = m.get(key(b))
    if (!old || (b.updated ?? 0) > (old.updated ?? 0)) m.set(key(b), b)
  }
  return [...m.values()].sort((a, b) => a.file - b.file || a.line - b.line)
}

// ---- file format --------------------------------------------------------------------------------

/** `{version: 1, identity, trace, annotations}`: statement, execution and window notes and the bookmarks (kind `line`). */
export interface AnnotationsFile {
  version: 1
  identity: string
  trace: string
  exported?: string
  annotations: Annotation[]
}

export function annotationsFile(identity: string, trace: string, annotations: Annotation[], bookmarks: Bookmark[], now = new Date()): AnnotationsFile {
  return { version: 1, identity, trace, exported: now.toISOString(), annotations: [...annotations, ...bookmarks.map(bookmarkToAnnotation)] }
}

const KINDS: AnnotationKind[] = ['statement', 'execution', 'window', 'line']

function validAnnotation(x: unknown): x is Annotation {
  if (!x || typeof x !== 'object') return false
  const a = x as Annotation
  if (typeof a.id !== 'string' || !a.id || !KINDS.includes(a.kind) || typeof a.note !== 'string') return false
  if (typeof a.created !== 'number' || typeof a.updated !== 'number') return false
  switch (a.kind) {
    case 'statement': return !!a.stmt && typeof a.stmt.sqlId === 'string' && typeof a.stmt.hash === 'string'
    case 'execution': return !!a.stmt && typeof a.stmt.hash === 'string' && typeof a.execNo === 'number'
    case 'window': return typeof a.from === 'number' && typeof a.to === 'number' && a.to >= a.from
    case 'line': return typeof a.file === 'number' && typeof a.line === 'number'
  }
}

/** Reads an exported file: the notes and the bookmarks apart; entries that do not parse are counted in `skipped`. */
export function parseAnnotationsFile(text: string): { identity: string; trace: string; annotations: Annotation[]; bookmarks: Bookmark[]; skipped: number } {
  let f: AnnotationsFile
  try { f = JSON.parse(text) as AnnotationsFile } catch (e) { throw new Error(`not JSON: ${e instanceof Error ? e.message : String(e)}`) }
  if (!f || typeof f !== 'object' || !Array.isArray(f.annotations)) throw new Error('not an annotations file (no "annotations" list)')
  if (f.version !== 1) throw new Error(`annotations file version ${String(f.version)} (this app reads 1)`)
  const annotations: Annotation[] = [], bookmarks: Bookmark[] = []
  let skipped = 0
  for (const a of f.annotations) {
    if (!validAnnotation(a)) { skipped++; continue }
    if (a.kind === 'line') bookmarks.push(annotationToBookmark(a)!)
    else annotations.push(a)
  }
  return { identity: typeof f.identity === 'string' ? f.identity : '', trace: typeof f.trace === 'string' ? f.trace : '', annotations, bookmarks, skipped }
}

// ---- Markdown --------------------------------------------------------------------------------------

export interface MarkdownOptions {
  /** a statement's one-line description (sql_id and text preview), when the document is at hand */
  stmtLabel?: (ref: StmtRef) => string
  /** a tim as wall clock or offset */
  time?: (tim: number) => string
  /** an input file's name */
  fileName?: (file: number) => string
}

const iso = (ms: number) => (ms ? new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z') : '')
const quote = (s: string) => s.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')

/** The notes grouped by kind, with the trace name, identity and times. */
export function annotationsMarkdown(f: AnnotationsFile, o: MarkdownOptions = {}): string {
  const out: string[] = [`# Notes: ${f.trace || 'trace'}`, '', `- identity: \`${f.identity}\``]
  if (f.exported) out.push(`- exported: ${f.exported.replace(/\.\d+Z$/, 'Z')}`)
  const stmt = (r?: StmtRef) => (r ? (o.stmtLabel?.(r) ?? `\`${r.sqlId || r.hash}\``) : '?')
  const time = (t?: number) => (t === undefined ? '?' : o.time?.(t) ?? String(t))
  const groups: [AnnotationKind, string][] = [['statement', 'Statements'], ['execution', 'Executions'], ['window', 'Time windows'], ['line', 'Lines']]
  for (const [kind, title] of groups) {
    const list = f.annotations.filter((a) => a.kind === kind)
    if (list.length === 0) continue
    if (kind === 'line') list.sort((a, b) => (a.file ?? 0) - (b.file ?? 0) || (a.line ?? 0) - (b.line ?? 0))
    else if (kind === 'window') list.sort((a, b) => (a.from ?? 0) - (b.from ?? 0))
    out.push('', `## ${title}`)
    for (const a of list) {
      let head: string
      switch (a.kind) {
        case 'statement': head = stmt(a.stmt); break
        case 'execution': head = `${stmt(a.stmt)} execution #${a.execNo}`; break
        case 'window': head = `${a.label ? `**${a.label}** ` : ''}${time(a.from)} → ${time(a.to)}`; break
        default: head = `${o.fileName ? `${o.fileName(a.file ?? 0)} ` : ''}line ${a.line}${a.label ? `: \`${a.label.replace(/`/g, "'")}\`` : ''}`
      }
      const when = a.updated ? ` _(${iso(a.updated)})_` : ''
      out.push('', `### ${head}${when}`)
      if (a.note) out.push('', quote(a.note))
    }
  }
  return out.join('\n') + '\n'
}
