import { useEffect, useRef } from 'react'
import type { Store, View } from '../state/store'
import { isMac } from './platform'
import { shownViews, type SessionViewDef } from './views'

/** The part of a `KeyboardEvent` the key mappings read. */
export interface KeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

/** Typing in a field (input, textarea, select, contentEditable): global shortcuts leave those keys alone. */
export function inTextField(target: EventTarget | null): boolean {
  return typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

/** The digit of a key press (0 to 9), by `code` first: Alt or Shift can change `key`. */
export function digitOf(e: KeyLike): number | null {
  const m = /^Digit([0-9])$/.exec(e.code ?? '') ?? /^([0-9])$/.exec(e.key)
  return m ? Number(m[1]) : null
}

/**
 * Keys between the views. ⌘ on macOS, Ctrl elsewhere: a digit is the view with that `key`
 * (views.tsx: 1 Overview, 2 Trace, … 0 Compare); ⌥⌘← / ⌥⌘→ (Ctrl+PageUp / Ctrl+PageDown elsewhere) step
 * through the shown views in nav order, wrapping.
 */
export type ViewKeyAction = { kind: 'view'; key: number } | { kind: 'step'; dir: 1 | -1 }

export function viewKeyOf(e: KeyLike, mac: boolean): ViewKeyAction | null {
  if (e.shiftKey) return null
  if (mac) {
    if (!e.metaKey || e.ctrlKey) return null
    if (e.altKey) return e.key === 'ArrowLeft' ? { kind: 'step', dir: -1 } : e.key === 'ArrowRight' ? { kind: 'step', dir: 1 } : null
  } else {
    if (!e.ctrlKey || e.metaKey || e.altKey) return null
    if (e.key === 'PageUp') return { kind: 'step', dir: -1 }
    if (e.key === 'PageDown') return { kind: 'step', dir: 1 }
  }
  const d = digitOf(e)
  return d === null ? null : { kind: 'view', key: d }
}

/** The view an action goes to among the shown views (nav order), or null when no shown view has that key. A row without a key has no digit, but the steps walk it. */
export function viewOfKey(action: ViewKeyAction, shown: readonly { id: View; key?: number }[], current: View): View | null {
  if (action.kind === 'view') {
    return shown.find((x) => x.key !== undefined && x.key === action.key)?.id ?? null
  }
  if (shown.length < 2) return null
  const i = shown.findIndex((x) => x.id === current)
  const to = i < 0 ? (action.dir > 0 ? 0 : shown.length - 1) : (i + action.dir + shown.length) % shown.length
  return shown[to].id
}

/** How a view's chord is written in hints; '' for a view without a key. */
export const viewKeyLabel = (key: number | string | undefined, mac: boolean) => (key === undefined || key === '' ? '' : mac ? `⌘${key}` : `Ctrl+${key}`)

/** A view's chord for `aria-keyshortcuts`; '' for a view without a key. */
export const viewKeyAria = (key: number | string | undefined, mac: boolean) => (key === undefined || key === '' ? '' : mac ? `Meta+${key}` : `Control+${key}`)

/**
 * The view chords on the window: ⌘1 … ⌘9, ⌘0 Compare, ⌥⌘← ⌥⌘→ (Ctrl elsewhere, Ctrl+PageUp / PageDown to step) over the
 * shown rows of `views` (a row without a key only by the steps). A digit works from a text field too (it types nothing there);
 * stepping leaves a field's arrow keys alone.
 */
export function useViewKeys(store: Store, views: readonly SessionViewDef[]): void {
  const table = useRef(views)
  table.current = views
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return
      const action = viewKeyOf(e, isMac)
      if (!action || (action.kind === 'step' && inTextField(e.target))) return
      const s = store.getState()
      if (!s.doc) return
      const to = viewOfKey(action, shownViews(table.current, s.doc, s), s.view)
      if (!to) return
      e.preventDefault()
      if (to !== s.view) store.actions.setView(to)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])
}
