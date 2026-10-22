import type { RawDocument } from './types'
import { TraceDoc } from './doc'

export type Source = { kind: 'inline' } | { kind: 'url'; url: string } | { kind: 'file'; file: File }

/** Finds the document: inline <script id="mtkprof-data">, else ?doc= URL, else /api/doc. */
export async function loadInitial(): Promise<TraceDoc | null> {
  const inline = document.getElementById('mtkprof-data')
  if (inline?.textContent) {
    const raw = JSON.parse(inline.textContent) as RawDocument
    inline.textContent = '' // free the memory held by the DOM
    return TraceDoc.fromRaw(raw)
  }
  const params = new URLSearchParams(location.search)
  const url = params.get('doc') ?? '/api/doc'
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const raw = (await res.json()) as RawDocument
    return TraceDoc.fromRaw(raw)
  } catch {
    return null
  }
}

export async function loadFile(file: File): Promise<TraceDoc> {
  const text = await file.text()
  return TraceDoc.fromRaw(JSON.parse(text) as RawDocument)
}
