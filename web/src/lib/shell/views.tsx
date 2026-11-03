import type { ReactNode } from 'react'
import type { State, View } from '../state/store'
import type { TraceDoc } from '../data/doc'
import { BlockMap } from '../views/BlockMap'
import { Compare } from '../views/Compare'
import { Lines } from '../views/Lines'
import { Overview } from '../views/Overview'
import { Pivot } from '../views/Pivot'
import { Sessions } from '../views/Sessions'
import { Statements } from '../views/Statements'
import { Timeline } from '../views/Timeline'
import { Waits } from '../views/Waits'

/**
 * A view of a trace, as both shells show it: one row of the view table, in nav order.
 * `show` hides a view a trace cannot have; `full` views take the whole body (no padding).
 */
export interface SessionViewDef {
  id: View
  label: string
  show?: (doc: TraceDoc, s: State) => boolean
  full?: boolean
  /** `tools`: of the tab rather than views of the trace (the desktop's Notes, Reports); `ViewTabs` leaves them out */
  group?: 'tools'
  /**
   * its digit: ⌘N on macOS, Ctrl+N elsewhere (`viewKeys.ts`); fixed per view, so a hidden view leaves a gap rather than renumbering the rest.
   * Optional: the ten digits are taken, so a newer view has none (Blocks); it is reached by its tab and the ⌥⌘← / ⌥⌘→ steps.
   */
  key?: number
  render: (doc: TraceDoc, s: State) => ReactNode
}

/** The lib's views in nav order. A shell can append its own rows (the desktop adds Notes 8 and Reports 9, group `tools`). Blocks has no digit. */
export const baseViews: readonly SessionViewDef[] = [
  { id: 'compare', label: 'Compare', key: 0, show: (_, s) => !!s.compare, render: (_, s) => s.compare && <Compare data={s.compare} /> },
  { id: 'overview', label: 'Overview', key: 1, render: (d) => <Overview doc={d} /> },
  { id: 'lines', label: 'Trace', key: 2, show: (d, s) => !!d.slice && s.linesApi, full: true, render: (d) => <Lines doc={d} /> },
  { id: 'statements', label: 'Statements', key: 3, full: true, render: (d) => <Statements doc={d} /> },
  { id: 'waits', label: 'Waits', key: 4, render: (d) => <Waits doc={d} /> },
  { id: 'blocks', label: 'Blocks', render: (d) => <BlockMap doc={d} /> }, // no digit: 0 to 9 are taken (docs/DESIGN.md)
  { id: 'timeline', label: 'Timeline', key: 5, render: (d) => <Timeline doc={d} /> },
  { id: 'sessions', label: 'Sessions', key: 6, render: (d) => <Sessions doc={d} /> },
  { id: 'pivot', label: 'Pivot', key: 7, render: (d) => <Pivot doc={d} /> },
]

/** The rows of `views` this trace has, in nav order. */
export const shownViews = (views: readonly SessionViewDef[], doc: TraceDoc, s: State): SessionViewDef[] =>
  views.filter((v) => !v.show || v.show(doc, s))

/** The row to render: the current view when it is shown, else Overview (else the first shown). Rows keep their identity, so it works as a store selector. */
export function currentView(views: readonly SessionViewDef[], doc: TraceDoc, s: State): SessionViewDef {
  const shown = shownViews(views, doc, s)
  return shown.find((v) => v.id === s.view) ?? shown.find((v) => v.id === 'overview') ?? shown[0] ?? views[0]
}
