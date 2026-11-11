// Where the 10053 view's data comes from, in the apps: a source over the document's digest (the standalone report, any client without a
// server) or over the two routes of a 10053 session (`api/opt/dump?i=`, `api/opt/text?i=`: `serve`, and `/s/{id}/api/…` of the engine).
// The rule that picks is `optSourceOf`: a document that carries `opt.digest` is read from itself, else the routes are asked.
//
// A source lives as long as its tab: the view keeps its per-source state (open dump, selection, scroll, search, folds) in a WeakMap keyed by
// the source object, so `optSourceOf` returns the same object for the same document.
import type { ApiClient } from './client'
import type { TraceDoc } from './doc'
import type { OptDigestRun, RawOpt } from './types'
import { normalizeDump, sparseText, splitLines, type OptDump, type OptFile, type OptSource, type OptText } from './opt'

// ---- the digest source ------------------------------------------------------------------------------------------------------------

/** The line `n` out of runs of consecutive lines in ascending order (binary search); undefined where no run holds it. */
function lineOfRuns(runs: readonly OptDigestRun[], n: number): string | undefined {
  let lo = 0, hi = runs.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = runs[mid]
    if (n < r.from) hi = mid - 1
    else if (n >= r.from + r.text.length) lo = mid + 1
    else return r.text[n - r.from]
  }
  return undefined
}

/**
 * A source over a document's digest: the dumps' models from `opt.digest.dumps`, and a sparse text per dump (`complete: false`): only the
 * lines of the dump's digest ranges that the runs hold are there, the rest are gaps for the view to say so.
 */
export function digestSource(opt: RawOpt): OptSource {
  const digest = opt.digest
  const dumps = (digest?.dumps ?? []).map((d) => normalizeDump(d))
  const runs = digest?.lines ?? []
  const byIdx = (idx: number): OptDump | undefined => dumps.find((d) => d.idx === idx) ?? dumps[idx]
  return {
    file: opt.file,
    dump: (idx) => {
      const d = byIdx(idx)
      return d ? Promise.resolve(d) : Promise.reject(new Error(`this report holds no dump ${idx}`))
    },
    text: (idx) => {
      const d = byIdx(idx)
      return d ? Promise.resolve(sparseText(d.viewFrom, d.viewTo, d.digest, (l) => lineOfRuns(runs, l))) : Promise.reject(new Error(`this report holds no dump ${idx}`))
    },
  }
}

// ---- the HTTP source --------------------------------------------------------------------------------------------------------------

async function failure(what: string, res: Response): Promise<Error> {
  const body = (await res.text().catch(() => '')).trim().slice(0, 300)
  return new Error(`${what}: ${res.status} ${res.statusText}${body ? ': ' + body : ''}`)
}

/**
 * A source over the routes of a 10053 session. Every call asks the server: a dump's model and text are megabytes, and the one place that keeps them
 * is the view's cache of two dumps (data/optcache.ts), so a dump let go is asked again. The text is taken only when it holds every line of
 * `viewFrom..viewTo`: a shorter answer is an error.
 */
export function httpSource(file: OptFile, client: ApiClient): OptSource {
  return {
    file,
    dump: async (idx) => {
      const res = await client.fetch(`/api/opt/dump?i=${idx}`, { headers: { accept: 'application/json' } })
      if (!res.ok) throw await failure(`dump ${idx}`, res)
      return normalizeDump((await res.json()) as OptDump)
    },
    text: async (idx) => {
      const info = file.dumps[idx]
      if (!info) throw new Error(`the file has no dump ${idx}`)
      const res = await client.fetch(`/api/opt/text?i=${idx}`)
      if (!res.ok) throw await failure(`text of dump ${idx}`, res)
      const lines = splitLines(await res.text())
      const want = info.viewTo - info.viewFrom + 1
      if (lines.length < want) throw new Error(`text of dump ${idx} is short: ${lines.length} of ${want} lines (${info.viewFrom}-${info.viewTo})`)
      return chunk(lines, info.viewFrom, info.viewTo)
    },
  }
}

/** The lines of one dump's view range, the text starting at line `from` of the file. */
function chunk(lines: readonly string[], from: number, to: number): OptText {
  return { from, to, complete: true, get: (line) => (line >= from && line <= to ? lines[line - from] : undefined) }
}

// ---- the pick ---------------------------------------------------------------------------------------------------------------------

/** The server a document came from, when that is not the session's client (`?doc=` on another server): fromRaw records it. */
const origin = new WeakMap<RawOpt, ApiClient>()

/** Records the server `opt` was served by (load.ts, for a document that carries no digest). */
export function attachOptClient(opt: RawOpt, client: ApiClient): void {
  origin.set(opt, client)
}

const sources = new WeakMap<RawOpt, OptSource>()

/** The source of a 10053 document: its digest when it carries one, else the routes of `client` (or of the server the document came from). Cached per document. */
export function optSourceOf(doc: TraceDoc & { opt: RawOpt }, client: ApiClient): OptSource {
  const opt = doc.opt
  let s = sources.get(opt)
  if (!s) {
    s = opt.digest ? digestSource(opt) : httpSource(opt.file, origin.get(opt) ?? client)
    sources.set(opt, s)
  }
  return s
}
