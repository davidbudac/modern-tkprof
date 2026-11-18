// The folds of the dump reader's text (docs/PLAN-DIAG.md § The reader): a loaded outline node with a `fold` reason (the engine says which parts are noise: the
// registers and memory of each frame, block dumps, a process map) is shown closed in Text. A closed fold keeps its heading line and hides the rest of the node's
// lines behind one row that says how many they are and why; a click on the heading opens it. The text is paged and virtualised, so nothing here reads a line:
// the folds are ranges of line numbers from the outline, laid into the viewer's own fold mechanism (`data/folds.ts`, the one the Lines view uses), which maps
// rows to lines and asks the server for the pages of the rows in view only.
import { foldHiding, type Fold } from './folds'
import type { DiagNode } from './diag'
import { fmtInt } from './format'

/** A part with fewer hidden lines than this is not folded (one row instead of one or two is no gain). */
export const MIN_FOLD_HIDDEN = 3

/** Which folds are open: `all` is the default for every fold, `set` what was toggled apart from it, by node id. Immutable. */
export interface FoldState { all: boolean; set: Readonly<Record<string, boolean>> }

/** Every fold closed (the default of a file). */
export const FOLDED: FoldState = { all: false, set: {} }

export const isFoldOpen = (st: FoldState, id: string): boolean => st.set[id] ?? st.all
/** "Unfold all" (`open`) or "Fold all": the default for every fold, the toggled ones forgotten. */
export const foldAll = (open: boolean): FoldState => (open ? { all: true, set: {} } : FOLDED)
/** One fold opened or closed. */
export function setFold(st: FoldState, id: string, open: boolean): FoldState {
  if (isFoldOpen(st, id) === open && !(id in st.set)) return st
  const set = { ...st.set }
  if (open === st.all) delete set[id]
  else set[id] = open
  return { all: st.all, set }
}

/**
 * The line that stays visible as the fold's heading: the node's first line, except for a part of an incident's table of contents (kind `toc`), which starts at
 * its `[TOC00007]` marker with the title on the next line: the marker stays a plain line and the title is the heading.
 */
export const handleOf = (n: DiagNode): number => (n.kind === 'toc' ? n.from + 1 : n.from)

/** The summary the heading row carries when its fold is closed: "2,138 lines · memory around the arguments' and registers' addresses". */
export function foldSummary(n: DiagNode): string {
  const hidden = n.to - handleOf(n)
  return `${fmtInt(hidden)} ${hidden === 1 ? 'line' : 'lines'}${n.fold ? ` · ${n.fold}` : ''}`
}

/** What the viewer is given for a set of fold nodes and their state. */
export interface TextFolds {
  /** the closed folds, sorted and apart, in the viewer's form (`from` the heading line, `to` the part's last line) */
  folds: Fold[]
  /** the heading lines of every fold that can be opened or closed (the viewer draws ▾ on the open ones) */
  handles: ReadonlySet<number>
  /** a heading line → the node it belongs to */
  nodeOf: ReadonlyMap<number, DiagNode>
  /** the lines the closed folds hide, summed */
  hiddenLines: number
}

/**
 * The folds of the nodes that have a reason (`nodes`: the loaded ones, outermost first, in file order: `DiagOutlineStore.folded()`) under `st`. A node inside a
 * closed fold is not a fold of its own (it is hidden), one inside an open fold is. A part with fewer than `MIN_FOLD_HIDDEN` lines to hide is left open.
 */
export function textFolds(nodes: readonly DiagNode[], st: FoldState): TextFolds {
  const folds: Fold[] = []
  const handles = new Set<number>()
  const nodeOf = new Map<number, DiagNode>()
  let hiddenLines = 0
  let closedTo = 0
  for (const n of nodes) {
    const h = handleOf(n)
    if (n.to - h < MIN_FOLD_HIDDEN || h <= closedTo) continue
    handles.add(h)
    if (!nodeOf.has(h)) nodeOf.set(h, n)
    if (isFoldOpen(st, n.id)) continue
    folds.push({ from: h, to: n.to, summary: foldSummary(n), auto: true })
    hiddenLines += n.to - h
    closedTo = n.to
  }
  return { folds, handles, nodeOf, hiddenLines }
}

/**
 * The state with every closed fold that hides `line` opened (a search hit, a go-to, a bookmark, a node selected in the outline that lies inside one): the same
 * object when nothing hides it. An inner fold that was folded inside the opened one hides it in turn and is opened too.
 */
export function unfoldFor(nodes: readonly DiagNode[], st: FoldState, line: number): FoldState {
  let cur = st
  for (let i = 0; i < 16; i++) {
    const hid = foldHiding(line, textFolds(nodes, cur).folds)
    if (!hid) break
    const n = nodes.find((x) => handleOf(x) === hid.from && x.to === hid.to)
    if (!n) break
    cur = setFold(cur, n.id, true)
  }
  return cur
}

/** How many of the folds are closed under `st` (the toolbar's buttons and the status line). */
export const closedCount = (nodes: readonly DiagNode[], st: FoldState): number => textFolds(nodes, st).folds.length
