import type { TraceDoc } from './doc'
import { fmtDur, preview } from './format'
import type { ID, StmtStats } from './types'

/** What the outline reads of the document (a `TraceDoc` fits). */
export type OutlineDoc = Pick<TraceDoc, 'contexts' | 'cursors' | 'statements' | 'fileOfCtx' | 'fileOfCursor' | 'label'> & { stats: { statements: readonly Pick<StmtStats, 'elapsed'>[] } }

/** A cursor parsed in the file; `children` are the recursive cursors (greater depth) that follow it, `descendants` counts them all. */
export interface OutlineCursor {
  key: string; id: ID; number: number; depth: number; stmt: ID; line: number
  sqlId: string; text: string; execs: number; elapsed: number
  children: OutlineCursor[]; descendants: number
}
/** A session marker (or the synthetic "file start" for cursors before the first one, `ctx` -1) and the cursors parsed under it. */
export interface OutlineCtx { key: string; ctx: ID; line: number; label: string; cursors: OutlineCursor[] }

/** The text of a session marker: "session <id> · <module> · <action>", empty parts left out. */
function ctxLabel(c: { id: ID; sessionId: string; module: string; action: string }): string {
  return [c.sessionId && `session ${c.sessionId}`, c.module, c.action].filter(Boolean).join(' · ') || `context ${c.id}`
}

/**
 * The outline of input file `file`: its session markers by line, each with the cursors parsed under it (the last marker at or before
 * the cursor's line; cursors before the first marker go under "file start"). A cursor of greater depth than the one before it is nested
 * under its parent, the nearest previous cursor of lower depth (within the same marker).
 */
export function outlineOf(doc: OutlineDoc, file: number): OutlineCtx[] {
  const ctxs = doc.contexts.filter((c) => c.line > 0 && doc.fileOfCtx(c.id) === file).sort((a, b) => a.line - b.line || a.id - b.id)
  const cursors = doc.cursors.filter((c) => c.line > 0 && doc.fileOfCursor(c.id) === file).sort((a, b) => a.line - b.line || a.id - b.id)
  const groups: OutlineCtx[] = ctxs.map((c) => ({ key: `x${c.id}`, ctx: c.id, line: c.line, label: ctxLabel(c), cursors: [] }))
  let start: OutlineCtx | undefined
  let gi = -1 // the last marker at or before the cursor
  let stack: OutlineCursor[] = []
  let cur: OutlineCtx | undefined
  for (const c of cursors) {
    while (gi + 1 < groups.length && groups[gi + 1].line <= c.line) gi++
    const g = gi >= 0 ? groups[gi] : (start ??= { key: 'x-1', ctx: -1, line: 1, label: 'file start', cursors: [] })
    if (g !== cur) { cur = g; stack = [] }
    const st = doc.statements[c.statement]
    const node: OutlineCursor = {
      key: `c${c.id}`, id: c.id, number: c.number, depth: c.depth, stmt: c.statement, line: c.line,
      sqlId: st ? doc.label(st) : '', text: st ? preview(st.text, 60) : '', execs: c.execs, elapsed: doc.stats.statements[c.statement]?.elapsed ?? 0,
      children: [], descendants: 0,
    }
    while (stack.length > 0 && stack[stack.length - 1].depth >= c.depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) { parent.children.push(node); for (const p of stack) p.descendants++ } else g.cursors.push(node)
    stack.push(node)
  }
  return start ? [start, ...groups] : groups
}

/** A predicate for the filter box: the cursor's sql_id or statement text contains `q` (case-insensitive); null for an empty filter. */
export function cursorMatcher(doc: Pick<OutlineDoc, 'statements'>, q: string): ((c: OutlineCursor) => boolean) | null {
  const needle = q.trim().toLowerCase()
  if (needle === '') return null
  return (c) => c.sqlId.toLowerCase().includes(needle) || (doc.statements[c.stmt]?.text ?? '').toLowerCase().includes(needle)
}

/** The executions of a cursor as the tree shows them (fetched when its node opens). */
export type ExecInfo = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; partial: boolean; rows: { execNo: number; e: number; line: number }[] }

/** One visible row of the flattened outline; `depth` indents it. */
export type OutlineRow =
  | { type: 'ctx'; key: string; depth: number; line: number; text: string }
  | { type: 'cursor'; key: string; depth: number; line: number; node: OutlineCursor; open: boolean; expandable: boolean }
  /** the collapsed summary "▸ N recursive cursors"; `of` is the key of the cursor that opens */
  | { type: 'more'; key: string; depth: number; line: number; of: string; n: number }
  | { type: 'exec'; key: string; depth: number; line: number; text: string }
  | { type: 'note'; key: string; depth: number; line: number; text: string }

/**
 * The visible rows: markers, their cursors (recursive ones under an open parent, or a summary line while it is closed) and, under an open
 * cursor, its executions. With a filter the matching cursors are listed flat in file order under the markers that have any.
 */
export function rowsOf(tree: readonly OutlineCtx[], open: ReadonlySet<string>, match: ((c: OutlineCursor) => boolean) | null, execsOf: (c: OutlineCursor) => ExecInfo | undefined): OutlineRow[] {
  const rows: OutlineRow[] = []
  const cursorRows = (c: OutlineCursor, depth: number, nest: boolean) => {
    const isOpen = open.has(c.key)
    rows.push({ type: 'cursor', key: c.key, depth, line: c.line, node: c, open: isOpen, expandable: c.execs > 0 || (nest && c.children.length > 0) })
    if (isOpen) {
      const info = execsOf(c)
      if (!info || info.status === 'loading') rows.push({ type: 'note', key: `${c.key}:note`, depth: depth + 1, line: c.line, text: 'loading executions…' })
      else if (info.status === 'error') rows.push({ type: 'note', key: `${c.key}:note`, depth: depth + 1, line: c.line, text: `could not load the executions: ${info.message}` })
      else {
        if (info.rows.length === 0) rows.push({ type: 'note', key: `${c.key}:note`, depth: depth + 1, line: c.line, text: 'no execution of this cursor listed' })
        for (const r of info.rows) rows.push({ type: 'exec', key: `${c.key}:e${r.execNo}`, depth: depth + 1, line: r.line, text: `exec #${r.execNo} · ${fmtDur(r.e)} · line ${r.line}` })
        if (info.partial) rows.push({ type: 'note', key: `${c.key}:partial`, depth: depth + 1, line: c.line, text: 'the statement has more executions than listed (the slowest are shown)' })
      }
    } else if (nest && c.children.length > 0) {
      rows.push({ type: 'more', key: `${c.key}:more`, depth: depth + 1, line: c.line, of: c.key, n: c.descendants })
    }
    if (isOpen && nest) for (const k of c.children) cursorRows(k, depth + 1, true)
  }
  const flat = (cs: readonly OutlineCursor[], out: OutlineCursor[]) => { for (const c of cs) { out.push(c); flat(c.children, out) } }
  for (const g of tree) {
    rows.push({ type: 'ctx', key: g.key, depth: 0, line: g.line, text: g.label })
    if (!match) { for (const c of g.cursors) cursorRows(c, 1, true); continue }
    const all: OutlineCursor[] = []
    flat(g.cursors, all)
    const hits = all.filter(match)
    if (hits.length === 0) rows.pop()
    for (const c of hits) cursorRows(c, 1, false)
  }
  return rows
}

/**
 * The row that holds `line`: the last marker or cursor row at or before it (their lines ascend in file order), or -1; an execution row
 * of exactly that line right after it wins.
 */
export function rowAt(rows: readonly OutlineRow[], line: number): number {
  const nodes: number[] = [] // indexes of the marker / cursor rows
  for (let i = 0; i < rows.length; i++) if (rows[i].type === 'ctx' || rows[i].type === 'cursor') nodes.push(i)
  let lo = 0, hi = nodes.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[nodes[mid]].line > line) hi = mid; else lo = mid + 1 }
  if (lo === 0) return -1
  const at = nodes[lo - 1]
  for (let i = at + 1; i < rows.length && rows[i].type !== 'ctx' && rows[i].type !== 'cursor'; i++) if (rows[i].type === 'exec' && rows[i].line === line) return i
  return at
}
