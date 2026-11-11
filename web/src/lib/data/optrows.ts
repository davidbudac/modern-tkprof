// The rows the 10053 viewer shows for the open dump. Formatted dresses the trace's lines (banners as headings, lone rules as hairlines,
// folds closed or open, SQL pretty-printed in place, the plan as a plan); Raw is one row per line, untouched. In a digest (a text that does not
// hold every line) a run of missing lines is one gap row. Every row keeps the line it stands for, so search, landmarks, bookmarks and the line map
// work on rows; every row is one 20 px row of the viewer.
import type { OptFold, OptPlan, OptPlanPred, OptPlanRow, OptText } from './opt'
import type { DumpIndex } from './optindex'
import { formatSqlMemo } from './optsql'

export type OptRow =
  | { t: 'raw'; line: number }
  | { t: 'line'; line: number; fold: OptFold | null }
  | { t: 'fold'; line: number; fold: OptFold }
  | { t: 'head'; line: number; from: number; to: number; text: string; major: boolean; fold: OptFold | null }
  | { t: 'sql'; line: number; text: string; k: number; n: number; fold: OptFold | null }
  | { t: 'planhead'; line: number; plan: OptPlan }
  | { t: 'plancols'; line: number; plan: OptPlan }
  | { t: 'planop'; line: number; op: OptPlanRow; last: boolean }
  | { t: 'planpred'; line: number; op: OptPlanRow; pred: OptPlanPred; last: boolean }
  | { t: 'gap'; line: number; to: number; n: number }

export interface RowModel {
  count: number
  at(i: number): OptRow
  /** the row that stands for a line (the line is clamped to the dump's view range) */
  rowOf(line: number): number
}

export interface RowOpts {
  mode: 'fmt' | 'raw'
  /** is a fold closed (the user's choice over the fold's default) */
  closed(f: OptFold): boolean
  /** the plan shows as the trace's text instead of the plan band */
  planText: boolean
}

/** The text of a run of missing lines, as the gap row reads. */
export function gapText(from: number, to: number): string {
  const n = to - from + 1
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'line' : 'lines'} not in this report (${n === 1 ? 'line' : 'lines'} ${from === to ? from : `${from}-${to}`})`
}

export function buildRows(ix: DumpIndex, text: OptText, o: RowOpts): RowModel {
  const d = ix.dump
  const from = d.viewFrom
  const to = d.viewTo
  const n = ix.n
  const get = (l: number) => text.get(l)

  // Raw, every line there: nothing to build, row k is line from + k
  if (o.mode === 'raw' && text.complete) {
    return { count: n, at: (i) => ({ t: 'raw', line: from + i }), rowOf: (line) => Math.min(n - 1, Math.max(0, line - from)) }
  }

  const rows: OptRow[] = []
  const map = new Int32Array(n).fill(-1)
  const set = (a: number, b: number, r: number) => { for (let i = Math.max(a, from); i <= Math.min(b, to); i++) if (map[i - from] < 0) map[i - from] = r }
  const gapFrom = (i: number) => {
    let j = i
    while (j <= to && get(j) === undefined) j++
    rows.push({ t: 'gap', line: i, to: j - 1, n: j - i })
    set(i, j - 1, rows.length - 1)
    return j
  }

  if (o.mode === 'raw') {
    for (let i = from; i <= to;) {
      if (get(i) === undefined) { i = gapFrom(i); continue }
      rows.push({ t: 'raw', line: i })
      map[i - from] = rows.length - 1
      i++
    }
    return finish(rows, map, from, n)
  }

  const plan = d.plan ?? null
  const planOn = !!plan && !o.planText
  for (let i = from; i <= to;) {
    if (get(i) === undefined) { i = gapFrom(i); continue }
    const fl = ix.foldsAt.get(i)
    let open: OptFold | null = null
    if (fl) {
      const closed = fl.find((f) => o.closed(f))
      if (closed) {
        rows.push({ t: 'fold', line: i, fold: closed })
        set(closed.from, closed.to, rows.length - 1)
        i = closed.to + 1
        continue
      }
      open = fl[0]
    }
    if (planOn && plan && i === plan.from) {
      const r0 = rows.length
      rows.push({ t: 'planhead', line: plan.from + 1, plan })
      rows.push({ t: 'plancols', line: plan.head, plan })
      for (const op of plan.rows) {
        rows.push({ t: 'planop', line: op.line, op, last: false })
        set(op.line, op.line, rows.length - 1)
        const qb = plan.qbs[op.id]
        if (qb) { rows.push({ t: 'planpred', line: qb.line, op, pred: { text: 'qb ' + qb.qb + (qb.alias ? ' / ' + qb.alias : ''), line: qb.line }, last: false }); set(qb.line, qb.line, rows.length - 1) }
        for (const p of plan.preds[op.id] ?? []) { rows.push({ t: 'planpred', line: p.line, op, pred: p, last: false }); set(p.line, p.line, rows.length - 1) }
      }
      const last = rows[rows.length - 1]
      if (last.t === 'planop' || last.t === 'planpred') last.last = true
      set(plan.head, plan.head, r0 + 1)
      set(plan.from, plan.to, r0)
      i = plan.to + 1
      continue
    }
    const role = d.roles[i]
    if (role === 'bt' && d.roles[i + 1] === 'bh' && get(i + 1) !== undefined) {
      const b = ix.banners.get(i + 1)
      if (b) {
        rows.push({ t: 'head', line: i + 1, from: i, to: i + 2, text: b.text, major: isMajor(ix, i), fold: open })
        set(i, i + 2, rows.length - 1)
        i += 3
        continue
      }
    }
    if (role === 'uh') {
      const b = ix.banners.get(i)
      if (b) {
        rows.push({ t: 'head', line: i, from: i, to: i + 1, text: b.text, major: isMajor(ix, i), fold: open })
        set(i, i + 1, rows.length - 1)
        i += 2
        continue
      }
    }
    const v = ix.sqlAt.get(i)
    if (v) {
      const fl2 = formatSqlMemo(v.text)
      const r0 = rows.length
      fl2.forEach((tx, k) => rows.push({ t: 'sql', line: i, text: tx, k, n: fl2.length, fold: k === 0 ? open : null }))
      set(i, i, r0)
      i++
      continue
    }
    rows.push({ t: 'line', line: i, fold: open })
    set(i, i, rows.length - 1)
    i++
  }
  return finish(rows, map, from, n)
}

function finish(rows: OptRow[], map: Int32Array, from: number, n: number): RowModel {
  // a line no row stands for (a plan band's other lines, the line after a heading) takes the row of the line before it
  let prev = 0
  for (let k = 0; k < n; k++) { if (map[k] < 0) map[k] = prev; else prev = map[k] }
  return { count: rows.length, at: (i) => rows[i], rowOf: (line) => map[Math.min(n - 1, Math.max(0, line - from))] }
}

/** A banner that opens a section of level 3 or less (the sunken band); the others are headings. */
function isMajor(ix: DumpIndex, line: number): boolean {
  const n = ix.startAt.get(line)
  return !!n && n.lvl <= 3
}

/** The lines hidden by the folds that are closed: the count the status bar shows. */
export function hiddenByFolds(rm: RowModel): { folds: number; lines: number } {
  let folds = 0
  let lines = 0
  for (let i = 0; i < rm.count; i++) {
    const r = rm.at(i)
    if (r.t === 'fold') { folds++; lines += r.fold.lines - 1 }
  }
  return { folds, lines }
}
