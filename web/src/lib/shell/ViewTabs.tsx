import type { KeyboardEvent, ReactNode } from 'react'
import type { View } from '../state/store'
import { useActions, useStore } from '../state/session'
import { isMac } from './platform'
import { viewKeyAria, viewKeyLabel } from './viewKeys'
import { shownViews, type SessionViewDef } from './views'

/** With a view focused, ← → Home End move along the bar and open the view there (a tab moved off the bar is skipped). */
function onTabsKey(e: KeyboardEvent<HTMLElement>) {
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > .tab:not([data-overflow])'))
  const i = tabs.indexOf(e.target as HTMLButtonElement)
  if (i < 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  const to = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null
  if (to === null) return
  e.preventDefault()
  const b = tabs[(to + tabs.length) % tabs.length]
  b.focus()
  b.click()
}

/**
 * The tab bar of the views: a `.tab` per shown row of `views` outside the `tools` group, in nav order, each with its chord
 * (`title`, `aria-keyshortcuts`; none, and no `hint`, for a row without a key). `counts` adds a small number after a label (the standalone's statements / waits / sessions),
 * `hint` renders something after it too (the desktop's key-hint `<kbd>`), `children` go after the tabs.
 * `overflow` names the views a shell has moved off the bar (into a menu, the desktop's narrow window): their tabs keep their
 * place but are hidden (`data-overflow`: no focus, no pill), so the shell can measure which ones fit (`data-view`).
 * Inside a SessionProvider; nothing until the document is in.
 */
export function ViewTabs({ views, counts, hint, overflow, children }: {
  views: readonly SessionViewDef[]
  counts?: Partial<Record<View, ReactNode>>
  hint?: (view: SessionViewDef, chord: string) => ReactNode
  overflow?: ReadonlySet<View>
  children?: ReactNode
}) {
  const actions = useActions()
  const state = useStore((s) => s)
  if (!state.doc) return null
  return (
    <nav className="tabs" aria-label="Views" onKeyDown={onTabsKey}>
      {shownViews(views, state.doc, state).filter((v) => v.group !== 'tools').map((v) => {
        const chord = viewKeyLabel(v.key, isMac) // '' for a view without a key: no chord in the title, no hint
        const n = counts?.[v.id]
        return (
          <button key={v.id} className="tab" data-view={v.id} data-overflow={overflow?.has(v.id) || undefined} aria-current={state.view === v.id ? 'page' : undefined} onClick={() => actions.setView(v.id)}
            title={chord ? `${v.label} (${chord})` : v.label} aria-keyshortcuts={viewKeyAria(v.key, isMac) || undefined}>
            {v.label}{n !== undefined && n !== null && <small>{n}</small>}{chord && hint?.(v, chord)}
          </button>
        )
      })}
      {children}
    </nav>
  )
}
