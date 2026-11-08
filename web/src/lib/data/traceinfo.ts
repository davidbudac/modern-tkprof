// What the trace is, for the Overview masthead: when it ran, on which database, in which sessions and modules. The database
// facts come from the file header (the first file of a set; the instances from every selected file), the session facts from the
// session markers of the contexts in scope, the time from the scope's wall-clock span (the window's when one is set).
import { fmtTz } from './format'
import type { Context, FileInfo, Marker, Span } from './types'

export interface TraceInfo {
  /** wall clock of the scope, µs since the epoch; 0 = the trace has none */
  firstWallUs: number
  lastWallUs: number
  tzOffsetMin: number
  /** database name (`Database name`, else the instance) and the PDBs of the contexts in scope (`*** <ts> (PDB1(3))`) */
  db: string
  pdbs: string[]
  /** "19c Enterprise Edition", "26ai Free"; "" when the banner line is missing */
  product: string
  /** "19.27", "12.2.0.1" */
  version: string
  /** `Database role` when it is not PRIMARY (a standby is worth seeing at once) */
  role: string
  instances: string[]
  host: string
  /** "Linux x86_64" */
  platform: string
  /** the sessions in scope (PX slaves attached to a coordinator in scope are counted apart) */
  sessions: string[]
  pxSlaves: number
  services: string[]
  modules: string[]
  actions: string[]
  drivers: string[]
  clientIds: string[]
}

export interface InfoDoc {
  file: Pick<FileInfo, 'headers' | 'version' | 'instance' | 'node' | 'machine' | 'systemName' | 'files'>
  contexts: readonly Context[]
  markers: readonly Marker[]
  span: Pick<Span, 'firstWallUs' | 'lastWallUs'>
  tzOffsetMin: number
  wallOf(tim: number): number
}

export interface InfoScope {
  window: { startTim: number; endTim: number } | null
  files: ReadonlySet<number> | null
  contexts: ReadonlySet<number> | null
}

const MARKER_TIMESTAMP = 1 // trace.MarkerTimestamp: "*** 2026-10-22T11:35:29.191626+00:00 (PDB1(3))"

/** Distinct non-empty values in order of first appearance. */
function distinct(xs: Iterable<string>): string[] {
  const seen = new Set<string>()
  for (const x of xs) if (x && !seen.has(x)) seen.add(x)
  return [...seen]
}

/** "19.27.0.0.0" → "19.27", "23.26.3.0.0" → "23.26.3", "12.2.0.1.0" → "12.2.0.1". */
export function shortVersion(v: string): string {
  const parts = v.trim().split('.')
  while (parts.length > 2 && parts[parts.length - 1] === '0') parts.pop()
  return parts.join('.')
}

/** The banner "Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production" → "19c Enterprise Edition". */
export function productOf(banner: string): string {
  const m = /^Oracle(?: AI)? Database (\S+)\s+(.*?)\s+Release\b/.exec(banner.trim())
  return m ? `${m[1]} ${m[2]}`.trim() : ''
}

/** Container names by id from the timestamp markers: "PDB1(3)" → 3 → "PDB1". */
function containers(markers: readonly Marker[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const mk of markers) {
    if (mk.kind !== MARKER_TIMESTAMP || !mk.text) continue
    const m = /^(.*)\((\d+)\)$/.exec(mk.text)
    if (m && !out.has(m[2])) out.set(m[2], m[1])
  }
  return out
}

export function traceInfo(doc: InfoDoc, scope: InfoScope): TraceInfo {
  const head = (key: string) => doc.file.headers.find((h) => h.key === key)?.value.trim() ?? ''
  const inScope = (c: Context) => !scope.contexts || scope.contexts.has(c.id)
  const ctxs = doc.contexts.filter(inScope)
  // a PX slave whose coordinator is in scope is that coordinator's work (response.ts pxOut), not a session of its own
  const attached = (c: Context) => !!c.px && (c.parent ?? -1) >= 0 && (!scope.contexts || scope.contexts.has(c.parent!))
  const own = ctxs.filter((c) => !attached(c))
  const names = containers(doc.markers)
  const pdbs = distinct(ctxs.map((c) => names.get(c.containerId) ?? ''))
  const files = doc.file.files ?? []
  const selFiles = scope.files ? files.filter((_, i) => scope.files!.has(i)) : files
  const role = head('Database role')

  let firstWallUs = 0, lastWallUs = 0
  if (scope.window && doc.wallOf(scope.window.startTim)) {
    firstWallUs = doc.wallOf(scope.window.startTim)
    lastWallUs = doc.wallOf(scope.window.endTim)
  } else {
    const timed = selFiles.filter((f) => f.firstWallUs > 0)
    if (scope.files && timed.length) {
      firstWallUs = Math.min(...timed.map((f) => f.firstWallUs))
      lastWallUs = Math.max(...timed.map((f) => f.lastWallUs))
    } else {
      firstWallUs = doc.span.firstWallUs
      lastWallUs = doc.span.lastWallUs
    }
  }

  return {
    firstWallUs, lastWallUs, tzOffsetMin: doc.tzOffsetMin,
    db: head('Database name') || doc.file.instance,
    pdbs: pdbs.length ? pdbs : distinct(names.values()),
    product: productOf(doc.file.headers.find((h) => /^Oracle(?: AI)? Database\b/.test(h.value))?.value ?? ''),
    version: doc.file.version ? shortVersion(doc.file.version) : '',
    role: role && role !== 'PRIMARY' ? role : '',
    instances: distinct(selFiles.length ? selFiles.map((f) => f.instance) : [doc.file.instance]),
    host: doc.file.node.split('.')[0],
    platform: [doc.file.systemName, doc.file.machine].filter(Boolean).join(' '),
    sessions: distinct(own.map((c) => c.sessionId)),
    pxSlaves: ctxs.length - own.length,
    services: distinct(own.map((c) => c.service)),
    modules: distinct(own.map((c) => c.module)),
    actions: distinct(own.map((c) => c.action)),
    drivers: distinct(own.map((c) => c.clientDriver)),
    clientIds: distinct(own.map((c) => c.clientId)),
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

/** The trace's own clock (its time zone), as a UTC Date to read with the getUTC* methods. */
const local = (wallUs: number, tz: number) => new Date(Math.floor(wallUs / 1000) + tz * 60000)
const hms = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
const day = (d: Date, year: boolean) => `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ''}`

/**
 * The scope's wall-clock span in the trace's time zone: `time` "11:35:29 → 11:35:35" (with milliseconds within one second),
 * `date` "Thu 22 Oct 2026 · UTC+00:00" (two days when it crosses midnight: "Thu 22 Oct → Fri 23 Oct 2026"). Null without a
 * wall clock.
 */
export function whenOf(i: Pick<TraceInfo, 'firstWallUs' | 'lastWallUs' | 'tzOffsetMin'>): { time: string; date: string } | null {
  if (!i.firstWallUs) return null
  const a = local(i.firstWallUs, i.tzOffsetMin), b = local(i.lastWallUs || i.firstWallUs, i.tzOffsetMin)
  const sameDay = a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate()
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear()
  const date = sameDay ? day(a, true) : `${day(a, !sameYear)} → ${day(b, true)}`
  // within one second the seconds alone would read "10:39:20 → 10:39:20"
  const t = (d: Date) => (sameDay && hms(a) === hms(b) ? `${hms(d)}.${String(d.getUTCMilliseconds()).padStart(3, '0')}` : hms(d))
  return { time: `${t(a)} → ${t(b)}`, date: `${date} · ${fmtTz(i.tzOffsetMin)}` }
}

/** "a, b, c" with at most `n` names and "+k" for the rest. */
export function someOf(xs: readonly string[], n = 3): string {
  return xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} +${xs.length - n}`
}
