// ---- one-line SQL pretty-printed: clause keywords on new lines, AND / OR of a WHERE on their own lines, subqueries indented; long lists
// broken at their top-level commas. Not a parser: it reads tokens and parentheses only. ------------------------------------------------

const SQL_KW = new Set(('SELECT FROM WHERE AND OR NOT IN EXISTS ANY ALL SOME GROUP BY ORDER HAVING UNION INTERSECT MINUS JOIN LEFT RIGHT OUTER ' +
  'INNER FULL CROSS ON AS CASE WHEN THEN ELSE END NULL IS LIKE BETWEEN DISTINCT WITH CONNECT START PRIOR DESC ASC NULLS FIRST LAST ' +
  'OVER PARTITION ROWNUM LATERAL APPLY FETCH OFFSET ROWS ONLY').split(' '))

function sqlTokens(s) {
  const out = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    let m
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

/** Pretty-prints one statement: returns its lines. */
function formatSql(sql) {
  const tk = sqlTokens(sql.trim())
  const lines = []
  let cur = ''
  const lvl = [{ paren: 0, clause: '' }] // one entry per subquery level: the paren depth it opened at, the clause in force
  let depth = 0
  const ind = (n) => '  '.repeat(n)
  const L = () => lvl.length - 1
  const brk = (indent) => { if (cur.trim()) lines.push(cur.replace(/\s+$/, '')); cur = indent }
  const kwAt = (k) => {
    for (const c of CLAUSE) {
      const parts = c.split(' ')
      let j = k, ok = true
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
  const out = []
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

function splitTop(s) {
  const parts = []
  let d = 0, q = '', start = 0
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

/** Line diff (LCS): [{op: ' ' | '-' | '+', text}] */
function diffLines(a, b) {
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: a[i++] })
    else out.push({ op: '+', text: b[j++] })
  }
  while (i < n) out.push({ op: '-', text: a[i++] })
  while (j < m) out.push({ op: '+', text: b[j++] })
  return out
}

/** SQL text as spans for the painter: keywords, strings, binds, comments. */
function sqlSpans(s) {
  return sqlTokens(s).map((t) => ({ text: t.v, cls: t.t === 'kw' ? 'rd-kw' : t.t === 'str' ? 'rd-str' : t.t === 'bind' ? 'rd-bind' : t.t === 'cmt' ? 'rd-cmt' : '' }))
}
