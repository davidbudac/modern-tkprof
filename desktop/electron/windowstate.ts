// The window's size, position and maximized state across runs (`<data dir>/window-state.json`).

import { screen, type BrowserWindow, type Rectangle } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './paths'

interface Saved extends Rectangle {
  maximized?: boolean
}

const file = () => path.join(dataDir(), 'window-state.json')

/** The saved bounds when they still meet a display (a monitor that went away must not hide the window). */
export function loadWindowState(): Saved | null {
  try {
    const s = JSON.parse(fs.readFileSync(file(), 'utf8')) as Saved
    if (![s.x, s.y, s.width, s.height].every(Number.isFinite)) return null
    const visible = screen.getAllDisplays().some(({ workArea: a }) => s.x < a.x + a.width && s.x + s.width > a.x && s.y < a.y + a.height && s.y + s.height > a.y)
    return visible ? s : null
  } catch {
    return null
  }
}

export function trackWindowState(win: BrowserWindow) {
  const save = () => {
    try {
      const b = win.getNormalBounds()
      fs.mkdirSync(path.dirname(file()), { recursive: true })
      fs.writeFileSync(file(), JSON.stringify({ ...b, maximized: win.isMaximized() }))
    } catch {
      // the window state is a convenience
    }
  }
  win.on('close', save)
}
