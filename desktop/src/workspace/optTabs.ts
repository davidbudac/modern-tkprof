// The 10053 (optimizer trace) and dump (diagnostic dumps) side of the workspace, pure parts: which kind a file is, how a request for several files
// splits into tabs, the labels of the kinds, which open tab a jump between a 10046 trace and a 10053 dump goes to, the note of a file that was left out
// of a set, and the buttons that open a file in another view. (DESIGN / docs/PLAN-10053.md § Tabs and the link to a 10046 trace, docs/PLAN-DIAG.md § The reader.)

import type { SessionInfo, SessionOptions, TracePeek } from '../engine'

/**
 * The fields the engine adds for the 10053 reader (docs/PLAN-10053.md § Build contract), from the generated types (`api.d.ts`). `kind` of a peek:
 * "10046", "10053" (dumps and no 10046 record) or "both" (an interleaved file); absent when neither was seen. `fileKindOf` also tolerates the
 * engine's `FileKind` spelling "10046+10053".
 */
export type PeekOpt = Pick<TracePeek, 'optDumps' | 'optSqlIds' | 'sections'> & { kind?: string } // a TracePeek is one; a string so that the engine's FileKind spelling is read too
export type SessionOpt = Pick<SessionInfo, 'optSqlIds'>

/** The kind of a tab: only the 10053 and dump tabs are marked; an absent kind is a 10046 trace (as it always was). `dump`: a file read as diagnostic dumps (the dump reader). */
export type TabKind = '10053' | 'dump'

/** What a peek found in a file: `diag` is diagnostic dumps and no 10046 record nor optimizer dump. */
export type FileKind = '10046' | '10053' | 'both' | 'diag' | ''

/** The view a session reads its file in (`SessionOptions.view`). */
export type SessionViewName = NonNullable<SessionOptions['view']>

/** A tab kind from the stored `kind` field (`workspace.json`), or undefined for anything else. */
export const tabKindOf = (k: unknown): TabKind | undefined => (k === '10053' || k === 'dump' ? k : undefined)

/** The tab kind a file of this kind opens as. */
export const tabKindForFile = (k: FileKind): TabKind | undefined => (k === '10053' ? '10053' : k === 'diag' ? 'dump' : undefined)

/** The tab kind a session's view gives (the engine's `view` of a session, resolved), or undefined for the SQL trace views. */
export const tabKindOfView = (v: string | undefined): TabKind | undefined => (v === 'diag' ? 'dump' : v === '10053' ? '10053' : undefined)

/** The badge of a tab kind in the tab strip and the recent list: its text and tooltip. */
export function kindBadge(k: TabKind | undefined): { text: string; title: string } | null {
  return k === '10053' ? { text: '10053', title: 'An optimizer (10053) trace' } : k === 'dump' ? { text: 'dump', title: 'A file read as diagnostic dumps (the dump reader)' } : null
}

export function fileKindOf(p: PeekOpt | null | undefined): FileKind {
  const k = (p?.kind ?? '').toLowerCase()
  if (k === '10053') return '10053'
  if (k === 'diag') return 'diag'
  if (k === 'both' || k === '10046+10053' || k === '10046 + 10053') return 'both'
  if (k === '10046') return '10046'
  return (p?.optDumps ?? 0) > 0 ? 'both' : ''
}

/** A file that holds optimizer dumps and nothing else: it is a tab of its own, never a member of a set. */
export const isOptFile = (p: PeekOpt | null | undefined): boolean => fileKindOf(p) === '10053'

/** A file that holds diagnostic dumps (a heap dump, an errorstack, a process or system state, ...) and nothing else: it opens in the dump reader, in a tab of its own. */
export const isDumpFile = (p: PeekOpt | null | undefined): boolean => fileKindOf(p) === 'diag'

/** A file that is a tab of its own, never a member of a set: an optimizer trace or a file of diagnostic dumps. */
export const hasOwnTab = (p: PeekOpt | null | undefined): boolean => isOptFile(p) || isDumpFile(p)

/** The label of a file's kind in the folder picker: nothing for a plain 10046 trace. */
export function kindLabel(p: PeekOpt | null | undefined): string {
  const k = fileKindOf(p)
  return k === '10053' ? '10053' : k === 'both' ? '10046 + 10053' : k === 'diag' ? 'dump' : ''
}

/** What a diagnostic dump section is called in the picker's tag: singular, plural. */
const SECTION_NOUNS: Record<string, [string, string]> = {
  heap: ['heap dump', 'heap dumps'],
  'pga-summary': ['PGA summary', 'PGA summaries'],
  'pga-detail': ['PGA detail dump', 'PGA detail dumps'],
  diagdump: ['errorstack', 'errorstacks'],
  procstate: ['process state', 'process states'],
  sysstate: ['system state', 'system states'],
  hang: ['hang analysis', 'hang analyses'],
  deadlock: ['deadlock graph', 'deadlock graphs'],
  incident: ['incident', 'incidents'],
}

/** "3 dumps" of a peek that found some; for a file of diagnostic dumps its sections by kind: "2 heap dumps, 1 process state". */
export function dumpsLabel(p: PeekOpt | null | undefined): string {
  if (isDumpFile(p)) {
    return (p?.sections ?? []).map((s) => { const n = SECTION_NOUNS[s.kind] ?? ['diagnostic dump', 'diagnostic dumps']; return `${s.count} ${n[s.count === 1 ? 0 : 1]}` }).join(', ')
  }
  const n = p?.optDumps ?? 0
  return n > 0 ? `${n} dump${n === 1 ? '' : 's'}` : ''
}

/** The tooltip of the kind label: what opening the file does. */
export function kindTitle(p: PeekOpt | null | undefined): string {
  const k = fileKindOf(p)
  return k === '10053' ? 'An optimizer (10053) trace: it opens in a tab of its own, not in a set of 10046 traces'
    : k === 'both' ? 'A 10046 trace with optimizer (10053) dumps written into it: it opens as a 10046 trace; open it as 10053 from the note in its tab'
    : k === 'diag' ? 'A file of diagnostic dumps (heap dump, errorstack, process or system state, ...): it opens in the dump reader, in a tab of its own, not in a set of 10046 traces' : ''
}

/**
 * The options a file (or a set of `count` files) is opened with: follow is one live file, so a set of several opens without it, and a 10053 file or
 * a file of diagnostic dumps is read whole and never followed (the engine refuses it). Other options are kept.
 */
export function optionsFor<T extends { follow?: boolean }>(options: T, count: number, kind: FileKind): T {
  return options.follow && (count !== 1 || kind === '10053' || kind === 'diag') ? { ...options, follow: undefined } : options
}

/** The engine's refusal to follow a 10053 file (`follow: x.trc is a 10053 file (optimizer trace); it cannot be followed live: open it without follow`). */
export const isFollowRefusal = (message: string): boolean => /is a 10053 file \(optimizer trace\); it cannot be followed live/.test(message)

/**
 * A request for several files, split by what the peek found: the 10046 files form the set they would have formed, each 10053 file and each file of
 * diagnostic dumps is a tab of its own. A file not peeked, or an interleaved one, is a 10046 file. Order kept inside each part.
 */
export function splitByKind(paths: readonly string[], peekOf: (path: string) => PeekOpt | null | undefined): { set: string[]; opt: string[]; dump: string[] } {
  const set: string[] = [], opt: string[] = [], dump: string[] = []
  for (const p of paths) {
    const k = fileKindOf(peekOf(p))
    ;(k === '10053' ? opt : k === 'diag' ? dump : set).push(p)
  }
  return { set, opt, dump }
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
 * The engine drops a 10053 file, or a file of diagnostic dumps only, from a set of other files and says so in a note: "opt_two.trc is a 10053 file; open
 * it on its own", "x.trc holds diagnostic dumps only; open it on its own" (`model.DropOptFiles`). The file name in it, or null for any other note. Of a
 * set made only of such files the first is opened and the others are named in a note, which this reads as well when it ends the same way.
 */
export function leftOutFile(note: string): string | null {
  const m = /^(.+?) (?:is a 10053 file|holds diagnostic dumps only)\b/.exec(note.trim())
  return m ? m[1] : null
}

// ---- the notes of a 10046 trace that holds dumps, and the buttons that open it in another view ---------------------------------------

/**
 * A note of the trace that says the file holds optimizer (10053) dumps: "2 optimizer (10053) dumps in this file, lines 54-18358 and 18734-27979" or, of a
 * set, "x.trc has 2 optimizer (10053) dumps, lines …". The file's name when the note names it ('' for a single file), or null for any other note.
 */
export function optDumpNote(note: string): string | null {
  const t = note.trim()
  const m = /^(?:(.+?) has )?\d+ optimizer \(10053\) dumps?\b/.exec(t)
  return m ? m[1] ?? '' : null
}

/** The nouns a diagnostic-dump note counts (internal/model/sections.go). */
const DUMP_NOUNS = /\b(?:diagnostic dumps?|heap dumps?|PGA memory (?:summary|summaries|detail dumps?)|process states?|system states?|hang analys[ie]s|deadlock graphs?|incident dumps?)\b/

/**
 * A note of the trace that says the file holds diagnostic dumps: "1 diagnostic dump in this file, lines 114-29753" or, of a set, "x.trc has 3 heap dumps,
 * lines …". The file's name when the note names it ('' for a single file), or null for any other note (an optimizer-dump note is not one).
 */
export function diagDumpNote(note: string): string | null {
  const t = note.trim()
  if (/optimizer \(10053\)/.test(t) || !/, lines \d+-\d+/.test(t)) return null
  const m = /^(?:(.+?) has )?\d+ (?:diagnostic dumps?|heap dumps?|PGA memory|process states?|system states?|hang analys[ie]s|deadlock graphs?|incident dumps?)/.exec(t)
  return m && DUMP_NOUNS.test(t) ? m[1] ?? '' : null
}

/** The requested file or folder that holds `name`: a path whose last part is `name`, else null (a folder is looked into by the caller). */
export function pathNamed(paths: readonly string[], name: string): string | null {
  const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return paths.find((p) => base(p) === name) ?? null
}
