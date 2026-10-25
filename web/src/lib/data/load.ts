import type { RawDocument, RawCompareDocument, Comparison } from './types'
import { TraceDoc } from './doc'
import { attachRemote } from './source'
import { createClient, type ApiClient } from './client'

export type Source = { kind: 'inline' } | { kind: 'url'; url: string } | { kind: 'file'; file: File }

/** Both traces of a comparison document, and the diff computed by Go. */
export interface CompareData { a: TraceDoc; b: TraceDoc; diff: Comparison }
export interface Loaded { doc: TraceDoc; compare: CompareData | null }

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
    const res = url === null ? await client.fetch('/api/doc', init) : await fetch(url, init)
    if (!res.ok) return null
    return fromRaw((await res.json()) as RawDocument | RawCompareDocument, url === null ? client : clientOfDocUrl(url) ?? undefined)
  } catch {
    return null
  }
}

export async function loadFile(file: File): Promise<Loaded> {
  const text = await file.text()
  return fromRaw(JSON.parse(text) as RawDocument | RawCompareDocument)
}
