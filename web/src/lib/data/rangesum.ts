import { LINE_KINDS } from './linecache'
import { fmtDur, fmtInt } from './format'

export interface RangeSum { lines: number; loaded: number; calls: number; callUs: number; cpuUs: number; rows: number; waits: number; waitUs: number; binds: number; errors: number; commits: number }

const BIND_RE = /^\s*Bind#\d+/
const CPU_RE = /[:,]c=(-?\d+)/
const ELA_RE = /[:,]e=(-?\d+)/
const ROWS_RE = /[:,]r=(-?\d+)/
const WAIT_RE = /' ela=\s*(-?\d+)/

const numOf = (re: RegExp, text: string): number => { const m = re.exec(text); return m ? Number(m[1]) : 0 }

/** Sums over lines from..to (inclusive) of the loaded pages; `loaded` counts the lines that were available (unloaded lines are skipped). */
export function summarizeRange(cache: { line(n: number): { text: string; kind: number } | undefined }, from: number, to: number): RangeSum {
  const a = Math.min(from, to), b = Math.max(from, to)
  const s: RangeSum = { lines: b - a + 1, loaded: 0, calls: 0, callUs: 0, cpuUs: 0, rows: 0, waits: 0, waitUs: 0, binds: 0, errors: 0, commits: 0 }
  for (let n = a; n <= b; n++) {
    const l = cache.line(n)
    if (!l) continue
    s.loaded++
    switch (LINE_KINDS[l.kind]) {
      case 'call':
        s.calls++
        s.callUs += numOf(ELA_RE, l.text); s.cpuUs += numOf(CPU_RE, l.text); s.rows += numOf(ROWS_RE, l.text)
        break
      case 'wait': s.waits++; s.waitUs += numOf(WAIT_RE, l.text); break
      case 'bind-line': if (BIND_RE.test(l.text)) s.binds++; break
      case 'error': case 'parse-error': s.errors++; break
      case 'xctend': s.commits++; break
    }
  }
  return s
}

const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`

/** One line for the status bar: "12 lines · 3 calls 1.2 ms (CPU 0.8 ms) · 4 waits 8.1 ms · 12 rows", omitting zero groups; adds "(N not loaded)" when loaded < lines. */
export function describeRange(s: RangeSum): string {
  const parts = [plural(s.lines, 'line')]
  if (s.calls > 0) parts.push(`${plural(s.calls, 'call')} ${fmtDur(s.callUs)} (CPU ${fmtDur(s.cpuUs)})`)
  if (s.waits > 0) parts.push(`${plural(s.waits, 'wait')} ${fmtDur(s.waitUs)}`)
  if (s.rows > 0) parts.push(plural(s.rows, 'row'))
  if (s.binds > 0) parts.push(plural(s.binds, 'bind'))
  if (s.errors > 0) parts.push(plural(s.errors, 'error'))
  if (s.commits > 0) parts.push(plural(s.commits, 'commit'))
  let out = parts.join(' · ')
  if (s.loaded < s.lines) out += ` (${fmtInt(s.lines - s.loaded)} not loaded)`
  return out
}
