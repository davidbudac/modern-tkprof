import type { KeyboardEvent } from 'react'

/**
 * The keys of a list whose rows take focus one at a time (the outline, the landmarks, the statement versions), the way the lib's outline does it:
 * Enter and Space do what a click does, ArrowUp and ArrowDown (Home and End) move focus to the neighbouring row. Only a key pressed on the row
 * itself counts, so a button or an input inside the row keeps its own keys. Returns true when the key was taken (the default is prevented, so the
 * view's own keys, which look at `defaultPrevented`, leave it alone).
 */
export function listKey(e: KeyboardEvent<HTMLElement>, o: { activate?(): void; move?(step: 1 | -1 | 'first' | 'last'): void }): boolean {
  if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return false
  switch (e.key) {
    case 'Enter': case ' ':
      if (!o.activate) return false
      e.preventDefault(); o.activate(); return true
    case 'ArrowDown': if (!o.move) return false; e.preventDefault(); o.move(1); return true
    case 'ArrowUp': if (!o.move) return false; e.preventDefault(); o.move(-1); return true
    case 'Home': if (!o.move) return false; e.preventDefault(); o.move('first'); return true
    case 'End': if (!o.move) return false; e.preventDefault(); o.move('last'); return true
  }
  return false
}

/** Focus the row `step` away from `from` among the elements of `list` that match `selector` (all rendered); a number step stops at the ends. */
export function focusRow(list: Element | null, selector: string, from: Element, step: 1 | -1 | 'first' | 'last'): void {
  if (!list) return
  const rows = [...list.querySelectorAll<HTMLElement>(selector)]
  if (rows.length === 0) return
  const at = rows.indexOf(from as HTMLElement)
  const to = step === 'first' ? 0 : step === 'last' ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + step))
  rows[to].focus()
}
