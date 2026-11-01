// With the details pane open next to the Files panel, a narrow window leaves the view a sliver (a table shows two columns).
// The shell then folds the Files panel away for as long as the pane is open; this is the arithmetic and the bookkeeping.
import type { Store } from '../state/store'

/** The narrowest the view column may get before the Files panel makes room. */
export const MIN_VIEW_REM = 40

/**
 * Whether the Files panel has to fold away: the three columns (Files, view, details) do not fit in `bodyW`.
 * Below the lib's stacking breakpoint (`stacked`) the panes sit above and below the view instead, so there is nothing to win.
 */
export function filesNeedRoom(bodyW: number, filesW: number, inspectorW: number, rem: number, stacked: boolean): boolean {
  return !stacked && bodyW < filesW + MIN_VIEW_REM * rem + inspectorW
}

/** The resolved width in px of a length custom property (`--files-w` is a `clamp()` of rem and vw, so it has to be laid out to be known). */
export function lengthVar(host: HTMLElement, name: string): number {
  const probe = host.ownerDocument.createElement('div')
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;block-size:0;inline-size:var(${name})`
  host.append(probe)
  const w = probe.getBoundingClientRect().width
  probe.remove()
  return w
}

// Stores whose Files panel is folded by the shell, not by the user; the workspace does not save that as the user's choice.
const folded = new WeakSet<Store>()

export const markFilesFolded = (store: Store, on: boolean): void => void (on ? folded.add(store) : folded.delete(store))

/** True while `store`'s Files panel is closed by the shell, i.e. a `filesOpen: false` in it is not the user's. */
export const filesFolded = (store: Store): boolean => folded.has(store)

// Stores whose Files panel is being written by the shell right now (folding for room, a view's default); not the user's choice either.
const writing = new WeakSet<Store>()

/** Runs `write` (a `setFilesOpen`) as the shell's own change: the workspace does not save it and the view's choice does not record it. */
export function shellFilesWrite(store: Store, write: () => void): void {
  writing.add(store)
  try { write() } finally { writing.delete(store) }
}

/** True during a `shellFilesWrite` of `store`. */
export const inShellFilesWrite = (store: Store): boolean => writing.has(store)
