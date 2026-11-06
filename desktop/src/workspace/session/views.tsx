import { baseViews, shownViews as shownOf, type SessionViewDef, type State, type TraceDoc } from '@lib'
import { AnnotationsView } from './AnnotationsView'
import { ReportsView } from './ReportsView'
import { CutView } from './cut/CutView'

/**
 * The views of a session tab, in nav order: the lib's view table (`baseViews`, as the standalone shell shows it) and the
 * desktop's own rows of the tab rather than of the trace (Notes 8, Reports 9; group `tools`, set apart in the top bar by a
 * divider and the Tools menu; Cut, without a digit). New per-session views are rows here.
 */
export const sessionViews: readonly SessionViewDef[] = [
  ...baseViews,
  { id: 'annotations', label: 'Notes', key: 8, group: 'tools', render: (d) => <AnnotationsView doc={d} /> },
  { id: 'reports', label: 'Reports', key: 9, group: 'tools', render: (d) => <ReportsView doc={d} /> },
  { id: 'cut', label: 'Cut', group: 'tools', full: true, show: (d) => !!d.slice, render: (d) => <CutView doc={d} /> },
]

/** The rows of `sessionViews` this trace has, in nav order. */
export const shownViews = (doc: TraceDoc, s: State) => shownOf(sessionViews, doc, s)
