/** Pure decisions behind the keyboard patterns of the list, table and separator widgets (unit-tested; the components only wire them). */

/**
 * The index a navigation key moves to, or null when the key is not handled or nothing moves.
 * `current` < 0 means nothing is selected: Down starts at the first item, Up at the last. With `visible`
 * (the inclusive index range on screen of a virtualized list), they start at the first / last visible one instead.
 * `homeEnd: false` leaves Home/End to the browser (a scrolling table).
 */
export function nextIndex(key: string, current: number, count: number, opts: { visible?: { start: number; end: number } | null; homeEnd?: boolean } = {}): number | null {
  if (count <= 0) return null
  const last = count - 1
  const clamp = (i: number) => Math.min(Math.max(i, 0), last)
  const none = current < 0 || current > last
  let to: number
  switch (key) {
    case 'ArrowDown':
      to = none ? (opts.visible ? clamp(opts.visible.start) : 0) : Math.min(current + 1, last)
      break
    case 'ArrowUp':
      to = none ? (opts.visible ? clamp(opts.visible.end) : last) : Math.max(current - 1, 0)
      break
    case 'Home':
      if (opts.homeEnd === false) return null
      to = 0
      break
    case 'End':
      if (opts.homeEnd === false) return null
      to = last
      break
    default:
      return null
  }
  return to === current ? null : to
}

/** Space and Enter activate the active option of a listbox. */
export const isActivateKey = (key: string): boolean => key === 'Enter' || key === ' '

/** Events from a text field or another embedded control keep their own keys: only the widget's own surface navigates. */
export function ownsKeys(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  const tag = (target?.tagName ?? '').toUpperCase()
  return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable)
}

/**
 * The row a key press in a table moves the selection to, or null when the table leaves the key alone.
 * Only a table with a selection model (`selectable`: it has a click handler AND reports which row is selected) navigates:
 * a table whose click is an action (open, toggle) would run that action on every arrow press, so it keeps native scrolling.
 * Keys from embedded controls, the sortable header buttons, modifier chords and handled events are not the table's.
 */
export function tableKeyTarget(a: {
  selectable: boolean
  key: string
  modified: boolean
  defaultPrevented: boolean
  target: { tagName?: string; isContentEditable?: boolean; inHeader?: boolean } | null
  current: number
  count: number
  visible: { start: number; end: number } | null
}): number | null {
  if (!a.selectable || a.modified || a.defaultPrevented || a.target?.inHeader || !ownsKeys(a.target)) return null
  return nextIndex(a.key, a.current, a.count, { visible: a.visible, homeEnd: false })
}

/** `aria-selected` of a table row: only a table with a selection model announces one (an action table's rows are not selectable). */
export function rowSelected(selectable: boolean, selectedKey: string | number | null | undefined, key: string | number): 'true' | 'false' | undefined {
  return selectable ? (selectedKey === key ? 'true' : 'false') : undefined
}

export interface SortState {
  key: string
  dir: 'asc' | 'desc'
}

/** Clicking a sortable header: the sorted column flips direction, another starts numbers descending and text ascending. */
export function toggleSort(sort: SortState | null, key: string, align: 'start' | 'end' | undefined): SortState {
  if (sort && sort.key === key) return { key, dir: sort.dir === 'desc' ? 'asc' : 'desc' }
  return { key, dir: align === 'end' ? 'desc' : 'asc' }
}

/** `aria-sort` of a header cell: a sortable column announces `none` until it is the sorted one. */
export function ariaSort(sort: SortState | null, key: string, sortable: boolean): 'ascending' | 'descending' | 'none' | undefined {
  if (sort?.key === key) return sort.dir === 'asc' ? 'ascending' : 'descending'
  return sortable ? 'none' : undefined
}

/** A pane width clamped to [min, max(min, container * maxFrac)]. */
export function clampPane(raw: number, min: number, containerWidth: number, maxFrac: number): number {
  return Math.round(Math.min(Math.max(raw, min), Math.max(min, containerWidth * maxFrac)))
}

/** `aria-valuenow/min/max` of a pane separator from where the handle sits in its container (px, as getBoundingClientRect gives them). */
export function separatorValues(anchor: 'start' | 'end', handleX: number, box: { left: number; right: number; width: number }, min: number, maxFrac: number): { now: number; min: number; max: number } {
  const max = Math.round(Math.max(min, box.width * maxFrac))
  const raw = anchor === 'end' ? box.right - handleX : handleX - box.left
  return { now: Math.round(Math.min(Math.max(raw, min), max)), min, max }
}
