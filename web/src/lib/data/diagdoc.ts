// What the shells need to know of a document that can be a diag session (`doc.dump`): the words that say what its file is, and where a line of the
// file sits among the nodes that are loaded.
import type { DiagFile, DiagSection } from './diag'
import { fmtInt } from './format'

/** What a kind of section is called: singular, plural (internal/model/sections.go keeps the same words for its note). */
const NOUNS: Record<string, [string, string]> = {
  heap: ['heap dump', 'heap dumps'],
  'pga-summary': ['PGA memory summary', 'PGA memory summaries'],
  'pga-detail': ['PGA memory detail dump', 'PGA memory detail dumps'],
  diagdump: ['diagnostic dump', 'diagnostic dumps'],
  procstate: ['process state', 'process states'],
  sysstate: ['system state', 'system states'],
  hang: ['hang analysis', 'hang analyses'],
  deadlock: ['deadlock graph', 'deadlock graphs'],
  incident: ['incident dump', 'incident dumps'],
}

export const sectionNoun = (kind: string, n: number): string => (NOUNS[kind] ?? NOUNS.diagdump)[n === 1 ? 0 : 1]

/** The sections counted by kind, in the order the kinds first appear. */
export function sectionCounts(sections: readonly DiagSection[]): { kind: string; n: number }[] {
  const out: { kind: string; n: number }[] = []
  for (const s of sections) {
    const e = out.find((x) => x.kind === s.kind)
    if (e) e.n++; else out.push({ kind: s.kind, n: 1 })
  }
  return out
}

/** "3 heap dumps", "1 diagnostic dump and 2 process states", "no diagnostic dump recognised": what the file holds, for the facts bar. */
export function describeFile(file: Pick<DiagFile, 'sections'>): string {
  const c = sectionCounts(file.sections)
  if (c.length === 0) return 'no diagnostic dump recognised'
  const parts = c.map((x) => `${fmtInt(x.n)} ${sectionNoun(x.kind, x.n)}`)
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The release line without its edition suffix ("Oracle Database 19c Enterprise Edition Release 19.0.0.0.0"). */
export const releaseOf = (file: Pick<DiagFile, 'release'>): string => file.release.replace(/ - Production$/, '')
