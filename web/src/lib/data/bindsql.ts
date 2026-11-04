import type { BindRow } from './derive'

/** One `:name` of a statement's text: where it is (`[from, to)` of the text, colon included) and its name without the colon. */
export interface Placeholder { name: string; from: number; to: number }

const IDENT = /[A-Za-z0-9_$#]/

/**
 * The bind placeholders of a SQL or PL/SQL text in the order they appear. String literals (also `q'[...]'`), quoted identifiers and
 * comments are skipped; `:=` and `::` are not placeholders.
 */
export function placeholders(sql: string): Placeholder[] {
  const out: Placeholder[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); i = e < 0 ? n : e + 1; continue }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
    if ((c === 'q' || c === 'Q') && sql[i + 1] === "'" && i + 2 < n && !IDENT.test(sql[i - 1] ?? ' ')) {
      const open = sql[i + 2]
      const close = ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[open] ?? open
      const e = sql.indexOf(close + "'", i + 3)
      i = e < 0 ? n : e + 2
      continue
    }
    if (c === "'") { // '' inside a literal is an escaped quote: the scan just goes on past it
      let j = i + 1
      while (j < n) { if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue } break } j++ }
      i = j + 1
      continue
    }
    if (c === '"') { const e = sql.indexOf('"', i + 1); i = e < 0 ? n : e + 1; continue }
    if (c === ':' && sql[i + 1] !== '=' && sql[i + 1] !== ':' && sql[i - 1] !== ':') {
      let j = i + 1
      if (sql[j] === '"') { const e = sql.indexOf('"', j + 1); j = e < 0 ? n : e + 1 } else while (j < n && IDENT.test(sql[j])) j++
      if (j > i + 1) { out.push({ name: sql.slice(i + 1, j), from: i, to: j }); i = j; continue }
    }
    i++
  }
  return out
}

/** The name a placeholder is matched on: case-insensitive, quoted names as written. */
const key = (name: string) => (name.startsWith('"') ? name : name.toUpperCase())

/**
 * Which placeholder each `Bind#` stands for: `names[pos]`. A SQL statement lists one `Bind#` per occurrence (a name used three
 * times is three binds); a PL/SQL block one per distinct name. The text decides when the counts tell: occurrences when there are as
 * many binds as occurrences, distinct names when there are as many as names, else occurrences (`exact` false).
 */
export function bindNames(sql: string, nBinds: number): { names: string[]; byName: boolean; exact: boolean } {
  const ph = placeholders(sql)
  const all = ph.map((p) => p.name)
  if (nBinds === all.length) return { names: all, byName: false, exact: true }
  const seen = new Set<string>()
  const distinct = all.filter((n) => (seen.has(key(n)) ? false : (seen.add(key(n)), true)))
  if (nBinds === distinct.length) return { names: distinct, byName: true, exact: true }
  return { names: all, byName: false, exact: false }
}

/** Whether Oracle cut the value (it prints `"..."...`): the substitution must say so and never complete it. */
export const truncated = (b: BindRow) => !b.isNull && b.value.endsWith('"...')

/** A string value as written in the trace (`"abc"`) without its quotes; the cut tail of a truncated value is left out. */
function unquote(v: string): string {
  if (v.endsWith('"...')) v = v.slice(0, -4)
  if (v.startsWith('"')) v = v.slice(1)
  if (v.endsWith('"')) v = v.slice(0, -1)
  return v
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`

/** `2026-11-04T10:03:45.120` → its date and time parts for TO_DATE / TO_TIMESTAMP. */
function isoParts(typed: string): { date: string; time: string; frac: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2})(\.\d+)?)?/.exec(typed)
  return m ? { date: m[1], time: m[2] ?? '00:00:00', frac: m[3] ?? '' } : null
}

/** The SQL literal of one bind value, and a note when the trace did not print the whole value. */
export function literalOf(b: BindRow): { sql: string; note?: string } {
  if (b.isNull) return { sql: 'NULL' }
  if (b.dump) return { sql: 'NULL', note: 'the trace printed a memory dump, not a value' }
  if (b.value === '' && !b.typed) return { sql: 'NULL', note: 'the trace printed no value' }
  if (truncated(b)) return { sql: `${sqlString(unquote(b.value))} /* truncated in the trace */`, note: 'Oracle cut the value: only its start is in the trace' }
  const kind = b.kind ?? (b.value.startsWith('"') ? 'string' : /^-?[\d.]+(?:E[+-]?\d+)?$/i.test(b.value) ? 'number' : 'other')
  const typed = b.typed
  switch (kind) {
    case 'number': return { sql: b.value }
    case 'string': return { sql: sqlString(unquote(b.value)) }
    case 'date': {
      const p = typed ? isoParts(typed) : null
      return p ? { sql: `TO_DATE('${p.date} ${p.time}', 'YYYY-MM-DD HH24:MI:SS')` } : { sql: sqlString(unquote(b.value)), note: 'date as the trace printed it' }
    }
    case 'timestamp': {
      const p = typed ? isoParts(typed) : null
      return p ? { sql: `TO_TIMESTAMP('${p.date} ${p.time}${p.frac}', 'YYYY-MM-DD HH24:MI:SS${p.frac ? '.FF' : ''}')` } : { sql: sqlString(unquote(b.value)), note: 'timestamp as the trace printed it' }
    }
    case 'interval':
      if (typed) return { sql: /^-?P\d+Y|^-?P\d+M$/.test(typed) && !typed.includes('D') && !typed.includes('T') ? `TO_YMINTERVAL('${typed}')` : `TO_DSINTERVAL('${typed}')` }
      return { sql: sqlString(unquote(b.value)), note: 'interval as the trace printed it' }
    case 'rowid': return { sql: `CHARTOROWID('${typed || unquote(b.value)}')` }
    case 'raw': return { sql: `HEXTORAW('${unquote(b.value).replace(/\s+/g, '')}')` }
    default: return { sql: b.value.startsWith('"') ? sqlString(unquote(b.value)) : b.value || 'NULL' }
  }
}

/** One placeholder's value in the substituted text. */
export interface SubstBind { pos: number; name: string; sql: string; type: string; note?: string; missing?: boolean }

/**
 * The statement with every placeholder replaced by the literal of its bind (`binds` by `pos`). A bind with no definition of its own
 * ("No oacdef", a repeated name) takes the value of the name's first bind; a placeholder without a bind becomes NULL with a note.
 */
export function substitute(sql: string, binds: readonly BindRow[]): { sql: string; parts: { t: string; pos?: number }[]; binds: SubstBind[]; exact: boolean } {
  const ph = placeholders(sql)
  const { names, byName, exact } = bindNames(sql, binds.length)
  const byPos = new Map(binds.map((b) => [b.pos, b]))
  const valueOf = new Map<string, SubstBind>() // first value of a name
  const list: SubstBind[] = names.map((name, pos) => {
    const b = byPos.get(pos)
    if (!b) return { pos, name, sql: 'NULL', type: '', note: 'no Bind# for this placeholder', missing: true }
    if (b.noDef) {
      const first = valueOf.get(key(name))
      if (first) return { ...first, pos, note: `same value as Bind#${first.pos}` }
    }
    const lit = literalOf(b)
    const s: SubstBind = { pos, name, sql: lit.sql, type: b.type, note: lit.note }
    if (!valueOf.has(key(name))) valueOf.set(key(name), s)
    return s
  })
  const parts: { t: string; pos?: number }[] = []
  let at = 0, occ = 0
  for (const p of ph) {
    const s = byName ? valueOf.get(key(p.name)) ?? list.find((x) => key(x.name) === key(p.name)) : list[occ]
    occ++
    if (p.from > at) parts.push({ t: sql.slice(at, p.from) })
    parts.push(s ? { t: s.sql, pos: s.pos } : { t: `:${p.name}` })
    at = p.to
  }
  if (at < sql.length) parts.push({ t: sql.slice(at) })
  return { sql: parts.map((x) => x.t).join(''), parts, binds: list, exact }
}
