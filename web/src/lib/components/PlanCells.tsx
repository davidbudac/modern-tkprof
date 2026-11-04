import { fmtCompact, fmtDur, fmtInt } from '../data/format'
import { PLAN_COLUMNS, type PlanRow } from '../data/readable'

/** The value of a numeric plan column as the cell shows it, and its exact value for the tooltip. */
function cell(r: PlanRow, key: (typeof PLAN_COLUMNS)[number]['key']): { text: string; exact?: string } {
  const v = r[key]
  if (v === undefined) return { text: '' }
  if (key === 'time') return { text: fmtDur(v), exact: `${fmtInt(v)} µs` }
  return { text: fmtCompact(v), exact: fmtInt(v) }
}

/**
 * A STAT line as a row of the plan table: Id, the operation indented by its depth, the object, then the numbers in fixed-width
 * columns, right-aligned (an empty cell where the line has no value), so they line up down the plan. A-Time has a bar of the
 * operation's own time as a share of the whole plan's.
 */
export function PlanCells({ r }: { r: PlanRow }) {
  return (
    <>
      <span className="pc pc-id" title={`id=${r.id} pid=${r.pid}`}>{r.id}</span>
      <span className="pc pc-op" style={{ '--dep': r.depth } as React.CSSProperties} title={r.op}>{r.op}</span>
      <span className="pc pc-name" title={r.name ? `${r.name}${r.obj > 0 ? ` (obj=${r.obj})` : ''}` : undefined}>{r.name ?? ''}</span>
      {PLAN_COLUMNS.map((c) => {
        const v = cell(r, c.key)
        const warn = c.key === 'eRows' && r.off
        const title = `${c.head}${v.exact ? `: ${v.exact}` : ''}${warn ? ` per start, against ${fmtInt(Math.round(r.aRows / Math.max(1, r.starts ?? 1)))} rows per start` : ''}\n${c.title}`
        return (
          <span key={c.key} className={`pc pc-n pc-${c.key}` + (warn ? ' pc-off' : '')} title={title}>
            {c.key === 'time' && r.self !== undefined && r.root ? <i className="pc-self" style={{ '--w': Math.min(1, r.self / r.root).toFixed(3) } as React.CSSProperties} title={`own time ${fmtDur(r.self)} of ${fmtDur(r.root)}`} /> : null}
            {v.text}
          </span>
        )
      })}
    </>
  )
}

/** The plan table's column headers, in the same columns as `PlanCells`. */
export function PlanHeads() {
  return (
    <>
      <span className="pc pc-id">Id</span>
      <span className="pc pc-op">Operation</span>
      <span className="pc pc-name">Name</span>
      {PLAN_COLUMNS.map((c) => <span key={c.key} className={`pc pc-n pc-${c.key}`} title={c.title}>{c.head}</span>)}
    </>
  )
}
