// Object names from a script the user runs and pastes back (docs/REF-BUNDLE.md § Paste): the engine session's routes
// `GET api/ref` (what the trace refers to and how much of it is named), `GET api/ref/script` (the names script) and
// `POST api/ref/paste` (its output; a ref job merges it into the trace's bundle and applies it, the session's rev rises
// and the host reloads the document). The Import names dialog (views/RefImport.tsx) works on a `RefImporter`.
import type { ApiClient } from './client'

/** A refused call: `status` 404 = the server has no ref routes. */
export class RefError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/** Ids of each kind: obj#, file#, user ids, sql_ids (report.RefCounts). */
export interface RefCounts { objects: number; files: number; users: number; plans: number }

/** The part of a ref job the dialog shows (JobInfo). */
export interface RefJob { id: string; state: 'running' | 'done' | 'failed' | 'cancelled'; message: string }

export interface RefStatus {
  /** what the trace refers to (sql_ids with text) */
  wanted: RefCounts
  /** of those, what the applied bundle names */
  named: RefCounts
  /** a bundle is kept for the trace */
  stored: boolean
  rev: number
  /** the session's latest ref job */
  job?: RefJob
}

export interface RefScriptInfo { script: string; name: string; plans: boolean; wanted: RefCounts }

export interface RefPasted { job: RefJob; read: RefCounts; notes: string[]; complete: boolean }

/** Where pasted names go: the engine session behind a document. */
export interface RefImporter {
  /** throws a `RefError` with status 404 when the server has no such routes (an older engine, `mtkprof serve`) */
  status(signal?: AbortSignal): Promise<RefStatus>
  script(plans: boolean, signal?: AbortSignal): Promise<RefScriptInfo>
  paste(text: string): Promise<RefPasted>
}

/** The error message of an engine answer: the envelope's `error.message`, else the body. */
async function failure(res: Response, what: string): Promise<RefError> {
  const body = (await res.text()).trim()
  let msg = body
  try { msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body } catch { /* not JSON */ }
  return new RefError(msg || `${what}: ${res.statusText}`, res.status)
}

/** The ref routes of the session at `client` (its root, e.g. `…/s/1`). */
export function engineRefImporter(client: ApiClient): RefImporter {
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await client.fetch(path, { ...init, headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) } })
    if (!res.ok) throw await failure(res, path)
    return (await res.json()) as T
  }
  return {
    status: (signal) => json<RefStatus>('/api/ref', { signal }),
    script: (plans, signal) => json<RefScriptInfo>(`/api/ref/script${plans ? '?plans=true' : ''}`, { signal }),
    paste: (text) => json<RefPasted>('/api/ref/paste', { method: 'POST', body: JSON.stringify({ text }) }),
  }
}

/** What a paste holds, counted in the browser before it is sent (the engine reads it for real: internal/ref/paste.go). */
export interface PastePreview {
  objects: number
  files: number
  users: number
  /** sql_ids with a plan (their lines hold a "Plan hash value"; a message such as "User has no SELECT privilege" is none) */
  plans: number
  notes: string[]
  /** the first and the last line of the script's output */
  header: boolean
  end: boolean
  /** no tagged line, but a header row of a table (OBJECT_ID …): the engine reads it as tables */
  tables: boolean
}

export const PASTE_HEADER = 'mtkprof-ref 1'
export const PASTE_END = 'mtkprof-ref end'

const TAG = /^(obj|file|user|plan|note),(.*)$/
const TABLE_HEADER = /\b(OBJECT_ID|USER_ID|ABS_FILE#|FILE#)\b/i

/** The first CSV field of `s` (quoted or not). */
function firstField(s: string): string {
  if (!s.startsWith('"')) return s.split(',')[0].trim()
  let out = ''
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '"') {
      if (s[i + 1] === '"') { out += '"'; i++ } else break
    } else out += s[i]
  }
  return out
}

/** Counts the tagged lines of a paste (one entry per id, as the engine keeps them). */
export function previewPaste(text: string): PastePreview {
  const ids = { obj: new Set<string>(), file: new Set<string>(), user: new Set<string>(), plan: new Set<string>() }
  const notes: string[] = []
  let header = false, end = false, tagged = false, tableHeader = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === PASTE_HEADER) { header = true; continue }
    if (line === PASTE_END) { end = true; continue }
    const m = TAG.exec(line)
    if (!m) {
      if (!tableHeader && TABLE_HEADER.test(line) && /[,\t;]/.test(line)) tableHeader = true
      continue
    }
    tagged = true
    const [, tag, rest] = m
    if (tag === 'note') { const n = firstField(rest); if (n) notes.push(n); continue }
    if (tag === 'file') { const f = rest.match(/,(\d+)\s*$/); ids.file.add(f ? f[1] : firstField(rest)); continue }
    if (tag === 'plan') { if (rest.includes('Plan hash value')) ids.plan.add(firstField(rest)); continue }
    ids[tag as 'obj' | 'user'].add(firstField(rest))
  }
  return { objects: ids.obj.size, files: ids.file.size, users: ids.user.size, plans: ids.plan.size, notes, header, end, tables: !tagged && tableHeader }
}
