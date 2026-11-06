// How much of a plan table fits: the columns that go when the view is narrow, in the order the formatted view drops them.
import type { PLAN_COLUMNS } from './readable'

type PlanKey = (typeof PLAN_COLUMNS)[number]['key']

/**
 * The columns dropped, first to last, as the table gets narrower: Cost, E-Rows, Starts, Writes, then Name (merged into Operation, so the
 * object is still said). Operation, A-Rows, A-Time, Buffers and Reads never go (nor does Id).
 */
export const PLAN_DROP: readonly (PlanKey | 'name')[] = ['cost', 'eRows', 'starts', 'pw', 'name']

/** The columns the first `level` drops hide (level 0: all shown). */
export const hiddenPlanColumns = (level: number): ReadonlySet<string> => new Set(PLAN_DROP.slice(0, Math.max(0, Math.min(PLAN_DROP.length, Math.floor(level)))))

/**
 * The widths the table needs, in digits of the row's font (`ch`) and px: what is fixed (Id, the numbers, A-Time's 12 px of room, its 56 px track and
 * 8 px gap, Writes' 8 px of padding), and what Operation and Name should have at least before another column goes.
 */
const CH = { id: 4.5, starts: 7, eRows: 8, aRows: 8, cost: 7, time: 9, cr: 9, pr: 7, pw: 7, op: 20, opHidden: 26, opMerged: 30, name: 12 }
const PX = { time: 12 + 56 + 8, pw: 8 }

/** The width in px a plan table needs with its first `level` drops: `chw` is a digit of the row's font, `handleW` the PLAN cell before Id. */
export function planNeed(level: number, chw: number, handleW: number): number {
  const hid = hiddenPlanColumns(level)
  const ch = CH.id + CH.aRows + CH.time + CH.cr + CH.pr
    + (hid.has('starts') ? 0 : CH.starts) + (hid.has('eRows') ? 0 : CH.eRows) + (hid.has('cost') ? 0 : CH.cost) + (hid.has('pw') ? 0 : CH.pw)
    + (hid.has('name') ? CH.opMerged : level > 0 ? CH.opHidden + CH.name : CH.op + CH.name) // (the head row says how many are hidden, in Operation's cell)
  return handleW + ch * chw + PX.time + (hid.has('pw') ? 0 : PX.pw)
}

/**
 * How many of the drops a table of `tableW` px needs (0..5): the fewest that make it fit. `chw`: a digit of the row's font in px; `handleW`:
 * the width of the cell before Id. An unmeasured table (0 width) drops nothing.
 */
export function planHidden(tableW: number, chw: number, handleW: number): number {
  if (!(tableW > 0) || !(chw > 0)) return 0
  for (let level = 0; level < PLAN_DROP.length; level++) if (planNeed(level, chw, handleW) <= tableW) return level
  return PLAN_DROP.length
}

/** What the head row says when `level` columns are hidden: `3 columns hidden`, and which they are (the tooltip). */
export function hiddenNote(level: number): { text: string; title: string } | null {
  if (level <= 0) return null
  const names = PLAN_DROP.slice(0, level).map((k) => (k === 'name' ? 'Name (merged into Operation)' : COLUMN_HEAD[k]))
  return { text: `${level} ${level === 1 ? 'column' : 'columns'} hidden`, title: `Hidden to fit: ${names.join(', ')}. Widen the view or close the side panel to see them.` }
}
const COLUMN_HEAD: Record<string, string> = { cost: 'Cost', eRows: 'E-Rows', starts: 'Starts', pw: 'Writes' }
