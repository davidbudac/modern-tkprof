// One-line SQL pretty-printed for the 10053 reader: clause keywords on new lines, AND / OR of a WHERE on their own lines, subqueries
// indented, long lists broken at their top-level commas. Not a parser: it reads tokens and parentheses only.
//
// A port of docs/mockups/10053-reader/src/sqlfmt.js, which the Go side (the text report) ports as well, so the viewer and the digest print the same
// lines. It is not lib/data/sqlformat.ts (the Trace pane's SQL band, `sql-formatter`): this one is the 10053 reader's own, kept equal to Go's.

const SQL_KW = new Set(('SELECT FROM WHERE AND OR NOT IN EXISTS ANY ALL SOME GROUP BY ORDER HAVING UNION INTERSECT MINUS JOIN LEFT RIGHT OUTER ' +
  'INNER FULL CROSS ON AS CASE WHEN THEN ELSE END NULL IS LIKE BETWEEN DISTINCT WITH CONNECT START PRIOR DESC ASC NULLS FIRST LAST ' +
  'OVER PARTITION ROWNUM LATERAL APPLY FETCH OFFSET ROWS ONLY').split(' '))

export type SqlTokenType = 'qid' | 'str' | 'cmt' | 'ws' | 'bind' | 'kw' | 'word' | 'num' | 'p'
export interface SqlToken { t: SqlTokenType; v: string }

/** The tokens of a statement: quoted identifiers, strings, comments, white space, binds, words (keywords apart), numbers, punctuation. */
export function sqlTokens(s: string): SqlToken[] {
  const out: SqlToken[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    let m: RegExpExecArray | null
    if (c === '"') { const j = s.indexOf('"', i + 1); const e = j < 0 ? s.length : j + 1; out.push({ t: 'qid', v: s.slice(i, e) }); i = e }
    else if (c === "'") { let j = i + 1; while (j < s.length && !(s[j] === "'" && s[j + 1] !== "'")) j += s[j] === "'" ? 2 : 1; out.push({ t: 'str', v: s.slice(i, j + 1) }); i = j + 1 }
    else if (s.startsWith('/*', i)) { const j = s.indexOf('*/', i + 2); const e = j < 0 ? s.length : j + 2; out.push({ t: 'cmt', v: s.slice(i, e) }); i = e }
    else if (s.startsWith('--', i)) { const j = s.indexOf('\n', i); const e = j < 0 ? s.length : j; out.push({ t: 'cmt', v: s.slice(i, e) }); i = e }
    else if (/\s/.test(c)) { let j = i; while (j < s.length && /\s/.test(s[j])) j++; out.push({ t: 'ws', v: s.slice(i, j) }); i = j }
    else if ((m = /^:[A-Za-z0-9_]+/.exec(s.slice(i, i + 40)))) { out.push({ t: 'bind', v: m[0] }); i += m[0].length }
    else if ((m = /^[A-Za-z_$#][\w$#]*/.exec(s.slice(i, i + 200)))) { out.push({ t: SQL_KW.has(m[0].toUpperCase()) ? 'kw' : 'word', v: m[0] }); i += m[0].length }
    else if ((m = /^\d+(\.\d+)?(e[+-]?\d+)?/i.exec(s.slice(i, i + 40)))) { out.push({ t: 'num', v: m[0] }); i += m[0].length }
    else { out.push({ t: 'p', v: c }); i++ }
  }
  return out
}

const CLAUSE = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'UNION ALL', 'UNION', 'INTERSECT', 'MINUS', 'CONNECT BY', 'START WITH']

interface Level { paren: number; clause: string; sub?: boolean }

/** Pretty-prints one statement: returns its lines. */
export function formatSql(sql: string): string[] {
  const tk = sqlTokens(sql.trim())
  const lines: string[] = []
  let cur = ''
  const lvl: Level[] = [{ paren: 0, clause: '' }] // one entry per subquery level: the paren depth it opened at, the clause in force
  let depth = 0
  const ind = (n: number) => '  '.repeat(n)
  const L = () => lvl.length - 1
  const brk = (indent: string) => { if (cur.trim()) lines.push(cur.replace(/\s+$/, '')); cur = indent }
  const kwAt = (k: number): { c: string; end: number } | null => {
    for (const c of CLAUSE) {
      const parts = c.split(' ')
      let j = k
      let ok = true
      for (let p = 0; p < parts.length; p++) {
        while (tk[j] && tk[j].t === 'ws') j++
        if (!tk[j] || tk[j].v.toUpperCase() !== parts[p]) { ok = false; break }
        j++
      }
      if (ok) return { c, end: j }
    }
    return null
  }
  for (let k = 0; k < tk.length; k++) {
    const t = tk[k]
    const top = lvl[L()]
    if (t.t === 'ws') { if (cur && !cur.endsWith(' ')) cur += ' '; continue }
    if (t.t === 'kw' || t.t === 'word') {
      const cl = depth === top.paren ? kwAt(k) : null
      if (cl) {
        brk(ind(2 * L()))
        cur += cl.c
        top.clause = cl.c
        k = cl.end - 1
        continue
      }
      const u = t.v.toUpperCase()
      if ((u === 'AND' || u === 'OR') && depth === top.paren && ['WHERE', 'HAVING', 'START WITH', 'CONNECT BY'].includes(top.clause)) {
        brk(ind(2 * L() + 1)); cur += u; continue
      }
    }
    if (t.v === '(') {
      // a subquery: the next significant token is SELECT
      let j = k + 1
      while (tk[j] && tk[j].t === 'ws') j++
      depth++
      if (tk[j] && tk[j].v.toUpperCase() === 'SELECT') { cur += '('; lvl.push({ paren: depth, clause: '', sub: true }); continue }
      cur += '('; continue
    }
    if (t.v === ')') {
      if (lvl.length > 1 && lvl[L()].paren === depth) { lvl.pop(); cur = cur.replace(/\s+$/, '') + ')'; depth--; continue }
      depth--; cur = cur.replace(/\s+$/, '') + ')'; continue
    }
    if (t.v === ',' && depth === top.paren && top.clause === 'FROM') { cur += ','; brk(ind(2 * L() + 1)); continue }
    cur += t.v
  }
  brk('')
  // long SELECT / GROUP BY / ORDER BY lines: one item per line at their top-level commas
  const out: string[] = []
  for (const l of lines) {
    if (l.length <= 96) { out.push(l); continue }
    const m = /^(\s*)(SELECT|GROUP BY|ORDER BY)\s/.exec(l)
    if (!m) { out.push(l); continue }
    const parts = splitTop(l.slice(m[0].length))
    if (parts.length < 2) { out.push(l); continue }
    out.push(m[1] + m[2] + ' ' + parts[0] + ',')
    parts.slice(1).forEach((p, k) => out.push(m[1] + ' '.repeat(m[2].length + 1) + p.trim() + (k < parts.length - 2 ? ',' : '')))
  }
  return out
}

/** `s` cut at its top-level commas (not inside parentheses or quotes), each part trimmed. */
export function splitTop(s: string): string[] {
  const parts: string[] = []
  let d = 0
  let q = ''
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) { if (c === q) q = ''; continue }
    if (c === '"' || c === "'") { q = c; continue }
    if (c === '(') d++
    else if (c === ')') d--
    else if (c === ',' && d === 0) { parts.push(s.slice(start, i)); start = i + 1 }
  }
  parts.push(s.slice(start))
  return parts.map((p) => p.trim())
}

export interface DiffLine { op: ' ' | '-' | '+'; text: string }

/** A line diff (longest common subsequence): the lines of `a` and `b` in order, each kept (' '), taken out ('-') or put in ('+'). */
export function diffLines(a: readonly string[], b: readonly string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: a[i++] })
    else out.push({ op: '+', text: b[j++] })
  }
  while (i < n) out.push({ op: '-', text: a[i++] })
  while (j < m) out.push({ op: '+', text: b[j++] })
  return out
}

export interface SqlSpan { text: string; cls: string }

/** SQL text as spans for the painter: keywords, strings, binds, comments get a class. */
export function sqlSpans(s: string): SqlSpan[] {
  return sqlTokens(s).map((t) => ({ text: t.v, cls: t.t === 'kw' ? 'opt-kw' : t.t === 'str' ? 'opt-str' : t.t === 'bind' ? 'opt-bind' : t.t === 'cmt' ? 'opt-cmt' : '' }))
}

const memo = new Map<string, string[]>()
const MEMO_MAX = 400

/** `formatSql`, remembered per text (the viewer asks for the same few statements on every repaint). */
export function formatSqlMemo(sql: string): string[] {
  let r = memo.get(sql)
  if (!r) {
    r = formatSql(sql)
    memo.set(sql, r)
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string)
  }
  return r
}
