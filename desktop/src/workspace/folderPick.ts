// The folder picker's pure parts (DESIGN § Opening a folder): the rows of the listed trace files with
// what the engine's peek found, their order and filter, the batches the peeks go out in, and the
// formatting of the traced time. `FolderPicker.tsx` draws them.

import type { ListedFile, TracePeek } from '../engine'
import { baseName } from './traceSet'
import { fileKindOf, kindLabel, type PeekOpt } from './optTabs'

/** What a peek reports: the generated type plus the 10053 fields (`PeekOpt`, until `api.d.ts` has them). */
export type Peek = TracePeek & PeekOpt

/** A listed file and, once it is in, its peek. */
export interface PickRow {
  file: ListedFile
  name: string
  peek: Peek | null
}

export type PickSortKey = 'name' | 'size' | 'start' | 'end' | 'elapsed' | 'sessions'
export interface PickSort {
  key: PickSortKey
  dir: 1 | -1
}

/** Newest first: what an ADR trace folder is usually opened for. */
export const DEFAULT_SORT: PickSort = { key: 'start', dir: -1 }

export const toRows = (files: readonly ListedFile[], peeks: ReadonlyMap<string, Peek>): PickRow[] =>
  files.map((file) => ({ file, name: baseName(file.path), peek: peeks.get(file.path) ?? null }))

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN)

/** The start of a row for sorting: the traced start once peeked, else the file's time. */
const startOf = (r: PickRow) => {
  const t = ms(r.peek?.start)
  return Number.isFinite(t) ? t : ms(r.file.modified)
}
const endOf = (r: PickRow) => {
  const t = ms(r.peek?.end)
  return Number.isFinite(t) ? t : ms(r.file.modified)
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** The rows in the order of `s` (ties by name). */
export function sortRows(rows: readonly PickRow[], s: PickSort): PickRow[] {
  const key: Record<PickSortKey, (r: PickRow) => number> = {
    name: () => 0,
    size: (r) => r.file.size,
    start: startOf,
    end: endOf,
    elapsed: (r) => r.peek?.elapsedUs ?? -1,
    sessions: (r) => r.peek?.sessionCount ?? -1,
  }
  const k = key[s.key]
  return [...rows].sort((a, b) => {
    const d = s.key === 'name' ? collator.compare(a.name, b.name) : (k(a) || 0) - (k(b) || 0)
    return d !== 0 ? s.dir * d : collator.compare(a.name, b.name)
  })
}

/** The peek found neither a SQL trace (10046) nor optimizer (10053) dumps in the file: a background process trace, say. */
export const noTrace = (p: Peek | null) => !!p && !p.error && !p.sqlTrace && fileKindOf(p) === ''

/**
 * The rows the filter keeps: every word of `text` in the file name, a session id, module, action,
 * client id, service, the instance or the kind (`10053`); with `sqlOnly`, not the files the peek found no SQL trace
 * (and no optimizer dump) in (a file not peeked yet, or one that failed, stays).
 */
export function filterRows(rows: readonly PickRow[], text: string, sqlOnly: boolean): PickRow[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter((r) => {
    if (sqlOnly && noTrace(r.peek)) return false
    if (!words.length) return true
    const hay = [r.name, r.peek?.instance, kindLabel(r.peek), ...(r.peek?.sessions ?? []).flatMap((s) => [s.id, s.module, s.action, s.client, s.service])]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** How many files the peek found no SQL trace (and no optimizer dump) in. */
export const notSQL = (rows: readonly PickRow[]) => rows.filter((r) => noTrace(r.peek)).length

/**
 * The peek requests for `files` in this order: several small files per request (up to `maxFiles`,
 * or until they add up to `maxBytes`), a big file alone, so the table fills in steadily.
 */
export function peekBatches(files: readonly ListedFile[], maxFiles = 16, maxBytes = 128 << 20): string[][] {
  const out: string[][] = []
  let cur: string[] = []
  let bytes = 0
  for (const f of files) {
    if (cur.length && (cur.length >= maxFiles || bytes + f.size > maxBytes)) {
      out.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(f.path)
    bytes += f.size
  }
  if (cur.length) out.push(cur)
  return out
}

/** "2026-10-22 11:35:29" in the trace's own zone (the text of the ISO time, not the viewer's clock). */
export function fmtStamp(iso: string | undefined): string {
  if (!iso) return ''
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(iso)
  return m ? `${m[1]} ${m[2]}` : iso
}

/** The end beside its start: the time alone on the same day. */
export function fmtEnd(start: string | undefined, end: string | undefined): string {
  const s = fmtStamp(start), e = fmtStamp(end)
  return s && e && s.slice(0, 10) === e.slice(0, 10) ? e.slice(11) : e
}

/** "0.84 s", "6.5 s", "15 min 37 s", "3 h 5 min", "47 d 6 h" for a span in µs. */
export function fmtSpan(us: number): string {
  if (!(us > 0)) return '–'
  const s = us / 1e6
  if (s < 10) return `${s.toFixed(s < 1 ? 2 : 1)} s`
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`
}

/** The sessions of a peek in one line: "51.14688 mtk_io_waits", "3 sessions: 51.1, 52.7, 60.2", "–". */
export function sessionsText(p: TracePeek): string {
  const ss = p.sessions
  if (!p.sessionCount) return '–'
  if (p.sessionCount === 1) return [ss[0].id, ss[0].module].filter(Boolean).join(' ')
  const ids = ss.slice(0, 3).map((s) => s.id).join(', ')
  return `${p.sessionCount} sessions: ${ids}${p.sessionCount > 3 ? ', …' : ''}`
}

/** Every session of a peek, one per line, for a tooltip. */
export function sessionsTitle(p: TracePeek): string {
  const lines = p.sessions.map((s) => [s.id, s.module && `module ${s.module}`, s.action && `action ${s.action}`, s.client && `client ${s.client}`, s.service && `service ${s.service}`].filter(Boolean).join(' · '))
  if (p.sessionCount > p.sessions.length) lines.push(`… and ${p.sessionCount - p.sessions.length} more`)
  return lines.join('\n')
}

/** What a selection adds up to: files, bytes, the earliest start and latest end of those peeked. */
export function selectionSummary(rows: readonly PickRow[]): { files: number; bytes: number; start?: string; end?: string } {
  let bytes = 0
  let start: string | undefined, end: string | undefined
  for (const r of rows) {
    bytes += r.file.size
    const s = r.peek?.start, e = r.peek?.end
    if (s && (!start || ms(s) < ms(start))) start = s
    if (e && (!end || ms(e) > ms(end))) end = e
  }
  return { files: rows.length, bytes, start, end }
}
