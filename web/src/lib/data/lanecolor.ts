// What the formatted Lines view colours each row's lane band by: the statement (its lane's colour, the default) or another
// dimension of the line, picked in the trace bar. The label in the lane keeps the statement's colour whatever the band shows.
import { CATEGORICAL, MAX_CATEGORIES, categoryTone } from './blocklayout'
import { roleLabel, roleOrder, type Role } from '../components/colors'
import type { LineKind } from './lines'

export type LaneColor = 'stmt' | 'exec' | 'session' | 'depth' | 'op' | 'class' | 'dur' | 'delta' | 'none'

/** The modes in the order the menu lists them: id, menu label, tooltip. */
export const LANE_COLORS: readonly { id: LaneColor; label: string; title: string }[] = [
  { id: 'stmt', label: 'Statement', title: "each statement its own colour, by elapsed rank (recursive SYS SQL and statements past the 14th are grey)" },
  { id: 'exec', label: 'Execution', title: 'the executions of a cursor in turn: where one execution ends and the next starts' },
  { id: 'session', label: 'Session', title: 'the session context the line ran in (session, module, action: the *** lines)' },
  { id: 'depth', label: 'Recursive depth', title: 'the depth of the cursor: top level, recursive SQL, recursive SQL of recursive SQL, …' },
  { id: 'op', label: 'Operation', title: 'what the line is: PARSE, EXEC, FETCH, CLOSE, WAIT, cursor parse, binds, commit, error' },
  { id: 'class', label: 'Wait class', title: "a wait's class (User I/O, Concurrency, Network, Idle, …); calls are CPU" },
  { id: 'dur', label: 'Duration', title: "the line's own time (a call's e=, a wait's ela=): darker is longer, by decade" },
  { id: 'delta', label: 'Δ from the line before', title: 'the time since the timed line before (its own time plus any idle time before it): darker is longer, by decade' },
  { id: 'none', label: 'None', title: 'no colour in the lane' },
]

export const isLaneColor = (v: unknown): v is LaneColor => typeof v === 'string' && LANE_COLORS.some((c) => c.id === v)

/** The upper bounds (µs) of the ramp's steps: below 100 µs, 1 ms, 10 ms, 100 ms, 1 s, and 1 s or more. */
export const DECADES = [100, 1_000, 10_000, 100_000, 1_000_000] as const
const DECADE_LABELS = ['100 µs', '1 ms', '10 ms', '100 ms', '1 s'] as const
const RAMP_MIX = [14, 30, 46, 62, 80, 100] as const

/** The step of the ramp a time falls in: 0 (under 100 µs) … 5 (1 s or more). */
export function decadeStep(us: number): number {
  let k = 0
  while (k < DECADES.length && us >= DECADES[k]) k++
  return k
}

/** The ramp's colour at a step: one hue, paler for shorter times. */
export const rampColor = (step: number) => `color-mix(in oklch, var(--c-userio) ${RAMP_MIX[Math.max(0, Math.min(RAMP_MIX.length - 1, step))]}%, var(--surface-raised))`

/** The operations the Operation mode tells apart: the line labels of each, its legend label and colour token. */
const OPS: readonly { labels: readonly string[]; label: string; token: string }[] = [
  { labels: ['CURSOR'], label: 'cursor parse (PARSING IN CURSOR, SQL text)', token: '--c-sysio' },
  { labels: ['PARSE'], label: 'PARSE', token: '--c-other' },
  { labels: ['EXEC'], label: 'EXEC', token: '--c-cpu' },
  { labels: ['FETCH'], label: 'FETCH', token: '--c-network' },
  { labels: ['CLOSE', 'UNMAP', 'SORT UNMAP'], label: 'CLOSE, UNMAP', token: '--c-idle' },
  { labels: ['WAIT', 'WAIT #0'], label: 'WAIT', token: '--c-userio' },
  { labels: ['BINDS'], label: 'BINDS', token: '--c-concurrency' },
  { labels: ['COMMIT', 'ROLLBACK'], label: 'COMMIT, ROLLBACK', token: '--c-commit' },
  { labels: ['ERROR'], label: 'ERROR', token: '--s-critical' },
]
const OP_TOKEN = new Map(OPS.flatMap((o) => o.labels.map((l) => [l, o.token] as const)))

/** What a line offers the colour modes. */
export interface LaneFacts {
  /** the statement's lane colour (a CSS colour) */
  stmt: string
  kind: LineKind
  /** the readable row's label (PARSE, WAIT, Bind#2, …) */
  label: string
  execNo: number
  /** the session context of the line's cursor, -1 for none */
  ctx: number
  depth: number
  /** the role of the row's time bar: `cpu` for a call, the wait class's for a wait; undefined without a bar */
  role?: Role
  /** the line's own time, µs */
  dur?: number
  /** the time since the timed line before, µs */
  delta?: number
}

const cat = (k: number) => { const t = categoryTone(k); return t.shade === 0 ? `var(${t.token})` : `color-mix(in oklch, var(${t.token}) ${100 - 35 * t.shade}%, var(--surface-raised))` }

/** The band's colour of a line in a mode; undefined for no band (the line has nothing to show in that mode). */
export function laneColorOf(mode: LaneColor, f: LaneFacts): string | undefined {
  switch (mode) {
    case 'stmt': return f.stmt
    case 'none': return undefined
    case 'exec': return f.execNo >= 0 ? `var(${CATEGORICAL[f.execNo % CATEGORICAL.length]})` : undefined
    case 'session': return f.ctx >= 0 ? cat(f.ctx % MAX_CATEGORIES) : undefined
    case 'depth': return cat(Math.min(f.depth, MAX_CATEGORIES - 1))
    case 'op': {
      if (f.kind === 'sql-text' || f.kind === 'end-of-stmt' || f.kind === 'parsing-in-cursor') return 'var(--c-sysio)'
      const token = OP_TOKEN.get(f.label.startsWith('Bind#') ? 'BINDS' : f.label)
      return token ? `var(${token})` : undefined
    }
    case 'class': return f.role ? `var(--c-${f.role})` : undefined
    case 'dur': return f.dur !== undefined ? rampColor(decadeStep(f.dur)) : undefined
    case 'delta': return f.delta !== undefined && f.delta >= 0 ? rampColor(decadeStep(f.delta)) : undefined
  }
}

/** What a mode's colours mean, for the menu's legend; `null` when the colours have no fixed meaning (statements: the overview names them). */
export function laneLegend(mode: LaneColor, sessions: readonly string[] = []): { color: string; label: string }[] | null {
  switch (mode) {
    case 'stmt': case 'none': return null
    case 'exec': return CATEGORICAL.map((t, k) => ({ color: `var(${t})`, label: k === 0 ? `execution 0, ${CATEGORICAL.length}, …` : `execution ${k}, ${k + CATEGORICAL.length}, …` }))
    case 'session': return sessions.slice(0, MAX_CATEGORIES).map((s, k) => ({ color: cat(k), label: s }))
    case 'depth': return [0, 1, 2, 3].map((d) => ({ color: cat(d), label: d === 0 ? 'top level (dep=0)' : `recursive, dep=${d}${d === 3 ? ' and deeper (own colours)' : ''}` }))
    case 'op': return OPS.map((o) => ({ color: `var(${o.token})`, label: o.label }))
    case 'class': return roleOrder.filter((r) => r !== 'unaccounted').map((r) => ({ color: `var(--c-${r})`, label: r === 'cpu' ? 'CPU (calls)' : roleLabel[r] }))
    case 'dur': case 'delta': return RAMP_MIX.map((_, k) => ({
      color: rampColor(k),
      label: k === 0 ? `under ${DECADE_LABELS[0]}` : k === DECADES.length ? `${DECADE_LABELS[k - 1]} or more` : `${DECADE_LABELS[k - 1]} – ${DECADE_LABELS[k]}`,
    }))
  }
}
