// What the call stack and process readings compute from their answers (docs/PLAN-DIAG.md § The readings): the frames with the dump's own ones folded
// into a row, the stack as one line in its two forms, the cursors' groups, the modes of a list of locks, and the lookup of the process a session belongs to
// (so that a blocker named in a dump is a link where its process is in the file). Plain functions: the views draw what these return.
import type { DiagNode, DiagSource } from './diag'
import type { CallStack, DumpCursor, ProcLibObject, StackFrame } from './diagreadings'
import { parseSession } from './diagmarks'

// ---- the frames ----------------------------------------------------------------------------------------------------------------------------------

/** A row of the frames table: a frame, or the one row the dump's own frames are folded into. */
export type FrameRow =
  | { t: 'frame'; frame: StackFrame }
  | { t: 'own'; count: number; first: string; last: string; open: boolean }

/** The leading frames of the dump itself (`own`), as a count and the names of the first and the last, or null when the dump has none. */
export function ownFrames(frames: readonly StackFrame[]): { count: number; first: string; last: string } | null {
  let n = 0
  while (n < frames.length && frames[n].own) n++
  return n === 0 ? null : { count: n, first: frames[0].function, last: frames[n - 1].function }
}

/** The rows to draw: the dump's own frames folded into one row (`ownOpen` lists them after it), then the process's frames, innermost first. */
export function frameRows(frames: readonly StackFrame[], ownOpen: boolean): FrameRow[] {
  const own = ownFrames(frames)
  if (!own) return frames.map((frame) => ({ t: 'frame' as const, frame }))
  const rows: FrameRow[] = [{ t: 'own', count: own.count, first: own.first, last: own.last, open: ownOpen }]
  frames.forEach((frame, i) => { if (i >= own.count || ownOpen) rows.push({ t: 'frame', frame }) })
  return rows
}

/** "+15,725" for a frame's offset, '' for a frame that prints none. */
export const offsetText = (f: StackFrame): string => (f.offset === undefined ? '' : `+${f.offset.toLocaleString('en-US')}`)

/** The stack as one line, as `oradebug short_stack` prints it, with or without the dump's own frames, and how many frames that is. */
export function oneLine(r: Pick<CallStack, 'shortStack' | 'shortStackNoOwn' | 'frames' | 'own'>, includeOwn: boolean): { text: string; frames: number } {
  const text = includeOwn ? r.shortStack : r.shortStackNoOwn
  const own = ownFrames(r.frames)?.count ?? 0
  return { text, frames: includeOwn ? r.frames.length : Math.max(0, r.frames.length - own) }
}

/** How the frames were read, for the line above the table. */
export function framesSourceText(r: Pick<CallStack, 'framesSource' | 'tableAgrees'>): string {
  if (r.framesSource === 'binary') return "from the binary stack dump's frame headers"
  if (r.framesSource === 'table') return 'from the Call Stack Trace table; the dump has no binary stack dump'
  return 'the dump holds no call stack'
}

// ---- the cursors ----------------------------------------------------------------------------------------------------------------------------------

/** The cursors by group and how many the reading counted that it does not list. */
export function cursorGroups(r: Pick<CallStack, 'cursors' | 'cursorsTotal'>): { open: DumpCursor[]; cached: DumpCursor[]; more: number } {
  return {
    open: r.cursors.filter((c) => c.group === 'open'),
    cached: r.cursors.filter((c) => c.group !== 'open'),
    more: Math.max(0, r.cursorsTotal - r.cursors.length),
  }
}

/** A cursor's binds: how many the dump prints and how many of them the reading lists. */
export const bindsMore = (c: DumpCursor): number => Math.max(0, c.bindCount - c.binds.length)

// ---- the process's holds --------------------------------------------------------------------------------------------------------------------------

/** "mode N × 38, mode S × 1" of a list of locks or pins, the commonest mode first. */
export function modeCounts(list: readonly Pick<ProcLibObject, 'mode'>[]): string {
  const m = new Map<string, number>()
  for (const l of list) m.set(l.mode, (m.get(l.mode) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([mode, n]) => `mode ${mode} × ${n}`).join(', ')
}

/** A library object lock or pin by what the dump names it: the object's name, else the statement's sql_id, else the handle. */
export const libLabel = (l: ProcLibObject): string => l.name || (l.sqlId ? `cursor ${l.sqlId}` : `handle ${l.handle}`)

/** Seconds as a short duration ("6.003 s", "58.2 ms"): the reading's times are seconds as the dump prints them. */
export function secs(s: number): string {
  const us = s * 1e6
  const a = Math.abs(us)
  if (a < 1000) return `${Math.round(us)} µs`
  if (a < 1_000_000) return `${(us / 1000).toFixed(a < 10_000 ? 2 : a < 100_000 ? 1 : 0)} ms`
  if (a < 60_000_000) return `${(us / 1e6).toFixed(a < 10_000_000 ? 3 : 2)} s`
  return `${(us / 60e6).toFixed(1)} min`
}

// ---- the process a session belongs to --------------------------------------------------------------------------------------------------------------

const lookups = new WeakMap<DiagSource, Map<string, Promise<string | null>>>()

/**
 * The node of the process state that holds a session's own state object in this file (`(session) sid: 52 ser: 41898`), or null: a client without the text (the
 * standalone report), a session the file has no state object of, a source that cannot locate. Found by a search for the first such line and the chain `source.path`
 * gives for it; the deepest node of the chain that has a process state reading is the answer. Asked once per source and session.
 */
export function processOfSession(source: DiagSource, key: string): Promise<string | null> {
  let m = lookups.get(source)
  if (!m) { m = new Map(); lookups.set(source, m) }
  let p = m.get(key)
  if (!p) {
    p = lookProcess(source, key)
    m.set(key, p)
  }
  return p
}

async function lookProcess(source: DiagSource, key: string): Promise<string | null> {
  const s = parseSession(key)
  if (!s || !source.text) return null
  let line = 0
  try {
    const ac = new AbortController()
    await source.text.search({ q: `\\(session\\) sid: ${s.sid} ser: ${s.serial}\\b`, regex: true, caseSensitive: true, from: 1, limit: 1 }, (h) => { if (!line) line = h.line }, ac.signal)
  } catch { if (!line) return null }
  if (!line) return null
  let chain: DiagNode[]
  try { chain = await source.path({ line }) } catch { return null }
  for (let i = chain.length - 1; i >= 0; i--) if (chain[i].reading === 'procstate') return chain[i].id
  return null
}
