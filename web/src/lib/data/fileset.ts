// The input files of a trace set and the selection of them: which session contexts a file selection
// lets through, how PX slave files nest under their coordinator, and the panel's click rules.
import type { Context, ContextStats, FileEntry, ID } from './types'

/** What the helpers read of a document (a `TraceDoc` fits). */
export interface FileSetDoc {
  contexts: readonly Pick<Context, 'fileIdx' | 'px' | 'parent'>[]
  file: { files?: readonly FileEntry[] }
}

export const fileCount = (doc: Pick<FileSetDoc, 'file'> | null): number => doc?.file.files?.length ?? 1

/** A file selection in canonical form: null (= all) when every file is selected, else the set. */
export function normalizeFiles(doc: Pick<FileSetDoc, 'file'> | null, files: ReadonlySet<number> | null): Set<number> | null {
  if (!doc || !files) return null
  const n = fileCount(doc)
  const out = new Set<number>()
  for (const f of files) if (f >= 0 && f < n) out.add(f)
  return out.size === n ? null : out
}

/** The contexts that ran in the given files. */
export function contextsOfFiles(doc: FileSetDoc, files: ReadonlySet<number>): Set<ID> {
  const out = new Set<ID>()
  doc.contexts.forEach((c, i) => { if (files.has(c.fileIdx ?? 0)) out.add(i) })
  return out
}

/**
 * The context filter the views apply: the explicit context selection restricted to the selected files, or all contexts of the
 * selected files, or the explicit selection alone; null = no filter. An empty set (no files selected) lets nothing through.
 */
export function effectiveContexts(doc: FileSetDoc | null, files: ReadonlySet<number> | null, contexts: ReadonlySet<ID> | null): Set<ID> | null {
  if (!doc || !files) return contexts ? new Set(contexts) : null
  const inFiles = contextsOfFiles(doc, files)
  if (!contexts) return inFiles
  const out = new Set<ID>()
  for (const c of contexts) if (inFiles.has(c)) out.add(c)
  return out
}

/** The explicit context selection without the contexts outside `files` (null when nothing is left). */
export function contextsWithin(doc: FileSetDoc | null, contexts: ReadonlySet<ID> | null, files: ReadonlySet<number> | null): Set<ID> | null {
  if (!doc || !contexts) return contexts ? new Set(contexts) : null
  if (!files) return new Set(contexts)
  const out = new Set<ID>()
  for (const c of contexts) if (files.has(doc.contexts[c]?.fileIdx ?? 0)) out.add(c)
  return out.size ? out : null
}

/** A file of the panel: its place in the list, and the coordinator file it is nested under (PX slaves). */
export interface FileNode { idx: number; depth: number; parent: number | null }

/**
 * The panel's file order: files in input order, each PX slave file listed right under the coordinator file its contexts are
 * attached to (`Context.parent`). A slave file whose contexts attach to several coordinator files goes under the one most of its
 * contexts attach to; a slave file with no coordinator in the set stays on top level.
 */
export function fileTree(doc: FileSetDoc): FileNode[] {
  const n = fileCount(doc)
  const votes: Map<number, number>[] = Array.from({ length: n }, () => new Map())
  doc.contexts.forEach((c) => {
    const f = c.fileIdx ?? 0
    if (!c.px || c.parent == null || c.parent < 0 || f >= n) return
    const pf = doc.contexts[c.parent]?.fileIdx ?? 0
    if (pf === f || pf >= n) return
    votes[f].set(pf, (votes[f].get(pf) ?? 0) + 1)
  })
  const parentOf = (f: number): number | null => {
    let best: number | null = null, bestN = 0
    for (const [pf, k] of votes[f]) if (k > bestN || (k === bestN && best !== null && pf < best)) { best = pf; bestN = k }
    return best
  }
  const parent: (number | null)[] = Array.from({ length: n }, (_, f) => parentOf(f))
  // a cycle (cannot happen with attachPX, which only attaches to non-PX contexts) must not hide files
  for (let f = 0; f < n; f++) {
    const seen = new Set<number>([f])
    for (let p = parent[f]; p !== null; p = parent[p]) {
      if (seen.has(p)) { parent[f] = null; break }
      seen.add(p)
    }
  }
  const kids = new Map<number, number[]>()
  parent.forEach((p, f) => { if (p !== null) kids.set(p, [...(kids.get(p) ?? []), f]) })
  const out: FileNode[] = []
  const add = (f: number, depth: number) => {
    out.push({ idx: f, depth, parent: parent[f] })
    for (const k of kids.get(f) ?? []) add(k, depth + 1)
  }
  for (let f = 0; f < n; f++) if (parent[f] === null) add(f, 0)
  return out
}

/** How many of the files are selected (null = all). */
export const selectedCount = (doc: Pick<FileSetDoc, 'file'>, files: ReadonlySet<number> | null): number => (files ? files.size : fileCount(doc))

export function isSelected(files: ReadonlySet<number> | null, f: number): boolean { return files === null || files.has(f) }

/** The files as the Set the store keeps: selected files of `files` (null = all). */
export function selectedSet(doc: Pick<FileSetDoc, 'file'>, files: ReadonlySet<number> | null): Set<number> {
  return files ? new Set(files) : new Set(Array.from({ length: fileCount(doc) }, (_, i) => i))
}

export function invert(doc: Pick<FileSetDoc, 'file'>, files: ReadonlySet<number> | null): Set<number> {
  const out = new Set<number>()
  for (let f = 0; f < fileCount(doc); f++) if (!isSelected(files, f)) out.add(f)
  return out
}

export interface ClickMods { toggle: boolean; range: boolean }

/**
 * A click on the name of file `idx`: plain = only that file; ⌘/Ctrl = toggle it; Shift = the files between the last click
 * (`anchor`, in `order`, the panel's row order) and this one added to the selection. Returns the new selection (before normalising).
 */
export function clickFile(doc: Pick<FileSetDoc, 'file'>, files: ReadonlySet<number> | null, order: readonly number[], idx: number, anchor: number | null, mods: ClickMods): Set<number> {
  if (mods.range && anchor !== null && anchor !== idx) {
    const a = order.indexOf(anchor), b = order.indexOf(idx)
    if (a >= 0 && b >= 0) {
      const out = selectedSet(doc, files)
      for (let k = Math.min(a, b); k <= Math.max(a, b); k++) out.add(order[k])
      return out
    }
  }
  if (mods.toggle) return toggleFile(doc, files, idx)
  return new Set([idx])
}

export function toggleFile(doc: Pick<FileSetDoc, 'file'>, files: ReadonlySet<number> | null, idx: number): Set<number> {
  const out = selectedSet(doc, files)
  if (out.has(idx)) out.delete(idx); else out.add(idx)
  return out
}

/** `files=0,2` of the URL hash (empty for all files); the inverse of `parseFilesParam`. */
export function formatFilesParam(files: ReadonlySet<number> | null): string {
  return files ? [...files].sort((a, b) => a - b).join(',') : ''
}

/** `0,2` -> {0, 2}; ranges `1-3` are accepted; null when the text has no valid index. */
export function parseFilesParam(text: string | null): Set<number> | null {
  if (!text) return null
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!m) continue
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2])
    if (b < a || b - a > 100000) continue
    for (let f = a; f <= b; f++) out.add(f)
  }
  return out.size ? out : null
}

/** The microseconds the Overview calls its response time: the time window, else the span of the selected files (all files = the trace's span). */
export function scopeSpanUs(doc: Pick<FileSetDoc, 'file'> & { spanUs(): number }, window: { startTim: number; endTim: number } | null, files: ReadonlySet<number> | null): number {
  if (window) return window.endTim - window.startTim
  if (!files) return doc.spanUs()
  let lo = Infinity, hi = -Infinity
  doc.file.files?.forEach((f, i) => {
    if (!files.has(i) || !(f.firstTim > 0) || !(f.lastTim >= f.firstTim)) return
    lo = Math.min(lo, f.firstTim); hi = Math.max(hi, f.lastTim)
  })
  return hi > lo ? hi - lo : doc.spanUs()
}

/** What `selectionSpan` reads of a document (a `TraceDoc` fits). */
export interface SpanDoc extends FileSetDoc {
  span: { firstTim: number; lastTim: number }
  stats: { contexts: readonly Pick<ContextStats, 'context' | 'firstTim' | 'lastTim'>[] }
}

/**
 * The time range the lanes and the timeline chart span: from the first `tim` to the last one of the selection, so a short
 * file is not squeezed against one edge of the whole set's axis. An explicit session selection (`contexts`, restricted to the
 * selected `files`) gives the range of those contexts' calls and waits; a file selection alone gives the range of the selected
 * files (`FileEntry`); no selection, or one without times, is the whole trace. PX slaves have a file and contexts of their own:
 * the slave file alone is the slave's range, the coordinator file with it the union.
 */
export function selectionSpan(doc: SpanDoc, files: ReadonlySet<number> | null, contexts: ReadonlySet<ID> | null): { firstTim: number; lastTim: number } {
  const whole = { firstTim: doc.span.firstTim, lastTim: doc.span.lastTim }
  let lo = Infinity, hi = -Infinity
  const take = (a: number, b: number) => { if (a > 0 && b >= a) { lo = Math.min(lo, a); hi = Math.max(hi, b) } }
  if (contexts) {
    const ids = effectiveContexts(doc, files, contexts)!
    for (const c of doc.stats.contexts) if (ids.has(c.context)) take(c.firstTim, c.lastTim)
  }
  if (!(hi > lo) && files) doc.file.files?.forEach((f, i) => { if (files.has(i)) take(f.firstTim, f.lastTim) })
  if (!(hi > lo)) return whole
  // never outside the trace (a context can run past the last timed line)
  return { firstTim: Math.max(lo, whole.firstTim), lastTim: Math.min(hi, whole.lastTim) }
}

/** The context filter as a cache key; an empty set (no file selected) differs from no filter. */
export function ctxKey(contexts: ReadonlySet<ID> | null): string {
  if (!contexts) return ''
  if (contexts.size === 0) return 'none'
  return [...contexts].sort((a, b) => a - b).join(',')
}
