import { annotationsFile, parseAnnotationsFile, type Annotation } from '@lib'
import type { TraceAnnotations } from './workspace/annotations'
import { mergeLibrary, parseLibraryFile, type SavedPivot } from '@lib/data/pivotconfig'
import { type Connection, importInto, parseConnectionsFile, serializeConnections, validateConnection } from './connections/model'

/**
 * Default portable backup: `{"mtkprof-desktop": 1, "connections": [...], "library": [...]}`.
 * The two parts are written and read by the serializers and parsers of their own files
 * (`mtkprof-connections.json`, `mtkprof-library.json`), so what they validate and drop (unknown
 * fields, secrets: a connection never carries one) holds here too. Version 2 adds explicitly
 * selected investigation metadata, validated independently below.
 */
export const BACKUP_VERSION = 1
export const BACKUP_FILE_NAME = 'mtkprof-desktop-backup.json'

export function serializeBackup(connections: Connection[], library: SavedPivot[], investigation?: InvestigationBackup): string {
  // through the validator first: a field that is not a known definition field (a secret) is dropped
  const known = connections.flatMap((c) => validateConnection(c).conn ?? [])
  const conns = (JSON.parse(serializeConnections(known)) as { connections: Connection[] }).connections
  return JSON.stringify({ 'mtkprof-desktop': investigation ? 2 : BACKUP_VERSION, connections: conns, library, ...(investigation ? { investigation: validateInvestigation(investigation) } : {}) }, null, 2) + '\n'
}

export interface ParsedBackup {
  connections: Connection[]
  library: SavedPivot[]
  investigation?: InvestigationBackup
  /** connection entries skipped or fields dropped, one line each */
  problems: string[]
  /** library entries not understood */
  skipped: number
  /** the file is unusable as a whole: nothing to merge */
  fatal?: string
}

const none = (fatal: string): ParsedBackup => ({ connections: [], library: [], problems: [], skipped: 0, fatal })

export function parseBackup(text: string): ParsedBackup {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return none(`not valid JSON: ${(e as Error).message}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return none('expected {"mtkprof-desktop": 1, "connections": [...], "library": [...]}')
  const d = data as Record<string, unknown>
  if (d['mtkprof-desktop'] === undefined) return none('not an mtkprof-desktop backup (no "mtkprof-desktop" version)')
  if (d['mtkprof-desktop'] !== BACKUP_VERSION && d['mtkprof-desktop'] !== 2) return none(`unsupported backup version ${JSON.stringify(d['mtkprof-desktop'])} (this app reads 1 or 2)`)
  for (const k of ['connections', 'library'] as const) if (d[k] !== undefined && !Array.isArray(d[k])) return none(`"${k}" must be an array`)

  const c = parseConnectionsFile(JSON.stringify({ version: 1, connections: d.connections ?? [] }))
  if (c.fatal) return none(c.fatal)
  let library: SavedPivot[]
  let skipped: number
  try {
    ;({ pivots: library, skipped } = parseLibraryFile(JSON.stringify({ version: 1, pivots: d.library ?? [] })))
  } catch (e) {
    return none(e instanceof Error ? e.message : String(e))
  }
  let investigation: InvestigationBackup | undefined
  if (d['mtkprof-desktop'] === 2 && d.investigation !== undefined) {
    try { investigation = validateInvestigation(d.investigation) }
    catch (e) { return none(e instanceof Error ? e.message : String(e)) }
  }
  return { connections: c.connections, library, problems: c.problems, skipped, ...(investigation ? { investigation } : {}) }
}

export interface MergedBackup {
  connections: Connection[]
  library: SavedPivot[]
  counts: { connAdded: number; connReplaced: number; libAdded: number; libReplaced: number; libKept: number }
}

/**
 * Merges a backup into what is there: a connection with the same id is replaced; a saved pivot
 * with the same id is replaced only when the incoming one is newer (as in the library import).
 */
export function mergeBackup(local: Connection[], library: SavedPivot[], b: Pick<ParsedBackup, 'connections' | 'library'>): MergedBackup {
  const c = importInto(local, b.connections)
  const have = new Map(library.map((p) => [p.id, p]))
  let libAdded = 0
  let libReplaced = 0
  let libKept = 0
  for (const p of b.library) {
    const old = have.get(p.id)
    if (!old) libAdded++
    else if (p.updated > old.updated) libReplaced++
    else libKept++
  }
  return {
    connections: c.local,
    library: mergeLibrary(library, b.library),
    counts: { connAdded: c.added, connReplaced: c.replaced, libAdded, libReplaced, libKept },
  }
}

/** One line for the Settings page after an import. */
export function describeMerge(m: MergedBackup['counts'], p: Pick<ParsedBackup, 'problems' | 'skipped'>): string {
  const conn = `connections: ${m.connAdded} new, ${m.connReplaced} replaced`
  const lib = `library: ${m.libAdded} new, ${m.libReplaced} replaced${m.libKept ? `, ${m.libKept} kept (the local one is newer)` : ''}`
  const bad = p.problems.length + p.skipped
  return `Imported ${conn}; ${lib}${bad ? `; ${bad} problem${bad === 1 ? '' : 's'} in the file (skipped or ignored)` : ''}.`
}


/** Opt-in metadata only. Workspace references remain inert on import. */
export interface InvestigationBackup {
  annotations?: Record<string, TraceAnnotations>
  settings?: { theme?: 'system' | 'light' | 'dark'; binds?: 'keep' | 'redact' | 'none'; startEmpty?: boolean }
  workspace?: { paths: string[] }[]
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Reconstruct every supported field; never carry unknown payloads, connection actions or salts. */
export function validateInvestigation(value: unknown): InvestigationBackup {
  if (!record(value)) throw new Error('investigation must be an object')
  const out: InvestigationBackup = {}
  if (value.annotations !== undefined) {
    if (!record(value.annotations)) throw new Error('investigation annotations must be an object')
    out.annotations = Object.create(null) as Record<string, TraceAnnotations>
    for (const [identity, entry] of Object.entries(value.annotations)) {
      if (!identity || !record(entry) || (entry.notes !== undefined && !Array.isArray(entry.notes)) || (entry.bookmarks !== undefined && !Array.isArray(entry.bookmarks))) throw new Error('invalid trace annotations')
      const parsed = parseAnnotationsFile(JSON.stringify(annotationsFile(identity, '', (entry.notes ?? []) as Annotation[], (entry.bookmarks ?? []) as NonNullable<TraceAnnotations['bookmarks']>)))
      if (parsed.skipped) throw new Error('invalid annotation entry')
      const clean = (a: Annotation): Annotation => {
        const b: Annotation = { id: a.id, kind: a.kind, note: a.note, created: a.created, updated: a.updated }
        for (const k of ['execNo', 'cursorLine', 'from', 'to', 'file', 'line'] as const) {
          if (a[k] !== undefined) {
            if (!Number.isFinite(a[k]) || a[k]! < 0) throw new Error('invalid annotation number')
            b[k] = a[k]
          }
        }
        if (!Number.isFinite(a.created) || !Number.isFinite(a.updated)) throw new Error('invalid annotation timestamp')
        if (a.label !== undefined) { if (typeof a.label !== 'string') throw new Error('invalid annotation label'); b.label = a.label }
        if (a.stmt) b.stmt = { sqlId: typeof a.stmt.sqlId === 'string' ? a.stmt.sqlId : '', hash: a.stmt.hash }
        return b
      }
      const safe = parsed.annotations.map(clean)
      // Re-parse cleaned line annotations to validate bookmark positions and remove unknown fields.
      const lines = parseAnnotationsFile(JSON.stringify(annotationsFile(identity, '', parsed.bookmarks.map((b) => clean({ id: `line:${b.file}:${b.line}`, kind: 'line', note: b.note ?? '', label: b.label, file: b.file, line: b.line, created: b.updated ?? 0, updated: b.updated ?? 0 })), [])))
      out.annotations[identity] = { notes: safe, bookmarks: lines.bookmarks }
    }
  }
  if (value.settings !== undefined) {
    if (!record(value.settings)) throw new Error('investigation settings must be an object')
    const s = value.settings
    out.settings = {}
    if (s.theme !== undefined) { if (!['system', 'light', 'dark'].includes(String(s.theme))) throw new Error('invalid theme'); out.settings.theme = s.theme as 'system' | 'light' | 'dark' }
    if (s.binds !== undefined) { if (!['keep', 'redact', 'none'].includes(String(s.binds))) throw new Error('invalid bind mode'); out.settings.binds = s.binds as 'keep' | 'redact' | 'none' }
    if (s.startEmpty !== undefined) { if (typeof s.startEmpty !== 'boolean') throw new Error('invalid start setting'); out.settings.startEmpty = s.startEmpty }
  }
  if (value.workspace !== undefined) {
    if (!Array.isArray(value.workspace)) throw new Error('workspace references must be an array')
    out.workspace = value.workspace.map((v: unknown) => {
      if (!record(v) || !Array.isArray(v.paths) || !v.paths.length || v.paths.some((p: unknown) => typeof p !== 'string' || !p || p.includes('\0'))) throw new Error('invalid workspace reference')
      return { paths: [...v.paths] as string[] }
    })
  }
  return out
}
