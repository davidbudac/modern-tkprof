// What each input file contributed, for the Files panel: its CPU and non-idle wait time (the "busy" time the Overview ledger adds up).
import { useEffect, useMemo, useState } from 'react'
import type { TraceDoc } from './doc'
import { contextsOfFiles, fileCount } from './fileset'
import { sourceOf } from './source'

export interface FileShare { cpuUs: number; waitUs: number }

/** One pass over the fact columns: Σ c of top-level calls and Σ non-idle waits per file. Null without fact tables. */
export function localFileShares(doc: TraceDoc): FileShare[] | null {
  if (!doc.hasFacts) return null
  const out: FileShare[] = Array.from({ length: fileCount(doc) }, () => ({ cpuUs: 0, waitUs: 0 }))
  const fileOf = doc.contexts.map((c) => c.fileIdx ?? 0)
  const c = doc.calls, w = doc.waits
  for (let i = 0; i < c.n; i++) if (c.parent[i] < 0) { const f = out[fileOf[c.ctx[i]] ?? 0]; if (f) f.cpuUs += c.c[i] }
  for (let i = 0; i < w.n; i++) if (!(w.flags[i] & 2)) { const f = out[fileOf[w.ctx[i]] ?? 0]; if (f) f.waitUs += w.ela[i] }
  return out
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
            const p = await source.profile({ window: null, files: null, contexts: ctxs, includeIdle: false }, ac.signal)
            if (p) share = { cpuUs: p.cpuUs, waitUs: p.events.reduce((a, e) => a + e.sum, 0) }
          } catch { if (ac.signal.aborted) return }
        } else share = { cpuUs: 0, waitUs: 0 }
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
