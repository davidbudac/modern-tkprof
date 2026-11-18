// Where the dump reader's data comes from, in the apps: a source over the routes of a diag session (`api/diag/file`, `api/diag/outline`,
// `api/diag/reading`, and `api/lines` and `api/search` for the text: `serve`, and `/s/{id}/api/…` of the engine), or over the document's digest
// (the standalone report, any client without a server: the outline to a depth, no text). The rule that picks is `diagSourceOf`: a document that
// carries `dump.digest` is read from itself, else the routes are asked.
//
// A source lives as long as its tab: the view keeps what it opened in a WeakMap keyed by the source object, so `diagSourceOf` returns the same
// object for the same document.
import type { ApiClient } from './client'
import type { TraceDoc } from './doc'
import { NoReading, normalizeFile, normalizeOutline, ROOT, type DiagChildren, type DiagDigestNode, type DiagFile, type DiagOutline, type DiagReading, type DiagSource, type DiagText, type RawDump } from './diag'
import { fetchLinesAnnot, search } from './lines'

// ---- the digest source ------------------------------------------------------------------------------------------------------------

/** The error of a node that the standalone report does not hold the children of. */
const NOT_IN_REPORT = 'this report holds the outline to two levels only: the children of this part are not in it. Open the file with mtkprof serve or the desktop app.'

/**
 * A source over a document's digest: the top level and the children of each of its nodes, which is all the report holds. The children of any other
 * node, the readings and the text are not in it.
 */
export function digestDiagSource(dump: RawDump): DiagSource {
  const file = normalizeFile(dump.file)
  const pre = new Map<string, DiagChildren>()
  for (const n of dump.digest?.outline ?? []) {
    const d = n as DiagDigestNode
    // `more` is the children the report does not list: they cannot be asked for, so they are counted in `unlisted`
    pre.set(d.id, { node: d.id, children: d.children ?? [], more: 0, ...(d.more ? { unlisted: d.more } : null) })
  }
  return {
    file,
    text: null,
    digest: true,
    preloaded: pre,
    outline: (node, after = 0) => {
      if (node === ROOT) {
        const rest = file.outline.slice(after)
        return Promise.resolve({ node, children: rest, more: 0 })
      }
      const o = pre.get(node)
      return o ? Promise.resolve(o) : Promise.reject(new Error(NOT_IN_REPORT))
    },
    reading: () => Promise.reject(new NoReading('readings are not in a standalone report')),
  }
}

// ---- the HTTP source --------------------------------------------------------------------------------------------------------------

async function failure(what: string, res: Response): Promise<Error> {
  let msg = (await res.text().catch(() => '')).trim().slice(0, 300)
  try { const j = JSON.parse(msg) as { error?: { message?: string } }; if (j.error?.message) msg = j.error.message } catch { /* not the engine's envelope */ }
  return new Error(`${what}: ${res.status} ${res.statusText}${msg ? ': ' + msg : ''}`)
}

/** The text of a diag session: pages of `api/lines` of input file 0 and `api/search`. */
export function httpDiagText(client: ApiClient): DiagText {
  return {
    page: (from, n, signal) => fetchLinesAnnot(client, 0, from, n, signal),
    search: (q, onHit, signal) => search(client, { ...q, file: 0 }, onHit, signal),
  }
}

/** A source over the routes of a diag session. Every call asks the server: the view's outline store is the one place that keeps the answers. */
export function httpDiagSource(file: DiagFile, client: ApiClient): DiagSource {
  const json = async <T>(what: string, path: string): Promise<T> => {
    const res = await client.fetch(path, { headers: { accept: 'application/json' } })
    if (!res.ok) throw await failure(what, res)
    return (await res.json()) as T
  }
  return {
    file: normalizeFile(file),
    text: httpDiagText(client),
    digest: false,
    outline: async (node, after = 0) => {
      const q = `node=${encodeURIComponent(node)}${after > 0 ? `&after=${after}` : ''}`
      return normalizeOutline(await json<DiagOutline>(`outline of ${node}`, `/api/diag/outline?${q}`))
    },
    reading: async (node) => {
      const res = await client.fetch(`/api/diag/reading?node=${encodeURIComponent(node)}`, { headers: { accept: 'application/json' } })
      if (res.status === 404) throw new NoReading()
      if (!res.ok) throw await failure(`reading of ${node}`, res)
      return (await res.json()) as DiagReading
    },
  }
}

// ---- the pick ---------------------------------------------------------------------------------------------------------------------

/** The server a document came from, when that is not the session's client (`?doc=` on another server): fromRaw records it. */
const origin = new WeakMap<RawDump, ApiClient>()

/** Records the server `dump` was served by (load.ts, for a document that carries no digest). */
export function attachDiagClient(dump: RawDump, client: ApiClient): void {
  origin.set(dump, client)
}

const sources = new WeakMap<RawDump, DiagSource>()

/** The source of a diag document: its digest when it carries one, else the routes of `client` (or of the server the document came from). Cached per document. */
export function diagSourceOf(doc: TraceDoc & { dump: RawDump }, client: ApiClient): DiagSource {
  const d = doc.dump
  let s = sources.get(d)
  if (!s) {
    s = d.digest ? digestDiagSource(d) : httpDiagSource(d.file, origin.get(d) ?? client)
    sources.set(d, s)
  }
  return s
}
