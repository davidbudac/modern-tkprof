// The statement picker's keys, as a pure function: what a key does in the filter box and in the list, and the tri-state of the header's select-all boxes.
// The picker's text box keeps the DOM focus the whole time (the list is an aria-activedescendant listbox), so `mode` says whom the keys are for.

/** Whom the keys are for: the filter box (they type) or the list (they act on the focused statement). */
export type PickMode = 'filter' | 'list'

/** What a key asks of the picker. */
export type PickAct =
  | { do: 'move'; to: 'prev' | 'next' | 'prevPage' | 'nextPage' | 'first' | 'last' }
  | { do: 'highlight' } | { do: 'filter' } | { do: 'allHighlight' } | { do: 'allFilter' }
  | { do: 'go' } | { do: 'close' }

/** The keys of the event the reducer reads. */
export interface PickKey { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean }

/** The reducer's answer: the mode after the key, the act if any, and whether the picker took the key (otherwise it goes on to the text box, which types it). */
export interface PickStep { mode: PickMode; act?: PickAct; handled: boolean }

/**
 * What a key does. In the filter box the keys type, except ↓ (into the list), PgUp / PgDn (the list), Enter (go to the first listed statement), Tab (kept in the
 * popover) and Esc. In the list: ↑ ↓ PgUp PgDn Home End move, **Space** toggles the focused statement's highlight, **f** its filter, **a** highlights every listed statement
 * (or, when all are, none), **A** (Shift+a) does the same for the filter, **Enter** goes to its first line in the file and closes, **Esc** closes, `/` goes back to the
 * filter box without typing, and any other printable key or Backspace goes back to it and types. `atTop`: the focused row is the first of the list (↑ there returns to the box).
 */
export function pickerKey(mode: PickMode, e: PickKey, atTop = false): PickStep {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return { mode, handled: false }
  const k = e.key
  if (k === 'Escape') return { mode, act: { do: 'close' }, handled: true }
  if (k === 'Tab') return { mode, handled: true }
  if (k === 'Enter') return { mode, act: { do: 'go' }, handled: true }
  if (mode === 'filter') {
    switch (k) {
      case 'ArrowDown': return { mode: 'list', handled: true }
      case 'ArrowUp': return { mode, handled: true }
      case 'PageDown': return { mode: 'list', act: { do: 'move', to: 'nextPage' }, handled: true }
      case 'PageUp': return { mode: 'list', act: { do: 'move', to: 'prevPage' }, handled: true }
      default: return { mode, handled: false }
    }
  }
  switch (k) {
    case 'ArrowDown': return { mode, act: { do: 'move', to: 'next' }, handled: true }
    case 'ArrowUp': return atTop ? { mode: 'filter', handled: true } : { mode, act: { do: 'move', to: 'prev' }, handled: true }
    case 'PageDown': return { mode, act: { do: 'move', to: 'nextPage' }, handled: true }
    case 'PageUp': return { mode, act: { do: 'move', to: 'prevPage' }, handled: true }
    case 'Home': return { mode, act: { do: 'move', to: 'first' }, handled: true }
    case 'End': return { mode, act: { do: 'move', to: 'last' }, handled: true }
    case ' ': return { mode, act: { do: 'highlight' }, handled: true }
    case 'f': return { mode, act: { do: 'filter' }, handled: true }
    case 'a': return { mode, act: { do: 'allHighlight' }, handled: true }
    case 'A': return { mode, act: { do: 'allFilter' }, handled: true }
    case '/': return { mode: 'filter', handled: true }
    case 'Backspace': return { mode: 'filter', handled: false }
    default: return k.length === 1 ? { mode: 'filter', handled: false } : { mode, handled: false } // a printable key types in the box; Shift, F5, … are left alone
  }
}

/** The state of a select-all box over the listed statements: none of them on, some, or all. */
export type Tri = 'none' | 'some' | 'all'

export function triState(listed: readonly number[], on: (id: number) => boolean): Tri {
  let n = 0
  for (const id of listed) if (on(id)) n++
  return n === 0 ? 'none' : n === listed.length ? 'all' : 'some'
}

/** What a select-all box (or `a` / `A`) does: switch every listed statement on, or off when they all are already. */
export const selectAllTo = (t: Tri, listed: number): boolean => !(t === 'all' && listed > 0)
