import type { RawDocument, RawCompareDocument, Comparison } from './types'
import { TraceDoc } from './doc'
import { attachRemote } from './source'
import { createClient, type ApiClient } from './client'

export type Source = { kind: 'inline' } | { kind: 'url'; url: string } | { kind: 'file'; file: File }

/** Both traces of a comparison document, and the diff computed by Go. */
export interface CompareData { a: TraceDoc; b: TraceDoc; diff: Comparison }
export interface Loaded {
  doc: TraceDoc
  compare: CompareData | null
  /** a live session's document (`loadInitial` from a server): its revision (`X-Rev`) and the session's state (`X-Live`) */
  rev?: number
  live?: string
  /** the server the document came from (`loadInitial`) */
  client?: ApiClient
}

/**
 * A plain document, or a compare document (`{compare: {a, b, diff}}`: side A is shown first).
 * `client` is the server the document came from: a document without facts that the server
 * flagged `slice` gets its fact-level answers from there.
 */
export async function fromRaw(raw: RawDocument | RawCompareDocument, client?: ApiClient): Promise<Loaded> {
  if ('compare' in raw && raw.compare) {
    const [a, b] = await Promise.all([TraceDoc.fromRaw(raw.compare.a), TraceDoc.fromRaw(raw.compare.b)])
    return { doc: a, compare: { a, b, diff: raw.compare.diff } }
  }
  const doc = await TraceDoc.fromRaw(raw as RawDocument)
  if (client && doc.slice && !doc.hasFacts) attachRemote(doc, client)
  return { doc, compare: null }
}

/** The server root behind a `?doc=` URL that ends in `/api/<name>`; null for any other URL. */
function clientOfDocUrl(url: string): ApiClient | null {
  const u = new URL(url, location.href)
  const m = /^(.*)\/api\/[^/]*$/.exec(u.pathname)
  return m ? createClient(u.origin + m[1]) : null
}

/** How long `loadInitial` waits for a live session's first snapshot (the server answers 409 until then). */
const FIRST_SNAPSHOT_WAIT_MS = 60_000

/** Finds the document: inline <script id="mtkprof-data">, else ?doc= URL, else `client`'s /api/doc. */
export async function loadInitial(client: ApiClient): Promise<Loaded | null> {
  const inline = document.getElementById('mtkprof-data')
  if (inline?.textContent) {
    const raw = JSON.parse(inline.textContent) as RawDocument | RawCompareDocument
    inline.textContent = '' // free the memory held by the DOM
    return fromRaw(raw)
  }
  const url = new URLSearchParams(location.search).get('doc')
  try {
    const init = { headers: { accept: 'application/json' } }
    const get = () => (url === null ? client.fetch('/api/doc', init) : fetch(url, init))
    let res = await get()
    // a live session that has no snapshot yet (the follow is catching up, or waiting for the file)
    for (const until = Date.now() + FIRST_SNAPSHOT_WAIT_MS; res.status === 409 && Date.now() < until;) {
      await new Promise((r) => setTimeout(r, 500))
      res = await get()
    }
    if (!res.ok) return null
    const from = url === null ? client : clientOfDocUrl(url) ?? undefined
    const l = await fromRaw((await res.json()) as RawDocument | RawCompareDocument, from)
    l.client = from
    const rev = res.headers.get('X-Rev')
    if (rev !== null) { l.rev = Number(rev); l.live = res.headers.get('X-Live') ?? 'live' }
    return l
  } catch {
    return null
  }
}

export async function loadFile(file: File): Promise<Loaded> {
  const text = await file.text()
  return fromRaw(JSON.parse(text) as RawDocument | RawCompareDocument)
}
