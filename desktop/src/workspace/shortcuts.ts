import { useEffect } from 'react'
import { digitOf, inTextField, isMac, type KeyLike } from '@lib'
import { inApp, listen } from '../platform'
import { leaveRoute, type Route, type Tab, type Workspace } from './workspace'

/** What a tab shortcut does. `nth` is a 1-based position (1 to 8); `last` is ⌃9 (Alt+9 elsewhere). */
export type ShortcutAction =
  | { kind: 'close' }
  | { kind: 'open' }
  | { kind: 'settings' }
  | { kind: 'nth'; n: number }
  | { kind: 'last' }
  | { kind: 'step'; dir: 1 | -1 }

/** The tab-switching chord: ⌃ on macOS (⌘ digits pick a view, the lib's `useViewKeys`), Alt elsewhere (Ctrl digits pick a view). */
export const tabDigitHeld = (e: KeyLike, mac: boolean) =>
  !e.shiftKey && (mac ? e.ctrlKey && !e.metaKey && !e.altKey : e.altKey && !e.ctrlKey && !e.metaKey)

/** How the tab chord is written in hints. */
export const tabKeyLabel = (n: number | string, mac: boolean) => (mac ? `⌃${n}` : `Alt+${n}`)

/**
 * The action for a key press, or null. ⌘ on macOS, Ctrl elsewhere: W close, T the open screen, `,` Settings.
 * ⌃1 to ⌃8 (Alt+1 to Alt+8 elsewhere) a tab by position, ⌃9 the last tab. Ctrl+Tab / Ctrl+Shift+Tab step through the
 * tabs on every platform, ⌘⇧] / ⌘⇧[ also on macOS. ⌘ / Ctrl digits are the views of the tab (the lib's `useViewKeys`).
 */
export function shortcutOf(e: KeyLike, mac: boolean): ShortcutAction | null {
  const digit = digitOf(e)
  if (digit !== null && tabDigitHeld(e, mac)) {
    if (digit >= 1 && digit <= 8) return { kind: 'nth', n: digit }
    if (digit === 9) return { kind: 'last' }
    return null
  }
  if (e.altKey) return null
  const key = e.key.toLowerCase()
  if (e.ctrlKey && !e.metaKey && key === 'tab') return { kind: 'step', dir: e.shiftKey ? -1 : 1 }
  if (!(mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return null
  if (e.shiftKey) {
    if (!mac) return null
    // with Shift the key is { or }
    if (key === ']' || key === '}' || e.code === 'BracketRight') return { kind: 'step', dir: 1 }
    if (key === '[' || key === '{' || e.code === 'BracketLeft') return { kind: 'step', dir: -1 }
    return null
  }
  if (key === ',') return { kind: 'settings' }
  // a held key would close or open tab after tab
  if (key === 'w') return e.repeat ? null : { kind: 'close' }
  if (key === 't') return e.repeat ? null : { kind: 'open' }
  return null
}

/** What an action does to the workspace: close a tab, go somewhere, or nothing. */
export type ShortcutEffect = { close: string } | { go: Route } | null

const tabRoute = (t: Tab | undefined): ShortcutEffect => (t ? { go: { kind: 'tab', key: t.key } } : null)

/** Resolves an action against the tabs and the current route. */
export function effectOf(action: ShortcutAction, tabs: Tab[], route: Route, origin?: Route): ShortcutEffect {
  switch (action.kind) {
    case 'close':
      if (route.kind === 'tab') return tabs.some((t) => t.key === route.key) ? { close: route.key } : null
      // a page: back to where it was entered from (`leaveRoute`); the open screen has no tab to close
      return route.kind === 'page' ? { go: leaveRoute(tabs, origin) } : null
    case 'open':
      return { go: { kind: 'open' } }
    case 'settings':
      return { go: { kind: 'page', id: 'settings' } }
    case 'nth':
      return tabRoute(tabs[action.n - 1])
    case 'last':
      return tabRoute(tabs[tabs.length - 1])
    case 'step': {
      if (!tabs.length) return null
      const i = route.kind === 'tab' ? tabs.findIndex((t) => t.key === route.key) : -1
      // from the open screen or a page: next is the first tab, previous the last
      const to = i < 0 ? (action.dir > 0 ? 0 : tabs.length - 1) : (i + action.dir + tabs.length) % tabs.length
      return tabRoute(tabs[to])
    }
  }
}

/** Runs an action; false when it had nothing to do. */
export function runShortcut(ws: Workspace, action: ShortcutAction): boolean {
  const { tabs, route, origin } = ws.getSnapshot()
  const fx = effectOf(action, tabs, route, origin)
  if (!fx) return false
  if ('close' in fx) ws.close(fx.close)
  else ws.go(fx.go)
  return true
}

/**
 * The window's tab shortcuts. In the macOS app ⌘W belongs to the app menu's "Close Tab" item
 * (`electron/menu.ts`), which a native key equivalent always reaches before the webview, so
 * the menu's `menu://close-tab` event runs the action there and the keydown ignores ⌘W: it
 * cannot fire twice. Elsewhere, and in the dev browser, the keydown does it.
 */
export function useTabShortcuts(ws: Workspace) {
  useEffect(() => {
    const menuClose = inApp && isMac
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || inTextField(e.target)) return
      const action = shortcutOf(e, isMac)
      if (!action || (action.kind === 'close' && menuClose)) return
      if (runShortcut(ws, action)) e.preventDefault()
    }
    // Esc leaves a page. Popover menus listen in the capture phase, stop the event and preventDefault,
    // so a handled Esc never gets here. PromptHost listens on window after this one (it mounts later),
    // so an open modal is checked directly. In a text field Esc only blurs it.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || ws.getSnapshot().route.kind !== 'page') return
      if (document.querySelector('[aria-modal="true"]')) return
      if (inTextField(e.target)) {
        ;(e.target as HTMLElement).blur()
        e.preventDefault()
        return
      }
      ws.leavePage()
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onEsc)
    const off = menuClose ? listen('menu://close-tab', () => runShortcut(ws, { kind: 'close' })) : null
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onEsc)
      void off?.then((f) => f())
    }
  }, [ws])
}
