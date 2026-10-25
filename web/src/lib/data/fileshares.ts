// What each input file contributed, for the Files panel: its own response time (the span of its sessions over its own rows,
// `response.ts`) and its non-idle wait time.
import { useEffect, useMemo, useState } from 'react'
import type { TraceDoc } from './doc'
import { contextsOfFiles, fileCount } from './fileset'
import { sourceOf } from './source'
import { responseOf, scopeResponse } from './response'

export interface FileShare { responseUs: number; waitUs: number }

/**
 * Per file: the response time of its contexts alone (a chain part counts its own rows; a PX slave file alone has no
 * coordinator in scope, so it counts as its session) and Σ non-idle waits, one pass over the wait columns. Null without facts.
 */
export function localFileShares(doc: TraceDoc): FileShare[] | null {
  if (!doc.hasFacts) return null
  const n = fileCount(doc)
  const out: FileShare[] = Array.from({ length: n }, (_, f) => ({ responseUs: fileResponseUs(doc, f), waitUs: 0 }))
  const fileOf = doc.contexts.map((c) => c.fileIdx ?? 0)
  const w = doc.waits
  for (let i = 0; i < w.n; i++) if (!(w.flags[i] & 2)) { const f = out[fileOf[w.ctx[i]] ?? 0]; if (f) f.waitUs += w.ela[i] }
  return out
}

const fileResponseUs = (doc: TraceDoc, f: number) => scopeResponse(doc, { window: null, contexts: contextsOfFiles(doc, new Set([f])) }).responseUs

/** What the shares are measured against: the whole set's response time (Σ session spans) and Σ of the files' waits. */
export function shareTotals(doc: TraceDoc, shares: readonly (FileShare | null | undefined)[]): { responseUs: number; waitUs: number } {
  let waitUs = 0
  for (const s of shares) if (s) waitUs += s.waitUs
  return { responseUs: scopeResponse(doc, { window: null, contexts: null }).responseUs, waitUs }
}

const WORKERS = 3

/**
 * Per-file shares: computed in one pass from the facts for the in-browser source; from `api/profile?contexts=<the file's>&idle=0`
 * for a server (one request per file, a few at a time, answered from the source's cache the next time). `undefined` = not yet.
 */
export function useFileShares(doc: TraceDoc): (FileShare | null | undefined)[] {
  const source = sourceOf(doc)
  const local = useMemo(() => (source.remote ? undefined : localFileShares(doc)), [doc, source])
  const [remote, setRemote] = useState<{ doc: TraceDoc; shares: (FileShare | null | undefined)[] }>({ doc, shares: [] })
  useEffect(() => {
    if (!source.remote) return
    const ac = new AbortController()
    const n = fileCount(doc)
    const shares: (FileShare | null | undefined)[] = new Array(n).fill(undefined)
    setRemote({ doc, shares })
    let next = 0
    const work = async () => {
      for (;;) {
        const f = next++
        if (f >= n || ac.signal.aborted) return
        const ctxs = contextsOfFiles(doc, new Set([f]))
        let share: FileShare | null = null
        if (ctxs.size > 0) {
          try {
            const scope = { window: null, files: null, contexts: ctxs, includeIdle: false }
            const p = await source.profile(scope, ac.signal)
            if (p) share = { responseUs: responseOf(doc, scope, p).responseUs, waitUs: p.events.reduce((a, e) => a + e.sum, 0) }
          } catch { if (ac.signal.aborted) return }
        } else share = { responseUs: 0, waitUs: 0 }
        if (ac.signal.aborted) return
        shares[f] = share
        setRemote({ doc, shares: [...shares] })
      }
    }
    for (let k = 0; k < WORKERS; k++) void work()
    return () => ac.abort()
  }, [doc, source])
  if (!source.remote) return local ?? new Array(fileCount(doc)).fill(null)
  return remote.doc === doc ? remote.shares : []
}
