// The 10053 (optimizer trace) side of the workspace, pure parts: which kind a file is, how a request for several files splits into tabs,
// the labels of the kinds, which open tab a jump between a 10046 trace and a 10053 dump goes to, and the note of a file that was left out of a set.
// (DESIGN / docs/PLAN-10053.md § Tabs and the link to a 10046 trace.)

/**
 * The fields the engine adds for the 10053 reader (docs/PLAN-10053.md § Build contract); until `pnpm gen:api` brings them into `api.d.ts` they are
 * declared here, next to their use. `kind` of a peek: "10046", "10053" (dumps and no 10046 record) or "both" (an interleaved file; the engine's
 * `FileKind` prints it "10046+10053"); "" when neither was seen.
 */
// from api.d.ts once regenerated
export interface PeekOpt { kind?: string; optDumps?: number; optSqlIds?: string[] }
// from api.d.ts once regenerated
export interface SessionOpt { optSqlIds?: string[] }

/** The kind of a tab: only the 10053 tabs are marked; an absent kind is a 10046 trace (as it always was). */
export type TabKind = '10053'

/** What a peek found in a file. */
export type FileKind = '10046' | '10053' | 'both' | ''

export function fileKindOf(p: PeekOpt | null | undefined): FileKind {
  const k = (p?.kind ?? '').toLowerCase()
  if (k === '10053') return '10053'
  if (k === 'both' || k === '10046+10053' || k === '10046 + 10053') return 'both'
  if (k === '10046') return '10046'
  return (p?.optDumps ?? 0) > 0 ? 'both' : ''
}

/** A file that holds optimizer dumps and nothing else: it is a tab of its own, never a member of a set. */
export const isOptFile = (p: PeekOpt | null | undefined): boolean => fileKindOf(p) === '10053'

/** The label of a file's kind in the folder picker: nothing for a plain 10046 trace. */
export function kindLabel(p: PeekOpt | null | undefined): string {
  const k = fileKindOf(p)
  return k === '10053' ? '10053' : k === 'both' ? '10046 + 10053' : ''
}

/** "3 dumps" of a peek that found some. */
export function dumpsLabel(p: PeekOpt | null | undefined): string {
  const n = p?.optDumps ?? 0
  return n > 0 ? `${n} dump${n === 1 ? '' : 's'}` : ''
}

/** The tooltip of the kind label: what opening the file does. */
export function kindTitle(p: PeekOpt | null | undefined): string {
  const k = fileKindOf(p)
  return k === '10053' ? 'An optimizer (10053) trace: it opens in a tab of its own, not in a set of 10046 traces'
    : k === 'both' ? 'A 10046 trace with optimizer (10053) dumps written into it: it opens as a 10046 trace; the dumps are only noted, not shown as 10053 yet' : ''
}

/**
 * A request for several files, split by what the peek found: the 10046 files form the set they would have formed, each 10053 file is a tab of its
 * own. A file not peeked, or an interleaved one, is a 10046 file. Order kept inside each part.
 */
export function splitByKind(paths: readonly string[], peekOf: (path: string) => PeekOpt | null | undefined): { set: string[]; opt: string[] } {
  const set: string[] = [], opt: string[] = []
  for (const p of paths) (isOptFile(peekOf(p)) ? opt : set).push(p)
  return { set, opt }
}

// ---- the jump between a 10046 tab and a 10053 tab -----------------------------------------------------------------------------------

/** The part of a tab a jump looks at. */
export interface JumpTab { key: string; kind?: TabKind; origin: string; optSqlIds?: string[] }

/** The candidates for a jump, the most recently used first: ties keep the later tab (opened later) first. A tab never used counts as 0. */
export function pickJumpTab<T extends { key: string }>(candidates: readonly T[], lastUsed: ReadonlyMap<string, number>): T | undefined {
  let best: T | undefined, bestAt = -Infinity
  for (const t of candidates) {
    const at = lastUsed.get(t.key) ?? 0
    if (at >= bestAt) { best = t; bestAt = at }
  }
  return best
}

/** The open 10053 tabs other than `except` with a dump of `sqlId`. */
export const dumpTabs = <T extends JumpTab>(tabs: readonly T[], sqlId: string, except: string): T[] =>
  sqlId ? tabs.filter((t) => t.key !== except && t.kind === '10053' && t.optSqlIds?.includes(sqlId)) : []

/** The open 10046 tabs other than `except` that have a statement with `sqlId` (`has` asks the tab's document). */
export const statementTabs = <T extends JumpTab>(tabs: readonly T[], sqlId: string, except: string, has: (t: T, sqlId: string) => boolean): T[] =>
  sqlId ? tabs.filter((t) => t.key !== except && t.kind !== '10053' && t.origin !== 'comparison' && has(t, sqlId)) : []

/** The first dump of the file with this sql_id (a statement dumped twice shows its first), or -1. */
export const dumpIndexOf = (dumps: readonly { idx: number; sqlId: string }[], sqlId: string): number => dumps.find((d) => d.sqlId === sqlId)?.idx ?? -1

/** The distinct sql_ids of a file's dumps, in file order. */
export const sqlIdsOf = (dumps: readonly { sqlId: string }[]): string[] => [...new Set(dumps.map((d) => d.sqlId).filter(Boolean))]

// ---- the note of a file that was left out ------------------------------------------------------------------------------------------

/**
 * The engine drops a 10053 file from a set of other files and says so in a note: "opt_two.trc is a 10053 file; open it on its own"
 * (`model.DropOptFiles`). The file name in it, or null for any other note. Of a set made only of 10053 files the first is opened and the others
 * are named in a note, which this reads as well when it ends the same way.
 */
export function leftOutFile(note: string): string | null {
  const m = /^(.+?) is a 10053 file\b/.exec(note.trim())
  return m ? m[1] : null
}

/** The requested file or folder that holds `name`: a path whose last part is `name`, else null (a folder is looked into by the caller). */
export function pathNamed(paths: readonly string[], name: string): string | null {
  const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return paths.find((p) => base(p) === name) ?? null
}
