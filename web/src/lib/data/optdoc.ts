// What the shells need to know of a document that can be a 10053 one (doc.opt): which views it has, the masthead facts that mean something for
// it, and where a line of the file sits among the dumps.
import type { TraceDoc } from './doc'
import type { OptFile } from './opt'
import type { Marker } from './types'

/** The document is a 10053 file (the optimizer trace): the 10053 view is its only trace view. */
export const isOptDoc = (doc: Pick<TraceDoc, 'opt'> | null | undefined): boolean => !!doc?.opt

/** The views of the tab rather than of the trace (the desktop's Notes and Reports) also work on a 10053 document. */
const TOOL_VIEWS: ReadonlySet<string> = new Set(['annotations', 'reports'])

/**
 * Whether `view` is one the document can show: `opt` only for a 10053 document, and for it nothing of the 10046 views (the tools of the tab
 * apart). A view that does not fit is never remembered (the store ignores it), so `opt` cannot become the view a 10046 tab starts on, nor a
 * 10046 view that of a 10053 tab.
 */
export function viewFits(doc: Pick<TraceDoc, 'opt'> | null | undefined, view: string): boolean {
  if (!doc) return true
  return doc.opt ? view === 'opt' || TOOL_VIEWS.has(view) : view !== 'opt'
}

/** The view a document opens on. */
export const startView = (doc: Pick<TraceDoc, 'opt'>): 'opt' | 'overview' => (doc.opt ? 'opt' : 'overview')

/** The dump of the file that holds `line` (its view range), or null. */
export function dumpOfLine(file: Pick<OptFile, 'dumps'>, line: number): number | null {
  const d = file.dumps.find((x) => line >= x.viewFrom && line <= x.viewTo)
  return d ? d.idx : null
}

/** The label of a bookmark on `line` of a 10053 file: which dump it is in (the view has no line text at hand). */
export function lineLabel(file: Pick<OptFile, 'dumps'>, line: number): string {
  const i = dumpOfLine(file, line)
  const d = i === null ? undefined : file.dumps[i]
  return d ? `dump ${d.idx + 1}${d.sqlId ? ` · ${d.sqlId}` : ''}` : ''
}

/** The facts of the masthead that mean something for a 10053 file: the release, the session and the pluggable database, from the markers. */
export interface OptFacts { release: string; version: string; session: string; pdb: string }

const markerText = (m: Marker) => m.text.replace(/^\*+\s*/, '')

export function optFacts(doc: Pick<TraceDoc, 'opt' | 'file' | 'markers'>): OptFacts {
  const f = doc.opt?.file
  let session = '', pdb = ''
  for (const m of doc.markers) {
    const t = markerText(m)
    if (!session) { const s = /SESSION ID:\(([^)]*)\)/.exec(t); if (s) session = s[1] }
    if (!pdb) {
      const p = /^\(?([A-Za-z0-9_$#]+)\((\d+)\)\)?$/.exec(t.trim()) ?? /\(([A-Za-z0-9_$#]+)\((\d+)\)\)/.exec(t) // "PDB1(3)": the marker of a context line (its time is the marker's); "(PDB1(3))" in the raw line
      if (p) pdb = `${p[1]} (container ${p[2]})`
    }
    if (session && pdb) break
  }
  return { release: (f?.release || '').replace(/ - Production$/, ''), version: f?.version || doc.file.version || '', session, pdb }
}
