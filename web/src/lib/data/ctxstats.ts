// Per session-context numbers (analyze.Contexts): the document's `stats.contexts`, else one pass over the fact columns.
import type { TraceDoc } from './doc'

/** Per-context statistics, as `analyze.ContextStats` (without the id). */
export interface CtxStats {
  calls: number
  elapsed: number // Σ e of top-level calls
  cpu: number // Σ c of top-level calls
  waitUs: number // waits inside calls (idle-class ones included)
  idleUs: number // waits between calls (think time)
  rows: number
  firstTim: number // start of the first call (tim - e) or the first wait's tim
  lastTim: number
}

export function emptyStats(): CtxStats {
  return { calls: 0, elapsed: 0, cpu: 0, waitUs: 0, idleUs: 0, rows: 0, firstTim: 0, lastTim: 0 }
}

const cache = new WeakMap<object, readonly CtxStats[]>()

/** One entry per `doc.contexts`, in id order; empty entries for a document with neither the stats nor the facts. */
export function contextStats(doc: TraceDoc): readonly CtxStats[] {
  const n = doc.contexts.length
  // the CLI ships these (analyze.Contexts); recompute only for older documents
  if (doc.stats.contexts.length === n && n > 0) return doc.stats.contexts
  const hit = cache.get(doc)
  if (hit) return hit
  const out: CtxStats[] = Array.from({ length: n }, emptyStats)
  if (doc.hasFacts) {
    const c = doc.calls
    for (let i = 0; i < c.n; i++) {
      const k = c.ctx[i]
      if (k < 0 || k >= n) continue
      const s = out[k]
      s.calls++
      s.rows += c.r[i]
      if (c.parent[i] === -1) {
        s.elapsed += c.e[i]
        s.cpu += c.c[i]
      }
      const tim = c.tim[i]
      if (tim) {
        const start = tim - c.e[i]
        if (!s.firstTim || start < s.firstTim) s.firstTim = start
        if (tim > s.lastTim) s.lastTim = tim
      }
    }
    const w = doc.waits
    for (let i = 0; i < w.n; i++) {
      const k = w.ctx[i]
      if (k < 0 || k >= n) continue
      const s = out[k]
      if (w.flags[i] & 1) s.idleUs += w.ela[i] // between calls; an idle-class wait inside a call is a wait of the call
      else s.waitUs += w.ela[i]
      const tim = w.tim[i]
      if (tim) {
        if (!s.firstTim || tim < s.firstTim) s.firstTim = tim
        if (tim > s.lastTim) s.lastTim = tim
      }
    }
  }
  cache.set(doc, out)
  return out
}
