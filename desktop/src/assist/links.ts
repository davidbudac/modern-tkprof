// The links of an assistant answer. `mtkprof:` links are the URL hash of the views (web/src/lib/shell/urlstate.ts, the
// grammar of internal/assist/system_prompt.md): a chip resolves through the urlstate parser and moves the tab's
// store the way Back / Forward do. `https:` links open in the system browser; anything else is not a link.
import { apply, unresolved, type Store, type TraceDoc } from '@lib'

export type LinkHref = { kind: 'mtkprof'; hash: string } | { kind: 'https'; href: string }

/** What a Markdown link's target is, or null when it may not become a link (`javascript:`, `data:`, `http:`, relative, …). */
export function linkOf(raw: string): LinkHref | null {
  const href = raw.trim()
  const m = /^mtkprof:(#?)(.*)$/is.exec(href)
  if (m) return { kind: 'mtkprof', hash: '#' + m[2] }
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return null
  }
  return u.protocol === 'https:' && u.host ? { kind: 'https', href: u.href } : null
}

/** What a chip points at, for its look and its tooltip: the most specific key of the hash. */
export type ChipKind = 'exec' | 'sql' | 'line' | 'event' | 'window' | 'contexts' | 'view'

const KIND_OF: [string, ChipKind][] = [['exec', 'exec'], ['sql', 'sql'], ['line', 'line'], ['ev', 'event'], ['win', 'window'], ['contexts', 'contexts']]

export interface Chip {
  hash: string
  kind: ChipKind
  /** the keys this trace has nothing for (`sql`, `exec`, …); empty when the chip opens */
  unresolved: string[]
}

/** The chip of an `mtkprof:` hash in `doc`. A hash that names nothing known (`#`, `#foo=1`) opens Overview. */
export function chipOf(doc: TraceDoc, hash: string): Chip {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const kind = KIND_OF.find(([k]) => p.has(k))?.[1] ?? 'view'
  return { hash, kind, unresolved: unresolved(doc, hash) }
}

/** The index of the statement a hash's `sql` names (a sql_id, or `@N` for one without), else null; the way urlstate reads it. */
export function statementOf(doc: TraceDoc, sql: string | null | undefined): number | null {
  if (!sql) return null
  const i = sql.startsWith('@') ? (/^@\d+$/.test(sql) ? Number(sql.slice(1)) : -1) : doc.statements.findIndex((x) => x.sqlId === sql)
  return i >= 0 && i < doc.statements.length ? i : null
}

/** Opens the chip's place in the tab's views; false (nothing changes) when it does not resolve. */
export function openChip(store: Store, hash: string): boolean {
  const doc = store.getState().doc
  if (!doc || unresolved(doc, hash).length > 0) return false
  apply(store, doc, hash)
  return true
}

const WORDS: Record<string, string> = {
  view: 'view', sql: 'statement', ev: 'wait event', win: 'time window', exec: 'execution', contexts: 'session',
  files: 'file selection', file: 'file', line: 'line', pivot: 'Pivot setting',
}

/** "Not in this trace: statement, execution". */
export const unresolvedText = (keys: string[]) => `Not in this trace: ${keys.map((k) => WORDS[k] ?? k).join(', ')}`
