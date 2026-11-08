import type { ReactNode } from 'react'

/**
 * Line icons for icon-only buttons (lucide shapes, ISC). Decorative: the button carries the name (`aria-label`) and the tooltip
 * (`title`). 1em square; inside `button.icon-btn` (app.css) the box is one line tall, so the button matches its text neighbours.
 */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

export const CopyIcon = () => (
  <Icon>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </Icon>
)

/** Shown in place of `CopyIcon` for a moment after a copy. */
export const CheckIcon = () => <Icon><path d="M20 6 9 17l-5-5" /></Icon>

/** Closes a pane or a panel. */
export const CloseIcon = () => <Icon><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>

/** A funnel: the statement filter (the picker's filter toggle and the toolbar's filter chip). */
export const FunnelIcon = () => <Icon><path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z" /></Icon>

// ---- the Trace pane's side panel: its tabs, its Display toggles, its buttons ---------------------------------------------------------------------------------------------------

/** The Line tab: a text cursor (the selected line, translated). */
export const TextCursorIcon = () => <Icon><path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1" /><path d="M7 22h1a4 4 0 0 0 4-4v-1" /><path d="M7 2h1a4 4 0 0 1 4 4v1" /></Icon>

/** The Outline tab: a tree of nodes. */
export const ListTreeIcon = () => <Icon><path d="M21 12h-8" /><path d="M21 6H8" /><path d="M21 18h-8" /><path d="M3 6v4c0 1.1.9 2 2 2h3" /><path d="M3 10v6c0 1.1.9 2 2 2h3" /></Icon>

/** The Hits tab: a magnifying glass. */
export const SearchIcon = () => <Icon><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Icon>

/** The Bookmarks tab. */
export const BookmarkIcon = () => <Icon><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" /></Icon>

/** The As run tab: the statement as it ran (a play button). */
export const PlayCircleIcon = () => <Icon><circle cx="12" cy="12" r="10" /><path d="m10 8 6 4-6 4z" /></Icon>

/** The Display tab: sliders. */
export const SlidersHorizontalIcon = () => (
  <Icon>
    <path d="M21 4h-7" /><path d="M10 4H3" /><path d="M21 12h-9" /><path d="M8 12H3" /><path d="M21 20h-5" /><path d="M12 20H3" /><path d="M14 2v4" /><path d="M8 10v4" /><path d="M16 18v4" />
  </Icon>
)

/** Wrap long lines. */
export const WrapTextIcon = () => <Icon><path d="M3 6h18" /><path d="M3 12h15a3 3 0 1 1 0 6h-4" /><path d="m16 16-2 2 2 2" /><path d="M3 18h7" /></Icon>

/** Heat bars: horizontal bars of different lengths. */
export const BarsIcon = () => <Icon><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="M7 16h8" /><path d="M7 11h12" /><path d="M7 6h3" /></Icon>

/** The line map: lines on the left, the strip beside the scroll bar on the right. */
export const LineMapIcon = () => <Icon><path d="M3 6h8" /><path d="M3 12h6" /><path d="M3 18h8" /><rect x="15" y="3" width="6" height="18" rx="1.5" /><path d="M15 9h6" /><path d="M15 15h6" /></Icon>

/** Reference links. */
export const LinkIcon = () => <Icon><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></Icon>

/** Hints: a light bulb. */
export const LightbulbIcon = () => <Icon><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" /><path d="M9 18h6" /><path d="M10 22h4" /></Icon>

/** Clock time. */
export const ClockIcon = () => <Icon><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Icon>

/** Δ: a triangle (the time delta, the Δ filter). */
export const TriangleIcon = () => <Icon><path d="M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z" /></Icon>

/** A column at the start of the row (the Δ column). */
export const PanelLeftIcon = () => <Icon><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></Icon>

/** Fold repeats: a loop. */
export const RepeatIcon = () => <Icon><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></Icon>

/** Off: a circle with a bar through it. */
export const BanIcon = () => <Icon><circle cx="12" cy="12" r="10" /><path d="m4.9 4.9 14.2 14.2" /></Icon>

/** Highlight: a highlighter pen. */
export const HighlighterIcon = () => <Icon><path d="m9 11-6 6v3h9l3-3" /><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" /></Icon>

/** Fold all BINDS: a variable, (x). */
export const VariableIcon = () => <Icon><path d="M8 21s-4-3-4-9 4-9 4-9" /><path d="M16 3s4 3 4 9-4 9-4 9" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></Icon>

/** Fold all STAT: a table (the plan). */
export const TableIcon = () => <Icon><path d="M12 3v18" /><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /></Icon>

/** Unfold all: arrows apart over a dashed line. */
export const UnfoldIcon = () => <Icon><path d="M12 22v-6" /><path d="M12 8V2" /><path d="M4 12H2" /><path d="M10 12H8" /><path d="M16 12h-2" /><path d="M22 12h-2" /><path d="m15 19-3 3-3-3" /><path d="m15 5-3-3-3 3" /></Icon>

/** Previous (up) and next (down); previous (left) and next (right). */
export const ChevronUpIcon = () => <Icon><path d="m18 15-6-6-6 6" /></Icon>
export const ChevronDownIcon = () => <Icon><path d="m6 9 6 6 6-6" /></Icon>
export const ChevronLeftIcon = () => <Icon><path d="m15 18-6-6 6-6" /></Icon>
export const ChevronRightIcon = () => <Icon><path d="m9 18 6-6-6-6" /></Icon>

/** Group by: stacked layers. */
export const LayersIcon = () => <Icon><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" /><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" /><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" /></Icon>

/** Remove. */
export const TrashIcon = () => <Icon><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></Icon>

/** A note: a pencil. */
export const PencilIcon = () => <Icon><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></Icon>

/** Follow the pointer: a mouse pointer. */
export const PointerIcon = () => <Icon><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" /></Icon>

/** Run again. */
export const RotateIcon = () => <Icon><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></Icon>

/** The lanes of the formatted view (the chip that says what colours them): three vertical bars. */
export const LanesIcon = () => <Icon><path d="M5 4v16" /><path d="M12 4v16" /><path d="M19 4v16" /></Icon>

/** Zoom in / out (the I/O map's zoom buttons). */
export const ZoomInIcon = () => <Icon><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><path d="M11 8v6" /><path d="M8 11h6" /></Icon>
export const ZoomOutIcon = () => <Icon><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><path d="M8 11h6" /></Icon>

/** The whole range again (reset a zoom): four corners. */
export const ScanIcon = () => <Icon><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /></Icon>

/** Back one step (the previous zoom). */
export const UndoIcon = () => <Icon><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11" /></Icon>

/** Histograms (the distributions tab). */
export const ChartColumnIcon = () => <Icon><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" /></Icon>

/** Database objects. */
export const DatabaseIcon = () => <Icon><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></Icon>

/** A list (of statements). */
export const ListIcon = () => <Icon><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /></Icon>

/** A side panel at the end of the window. */
export const PanelRightIcon = () => <Icon><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /></Icon>

/** A flame: the I/O map's Hot blocks (blocks read over and over). */
export const FlameIcon = () => (
  <Icon><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" /></Icon>
)

/** A grid of cells: the I/O map's density layer. */
export const GridIcon = () => (
  <Icon><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" /><path d="M15 3v18" /></Icon>
)
