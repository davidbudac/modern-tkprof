// The Trace pane's Display tab and the toolbar's state chips: what the settings are called, and the words of what is on.
import type { DeltaMode, LinesPrefs } from '../state/linesPrefs'
import { fmtInt } from './format'
import type { LineKind } from './lines'

/** The display toggles of the Show section: the pref, its label, tooltip and key. */
export const SHOW_TOGGLES: readonly { key: 'wrap' | 'heat' | 'strip' | 'links' | 'hints' | 'clock' | 'delta'; label: string; title: string; keys?: string }[] = [
  { key: 'wrap', label: 'Wrap long lines', title: 'wrap long lines instead of scrolling sideways; in the formatted view, show each SQL statement pretty-printed in full' },
  { key: 'heat', label: 'Heat bars', keys: 'h', title: 'a bar in the right gutter for the elapsed time of calls and waits' },
  { key: 'strip', label: 'Line map', title: 'the whole file beside the scroll bar: where the highlighted statements\' lines are (each in its colour), the selected line, quiet ticks for search hits, bookmarks and hot spots; click or drag to move' },
  { key: 'links', label: 'Reference links', title: 'underline cursor numbers, sql_ids, objects and plan hashes in the rows; a click shows the statement (its SQL and a summary) in a popup, the Statements view is one click further (Shift: the cursor\'s parse line)' },
  { key: 'hints', label: 'Hints', keys: 'n', title: 'dim notes inside the rows: bind values and idle gaps' },
  { key: 'clock', label: 'Clock time', title: "a column beside the line numbers with each line's tim= as a wall-clock time in the trace's zone (the time from the start when the trace has no wall clock)" },
  { key: 'delta', label: 'Time delta', title: 'a column beside the line numbers with the time of each line from an anchor (●): the selected line when it is in view, else the first line in view with a time' },
]

/** The line kinds that can be dimmed together (the ticks of the line colours): the kinds of each group. */
export const MUTE_GROUPS: readonly { name: string; label: string; kinds: readonly LineKind[] }[] = [
  { name: 'framing', label: 'Framing (blank, header, separator)', kinds: ['blank', 'header', 'separator'] },
  { name: 'binds', label: 'Binds', kinds: ['binds', 'bind-line'] },
  { name: 'stat', label: 'STAT lines', kinds: ['stat'] },
  { name: 'markers', label: 'Markers (***)', kinds: ['marker'] },
  { name: 'waits', label: 'Waits', kinds: ['wait'] },
]

/** The tabs of the side panel (icons: the label is the tab's name, its tooltip and the panel's heading, `title` says what it holds): the selected line translated, the outline of the file, the search hits, the bookmarks, a statement as run, and the display settings. */
export type PanelTab = 'line' | 'outline' | 'hits' | 'bookmarks' | 'asrun' | 'display'
export const PANEL_TABS: readonly { tab: PanelTab; label: string; title: string }[] = [
  { tab: 'line', label: 'Line', title: 'the selected line translated: every field named, with its unit and meaning (i)' },
  { tab: 'outline', label: 'Outline', title: 'the file as a tree: session markers, the cursors parsed under them, their executions' },
  { tab: 'hits', label: 'Hits', title: 'the hits of the search' },
  { tab: 'bookmarks', label: 'Bookmarks', title: 'the lines you bookmarked, with their notes' },
  { tab: 'asrun', label: 'As run', title: "the statement of the selected line's execution with its bind values in place of the placeholders" },
  { tab: 'display', label: 'Display', title: 'what the rows show, how they are coloured, the folds' },
]

/**
 * The side panel after a request: `want` is a tab (the Display button, a key, a palette command), which opens the panel at it or closes the panel when it
 * already shows that tab; no tab is the panel button, which closes an open panel and opens a closed one at the last tab that was not Display (`last`: Display
 * has a button of its own, and the panel button is for the line, the hits and the bookmarks).
 */
export function panelAfter(s: { open: boolean; tab: PanelTab; last: Exclude<PanelTab, 'display'> }, want?: PanelTab): { open: boolean; tab: PanelTab } {
  if (want === undefined) return s.open ? { open: false, tab: s.tab } : { open: true, tab: s.tab === 'display' ? s.last : s.tab }
  return s.open && s.tab === want ? { open: false, tab: s.tab } : { open: true, tab: want }
}

/** What the Δ filter does with the rows that reach the threshold. */
export const DELTA_MODES: readonly { mode: DeltaMode; label: string; title: string }[] = [
  { mode: 'off', label: 'Off', title: 'every row as usual' },
  { mode: 'highlight', label: 'Highlight', title: 'tint the rows that reach the threshold; every row stays' },
  { mode: 'filter', label: 'Filter', title: 'show only the rows that reach the threshold (z on a row shows the lines hidden under it)' },
]

/** A threshold in ms as the toolbar and the panel say it: `10 ms`, `1.5 s`, `500 µs`. */
export const fmtMs = (ms: number) => (ms >= 1000 ? `${+(ms / 1000).toFixed(3)} s` : ms < 1 ? `${+(ms * 1000).toFixed(0)} µs` : `${+ms.toFixed(3)} ms`)

/**
 * How many of the Show and dim settings (the toggles, the gap ticks' threshold, the dimmed line groups) differ from the defaults: the badge on the Display
 * button, which says there is something set there without opening it. The Δ filter has its own chip; the lane colours, Fold repeats and the Δ column are
 * visible in the rows.
 */
export function displayBadge(prefs: Pick<LinesPrefs, 'wrap' | 'heat' | 'strip' | 'links' | 'hints' | 'clock' | 'delta' | 'gapMs' | 'mute'>, defaults: typeof prefs): number {
  return SHOW_TOGGLES.filter((t) => prefs[t.key] !== defaults[t.key]).length + Number(prefs.gapMs !== defaults.gapMs) + prefs.mute.length
}

/**
 * The words of the Δ filter's state chip, `Δ ≥ 10 ms · filter · 34`, in two parts: what it is (`Δ ≥ 10 ms`) and, folding first when the toolbar is narrow, what it is doing
 * (` · filter · 34`: the mode and, once the engine has answered, how many rows reach the threshold; `+` when more qualify than the list holds).
 */
export function deltaChipParts(mode: Exclude<DeltaMode, 'off'>, ms: number, count?: number, truncated?: boolean): { what: string; doing: string } {
  return { what: `Δ ≥ ${fmtMs(ms)}`, doing: ` · ${mode}${count === undefined ? '' : ` · ${fmtInt(count)}${truncated ? '+' : ''}`}` }
}
