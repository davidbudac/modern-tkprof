import { fmtCompact, fmtDur, fmtInt } from '../data/format'
import { PLAN_COLUMNS, type PlanRow } from '../data/readable'
import { hiddenNote, hiddenPlanColumns } from '../data/planlayout'

/** The value of a numeric plan column as the cell shows it, and its exact value for the tooltip. */
function cell(r: PlanRow, key: (typeof PLAN_COLUMNS)[number]['key']): { text: string; exact?: string } {
  const v = r[key]
  if (v === undefined) return { text: '' }
  if (key === 'time') return { text: fmtDur(v), exact: `${fmtInt(v)} µs` }
  return { text: fmtCompact(v), exact: fmtInt(v) }
}

/**
 * A STAT line as a row of the plan table: Id, the operation indented by its depth, the object, then the numbers in fixed-width
 * columns, right-aligned (an empty cell where the line has no value), so they line up down the plan. A-Time is its number after a
 * 56 px track whose fill is the operation's own time as a share of the whole plan's; the cell of an operation that took 1 % of the traced
 * time or more is a hot spot's. `hide`: how many of the columns that go first (`PLAN_DROP`) the view is too narrow for; a hidden Name is
 * said after the operation.
 */
export function PlanCells({ r, hide = 0 }: { r: PlanRow; hide?: number }) {
  const hid = hiddenPlanColumns(hide)
  const named = hid.has('name') && r.name
  return (
    <>
      <span className="pc pc-id" title={`id=${r.id} pid=${r.pid}`}>{r.id}</span>
      <span className="pc pc-op" style={{ '--dep': r.depth } as React.CSSProperties} title={named ? `${r.op} ${r.name}` : r.op}>{r.op}{named && <span className="pc-oname">{r.name}</span>}</span>
      {!hid.has('name') && <span className="pc pc-name" title={r.name ? `${r.name}${r.obj > 0 ? ` (obj=${r.obj})` : ''}` : undefined}>{r.name ?? ''}</span>}
      {PLAN_COLUMNS.filter((c) => !hid.has(c.key)).map((c) => {
        const v = cell(r, c.key)
        const warn = c.key === 'eRows' && r.off
        const hot = c.key === 'time' && r.hot
        const title = `${c.head}${v.exact ? `: ${v.exact}` : ''}${warn ? ` per start, against ${fmtInt(Math.round(r.aRows / Math.max(1, r.starts ?? 1)))} rows per start` : ''}${hot ? '\na hot spot: its own time is 1 % of the traced time or more' : ''}\n${c.title}`
        return (
          <span key={c.key} className={`pc pc-n pc-${c.key}` + (warn ? ' pc-off' : '') + (hot ? ' pc-hot' : '')} title={title}>
            {c.key === 'time'
              ? <>
                {r.self !== undefined && r.root ? <span className="pc-trk" title={`own time ${fmtDur(r.self)} of ${fmtDur(r.root)}`}><i className="pc-self" style={{ '--w': Math.min(1, r.self / r.root).toFixed(3) } as React.CSSProperties} /></span> : null}
                <span className="tnum">{v.text}</span>
              </>
              : v.text}
          </span>
        )
      })}
    </>
  )
}

/** The plan table's column headers, in the same columns as `PlanCells`; with columns hidden, Operation's cell says how many. */
export function PlanHeads({ hide = 0 }: { hide?: number }) {
  const hid = hiddenPlanColumns(hide)
  const note = hiddenNote(hide)
  return (
    <>
      <span className="pc pc-id">Id</span>
      <span className="pc pc-op"><span className="pc-oplabel">Operation</span>{note && <small className="pc-hid" title={note.title}>{note.text}</small>}</span>
      {!hid.has('name') && <span className="pc pc-name">Name</span>}
      {PLAN_COLUMNS.filter((c) => !hid.has(c.key)).map((c) => (
        <span key={c.key} className={`pc pc-n pc-${c.key}`} title={c.title}>{c.head}{c.key === 'time' && <small> (bar: self)</small>}</span>
      ))}
    </>
  )
}
