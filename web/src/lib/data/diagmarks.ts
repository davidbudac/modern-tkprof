// The jump between a dump tab (the dump reader) and a 10046 tab, desktop only (docs/PLAN-DIAG.md § The reader: "A jump to the primary formats, no joined
// data"): what names a statement or a session in both, how to find where a dump names it, and the sentence a mark says. The tabs themselves are the
// shell's (desktop/src/workspace); this is the part with no shell in it.
import type { ApiClient } from './client'
import { search } from './lines'

/** What a dump and a SQL trace share: a statement by its sql_id, a session by its `sid.serial` (the 10046 session id). Nothing else is joined. */
export type DiagKey = { sqlId: string } | { session: string }

/** What a shell that holds several traces lets a view ask: whether another open tab holds the key, and the jump to the most recently shown one. */
export interface DiagLink { has(by: DiagKey): boolean; open(by: DiagKey): void }

export const keyText = (by: DiagKey): string => ('sqlId' in by ? by.sqlId : by.session)
export const keyKind = (by: DiagKey): 'statement' | 'session' => ('sqlId' in by ? 'statement' : 'session')

/** "52.41898" as a pair, or null for anything else (a `pid 12`, an empty id). */
export function parseSession(id: string): { sid: number; serial: number } | null {
  const m = /^(\d+)\.(\d+)$/.exec(id.trim())
  return m ? { sid: Number(m[1]), serial: Number(m[2]) } : null
}

/**
 * The regular expressions (the engine's, RE2) for the lines of a dump that name the key, best first. For a statement: `sql_id=` and `SqlId=` followed by it,
 * the forms of a dump's statement, cursor and library handle (a 10046 record in the same file says `sqlid='...'`, which is not one). For a session: the
 * state object and the blocker and waiter lines, `(session) sid: 52 ser: 41898` and `inst: 1, sid: 52, ser: 41898`; then the `*** SESSION ID:(52.41898)` marker,
 * which every part of a file has and so says least. Empty for a session id that is not `sid.serial`.
 */
export function namingRegexes(by: DiagKey): string[] {
  if ('sqlId' in by) return by.sqlId && /^[0-9a-z]+$/i.test(by.sqlId) ? [`(?:sql_id=|SqlId=)${by.sqlId}\\b`] : []
  const s = parseSession(by.session)
  if (!s) return []
  return [`\\bsid: ?${s.sid},? ser: ?${s.serial}\\b`, `\\*\\*\\* SESSION ID:\\(${s.sid}\\.${s.serial}\\)`]
}

/**
 * The first line of the dump file that names the key (a request to the dump tab's engine session: `api/search`, one hit, the best form first), or null. A client
 * that has no text, or a key it cannot search for, gets null: the jump then only switches tabs.
 */
export async function firstLineNaming(client: ApiClient, by: DiagKey, signal?: AbortSignal): Promise<number | null> {
  for (const re of namingRegexes(by)) {
    let line: number | null = null
    try {
      await search(client, { file: 0, q: re, regex: true, caseSensitive: true, from: 1, limit: 1 }, (h) => { if (line === null) line = h.line }, signal)
    } catch (e) {
      if (line === null) throw e
    }
    if (line !== null) return line
  }
  return null
}

/** The tooltip of the dump mark of a 10046 tab and of the 10046 link of a dump tab. */
export const dumpMarkTitle = (by: DiagKey): string => `This ${keyKind(by)} is named in a diagnostic dump open in another tab. Show it there.`
export const traceMarkTitle = (by: DiagKey): string => `This ${keyKind(by)} is in a SQL trace open in another tab. Show it there.`
