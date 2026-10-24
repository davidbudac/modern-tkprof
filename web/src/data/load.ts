import type { RawDocument, RawCompareDocument, Comparison } from './types'
import { TraceDoc } from './doc'
import { attachRemote } from './source'

export type Source = { kind: 'inline' } | { kind: 'url'; url: string } | { kind: 'file'; file: File }

/** Both traces of a comparison document, and the diff computed by Go. */
export interface CompareData { a: TraceDoc; b: TraceDoc; diff: Comparison }
export interface Loaded { doc: TraceDoc; compare: CompareData | null }

/**
 * A plain document, or a compare document (`{compare: {a, b, diff}}`: side A is shown first).
 * `apiBase` is where the document came from (`.../api/`): a document without facts that the server
 * flagged `slice` gets its fact-level answers from there.
 */
export async function fromRaw(raw: RawDocument | RawCompareDocument, apiBase?: string): Promise<Loaded> {
  if ('compare' in raw && raw.compare) {
    const [a, b] = await Promise.all([TraceDoc.fromRaw(raw.compare.a), TraceDoc.fromRaw(raw.compare.b)])
    return { doc: a, compare: { a, b, diff: raw.compare.diff } }
  }
  const doc = await TraceDoc.fromRaw(raw as RawDocument)
  if (apiBase && doc.slice && !doc.hasFacts) attachRemote(doc, apiBase)
  return { doc, compare: null }
}

/** Finds the document: inline <script id="mtkprof-data">, else ?doc= URL, else /api/doc. */
export async function loadInitial(): Promise<Loaded | null> {
  const inline = document.getElementById('mtkprof-data')
  if (inline?.textContent) {
    const raw = JSON.parse(inline.textContent) as RawDocument | RawCompareDocument
    inline.textContent = '' // free the memory held by the DOM
    return fromRaw(raw)
  }
  const params = new URLSearchParams(location.search)
  const url = params.get('doc') ?? '/api/doc'
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) return null
    return fromRaw((await res.json()) as RawDocument | RawCompareDocument, new URL('.', new URL(url, location.href)).href)
  } catch {
    return null
  }
}

export async function loadFile(file: File): Promise<Loaded> {
  const text = await file.text()
  return fromRaw(JSON.parse(text) as RawDocument | RawCompareDocument)
}
