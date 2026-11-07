// SQL pretty-printing for the formatted Lines view's SQL band (wrap mode): the statement as `sql-formatter` lays it out, or the text as the trace has it.
// Only the plsql dialect is imported (the package is side-effect free, so a bundler keeps just that dialect's tables).
import { formatDialect, plsql } from 'sql-formatter'

/** A text longer than this is shown as the trace has it: pretty-printing it would take long and fill the screen. */
export const MAX_PRETTY_CHARS = 20_000
/** The statements whose pretty text is kept (the ones in view, and a few scrolled past). */
const LRU_SIZE = 64

const memo = new Map<string, string>()

/**
 * The statement laid out by `sql-formatter` (plsql dialect: Oracle's placeholders, hints and PL/SQL blocks; keywords keep their case, an
 * indent is 2 spaces, no blank line between the statements of a PL/SQL block). The text as the trace has it when the formatter throws (an unterminated literal, a text it cannot read) or when the
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
    out = formatDialect(text, { dialect: plsql, keywordCase: 'preserve', tabWidth: 2, linesBetweenQueries: 0 })
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
