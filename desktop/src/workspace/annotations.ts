import { mergeAnnotations, mergeBookmarks, type Annotation, type Bookmark } from '@lib'
import { openKV } from '../platform'

/**
 * Notes on a trace, per content identity (`SessionInfo.identity`: the files without options, so
 * the same trace opened with other bind options shares them), in `annotations.json`:
 * `{"<identity>": {bookmarks: [...], notes: [...]}}`: the bookmarks (lines, with an optional note)
 * and the notes on statements, executions and time windows (`State.annotations` of the lib).
 */
export interface TraceAnnotations {
  bookmarks?: Bookmark[]
  notes?: Annotation[]
  [kind: string]: unknown
}

const FILE = 'annotations.json'

export async function loadAnnotations(identity: string): Promise<TraceAnnotations> {
  if (!identity) return {}
  return (await (await openKV(FILE)).get<TraceAnnotations>(identity)) ?? {}
}

let queue: Promise<unknown> = Promise.resolve()

/** Replaces one kind of a trace's annotations; an empty trace entry is removed. Saves run one at a time (each reads and rewrites the trace's entry). */
export function saveAnnotation<K extends keyof TraceAnnotations>(identity: string, kind: K, value: TraceAnnotations[K]): Promise<void> {
  const p = queue.then(() => writeAnnotation(identity, kind, value))
  queue = p.catch(() => {})
  return p
}

async function writeAnnotation<K extends keyof TraceAnnotations>(identity: string, kind: K, value: TraceAnnotations[K]) {
  if (!identity) return
  const kv = await openKV(FILE)
  const cur = (await kv.get<TraceAnnotations>(identity)) ?? {}
  const next: TraceAnnotations = { ...cur, [kind]: value }
  if (Array.isArray(value) && value.length === 0) delete next[kind]
  if (Object.keys(next).length === 0) await kv.delete(identity)
  else await kv.set(identity, next)
}

export async function loadBookmarks(identity: string): Promise<Bookmark[]> {
  const b = (await loadAnnotations(identity)).bookmarks
  return Array.isArray(b) ? b : []
}

export const saveBookmarks = (identity: string, bookmarks: Bookmark[]) => saveAnnotation(identity, 'bookmarks', bookmarks)

export async function loadNotes(identity: string): Promise<Annotation[]> {
  const n = (await loadAnnotations(identity)).notes
  return Array.isArray(n) ? n : []
}

export const saveNotes = (identity: string, notes: Annotation[]) => saveAnnotation(identity, 'notes', notes)

/** Wait for outstanding edits before taking a consistent metadata snapshot. */
export async function exportAnnotations(): Promise<Record<string, TraceAnnotations>> {
  await queue
  const kv = await openKV(FILE)
  const out: Record<string, TraceAnnotations> = Object.create(null)
  for (const key of await kv.keys()) out[key] = (await kv.get<TraceAnnotations>(key)) ?? {}
  return out
}

/** Merge on the same queue as edits; unrelated trace entries and annotation kinds survive. */
export function importAnnotations(incoming: Record<string, TraceAnnotations>): Promise<void> {
  const p = queue.then(async () => {
    const kv = await openKV(FILE)
    for (const [identity, entry] of Object.entries(incoming)) {
      const cur = (await kv.get<TraceAnnotations>(identity)) ?? {}
      await kv.set(identity, { ...cur, notes: mergeAnnotations(cur.notes ?? [], entry.notes ?? []), bookmarks: mergeBookmarks(cur.bookmarks ?? [], entry.bookmarks ?? []) })
    }
  })
  queue = p.catch(() => {})
  return p
}
