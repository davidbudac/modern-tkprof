// SQL pretty-printing for the formatted Lines view's SQL band (wrap mode): the statement as `sql-formatter` lays it out, or the text as the trace has it.
// Only the plsql dialect is imported (the package is side-effect free, so a bundler keeps just that dialect's tables).
import { formatDialect, plsql } from 'sql-formatter'

/** A text longer than this is shown as the trace has it: pretty-printing it would take long and fill the screen. */
export const MAX_PRETTY_CHARS = 20_000
/** The statements whose pretty text is kept (the ones in view, and a few scrolled past). */
const LRU_SIZE = 64

const memo = new Map<string, string>()

/**
 * Words that can stand before a `(` that is not an argument list (a clause, an operator, a definition): the formatter's space after them stays, and so does the one after
 * the name they define (`INSERT INTO t (a, b)`, `CREATE TABLE t (`, `JOIN t ON (`). Upper case.
 */
const BEFORE_PAREN = new Set([
  'IN', 'NOT', 'AND', 'OR', 'EXISTS', 'AS', 'FROM', 'VALUES', 'VALUE', 'TABLE', 'PARTITION', 'SUBPARTITION', 'ON', 'USING', 'SELECT', 'WHERE', 'SET', 'BY', 'WHEN', 'THEN', 'ELSE', 'ELSIF',
  'CASE', 'IS', 'NULL', 'ALL', 'ANY', 'SOME', 'UNION', 'MINUS', 'INTERSECT', 'JOIN', 'INTO', 'WITH', 'HAVING', 'OVER', 'ORDER', 'GROUP', 'BETWEEN', 'LIKE', 'RETURN', 'RETURNING', 'IF',
  'LOOP', 'WHILE', 'FOR', 'BEGIN', 'DECLARE', 'EXCEPTION', 'CREATE', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'AT', 'OF', 'TO', 'CONNECT', 'START', 'PRIOR', 'DISTINCT', 'UNIQUE', 'KEY',
  'REFERENCES', 'CONSTRAINT', 'PRIMARY', 'FOREIGN', 'CHECK', 'DEFAULT', 'INDEX', 'VIEW', 'TYPE', 'OBJECT', 'ROW', 'ROWS', 'CURSOR', 'OPEN', 'FETCH', 'BULK', 'COLLECT', 'FORALL', 'EXECUTE',
  'IMMEDIATE', 'KEEP', 'LAST', 'FIRST', 'NEXT', 'FUNCTION', 'PROCEDURE', 'PACKAGE', 'TRIGGER', 'SEQUENCE', 'ADD', 'MODIFY', 'DROP', 'COLUMN', 'LATERAL', 'APPLY', 'WITHIN', 'ESCAPE', 'LOCK',
  'DUAL', 'SAMPLE', 'ONLY', 'AFTER', 'BEFORE', 'EACH', 'INSTEAD', 'ROLLUP', 'CUBE', 'GROUPING', 'SETS', 'MODEL', 'PIVOT', 'UNPIVOT', 'XMLTABLE', 'XMLQUERY', 'USER', 'THE', 'RETURNS',
])
/** The words after which an identifier is the object being named (a table, a view, a type), so the list that follows it is a column list or a definition, not an argument list. Upper case. */
const NAMES_OBJECT = new Set(['INTO', 'TABLE', 'VIEW', 'INDEX', 'FROM', 'JOIN', 'UPDATE', 'TYPE', 'FUNCTION', 'PROCEDURE', 'PACKAGE', 'TRIGGER', 'SEQUENCE', 'REFERENCES', 'ON', 'ALTER', 'MERGE', 'TRUNCATE', 'LOCK', 'WITH'])

/** The end (exclusive) of the string, quoted identifier or comment that starts at `i` of `s`, or `i` when none starts there. */
function literalEnd(s: string, i: number): number {
  const c = s[i]
  const close = (from: number, end: string) => { const k = s.indexOf(end, from); return k < 0 ? s.length : k + end.length }
  if (c === '-' && s[i + 1] === '-') { const k = s.indexOf('\n', i); return k < 0 ? s.length : k }
  if (c === '/' && s[i + 1] === '*') return close(i + 2, '*/')
  if ((c === 'q' || c === 'Q') && s[i + 1] === "'" && i + 2 < s.length && !/[\w$#]/.test(s[i - 1] ?? ' ')) { // q'[ ... ]': alternative quoting
    const open = s[i + 2], shut = ({ '[': ']', '{': '}', '<': '>', '(': ')' } as Record<string, string>)[open] ?? open
    return close(i + 3, shut + "'")
  }
  if (c === "'" || c === '"') {
    let k = i + 1
    for (;;) {
      k = s.indexOf(c, k)
      if (k < 0) return s.length
      if (s[k + 1] === c) { k += 2; continue } // a doubled quote is inside the literal
      return k + 1
    }
  }
  return i
}

/**
 * Takes the space out between a name and its argument list: `dbms_application_info.set_action ('x')` is `set_action('x')`, as `max(x)` already is. The formatter lays a call out
 * with a space unless it knows the function. A name after a word that makes it an object (`INSERT INTO t (a, b)`, `CREATE TABLE t (`), and a keyword before its `(` (`IN (`, `VALUES (`,
 * `AND (`, `EXISTS (`), keep the space. Strings, quoted identifiers and comments are left alone.
 */
export function tightCalls(text: string): string {
  let out = ''
  let code = '' // the code since the last literal
  const flush = () => {
    out += code.replace(/([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)*)[ \t]\(/g, (m, name: string, at: number) => {
      const last = name.slice(name.lastIndexOf('.') + 1).toUpperCase()
      if (!name.includes('.') && BEFORE_PAREN.has(last)) return m
      const before = /([A-Za-z_][\w$#]*)\s+$/.exec(code.slice(Math.max(0, at - 40), at))?.[1].toUpperCase()
      if (before && NAMES_OBJECT.has(before)) return m
      return name + '('
    })
    code = ''
  }
  for (let i = 0; i < text.length;) {
    const end = literalEnd(text, i)
    if (end > i) { flush(); out += text.slice(i, end); i = end } else { code += text[i]; i++ }
  }
  flush()
  return out
}

/**
 * The statement laid out by `sql-formatter` (plsql dialect: Oracle's placeholders, hints and PL/SQL blocks; keywords keep their case, an
 * indent is 2 spaces, no blank line between the statements of a PL/SQL block, no space between a function's name and its `(`: `tightCalls`). The text as the trace has it when the formatter throws (an unterminated literal, a text it cannot read) or when the
 * text is over `MAX_PRETTY_CHARS`. Memoised per text in a small LRU: the rows of a view ask for the same few statements again on every render.
 */
export function prettySql(text: string): string {
  if (text.length > MAX_PRETTY_CHARS) return text
  const hit = memo.get(text)
  if (hit !== undefined) {
    memo.delete(text)
    memo.set(text, hit) // the most recently used goes last
    return hit
  }
  let out: string
  try {
    out = tightCalls(formatDialect(text, { dialect: plsql, keywordCase: 'preserve', tabWidth: 2, linesBetweenQueries: 0 }))
  } catch {
    out = text
  }
  memo.set(text, out)
  if (memo.size > LRU_SIZE) memo.delete(memo.keys().next().value as string)
  return out
}

/** The pretty-printed statement's lines for display: no blank line at the end (the trace's text often ends with a newline). */
export function prettyLines(text: string): string[] {
  const lines = prettySql(text).replace(/\r\n?/g, '\n').split('\n')
  let n = lines.length
  while (n > 1 && lines[n - 1].trim() === '') n--
  return n === lines.length ? lines : lines.slice(0, n)
}

/** The memo, for tests: its size, and emptying it. */
export const prettyMemo = { size: () => memo.size, clear: () => memo.clear(), has: (text: string) => memo.has(text), limit: LRU_SIZE }
