import { useEffect } from 'react'
import { isMac } from '@lib'

/**
 * Holding the views' modifier alone (⌘ on macOS, Ctrl elsewhere) for a moment shows each view's digit (and the assistant's J) on the top bar;
 * holding the tabs' one (⌃ on macOS, Alt elsewhere) shows each tab's. The hints are `.key-hint[data-for]` elements that
 * app.css reveals while `<html data-key-hints>` names their group. A quick chord (⌘C) never shows them: any other key
 * before the delay cancels it. Once shown they stay while the modifier is held, so ⌘2 then ⌘3 keeps them up.
 */
const DELAY_MS = 450

export type HintGroup = 'views' | 'tabs'

export function hintGroupOf(key: string, mac: boolean): HintGroup | null {
  if (mac) return key === 'Meta' ? 'views' : key === 'Control' ? 'tabs' : null
  return key === 'Control' ? 'views' : key === 'Alt' ? 'tabs' : null
}

export function useKeyHints() {
  useEffect(() => {
    const root = document.documentElement
    let timer: ReturnType<typeof setTimeout> | undefined
    let held: HintGroup | null = null
    const hide = () => {
      clearTimeout(timer)
      timer = undefined
      held = null
      delete root.dataset.keyHints
    }
    const onDown = (e: KeyboardEvent) => {
      const group = hintGroupOf(e.key, isMac)
      if (group) {
        if (e.repeat || held === group) return
        hide()
        held = group
        timer = setTimeout(() => { if (held) root.dataset.keyHints = held }, DELAY_MS)
        return
      }
      // another key: a chord, not a look at the hints; already shown, they stay
      if (!root.dataset.keyHints) hide()
    }
    const onUp = (e: KeyboardEvent) => { if (hintGroupOf(e.key, isMac) === held) hide() }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', hide)
    window.addEventListener('pointerdown', hide, true)
    return () => {
      hide()
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', hide)
      window.removeEventListener('pointerdown', hide, true)
    }
  }, [])
}
