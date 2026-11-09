// The macOS app menu. The default menu owns ⌘W through "Close Window" (a menu key equivalent reaches
// the menu before the page, so the page never sees the keydown and the window would close with the
// active tab). This is the default menu with that item turned into "Close Tab" (⌘W), which tells
// the UI (`menu://close-tab`, see `src/workspace/shortcuts.ts`); the window closes with
// "Close Window" (⇧⌘W) or the red button. Windows and Linux get no menu, as with Tauri: the page
// handles Ctrl+W itself.

import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

export function installMenu(win: () => BrowserWindow | null, send: (event: string) => void) {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    copyright: 'Copyright 2026 David Budac. Apache-2.0.',
  })
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'File', submenu: [{ label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('menu://close-tab') }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }])],
    },
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: () => win()?.close() },
      ],
    },
    { role: 'help', submenu: [] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
