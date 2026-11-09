// The page's only way to the shell: `window.mtkprof` (see `src/shell.ts` for the typed side).
// Commands go to `ipcMain.handle('mtkprof:invoke')`, events come on `mtkprof:event`; a dropped
// file's path comes from webUtils (the page sees File objects only).

import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('mtkprof', {
  invoke: (cmd: string, args?: Record<string, unknown>) => ipcRenderer.invoke('mtkprof:invoke', cmd, args),
  onEvent: (fn: (event: string, payload: unknown) => void) => {
    const h = (_e: Electron.IpcRendererEvent, event: string, payload: unknown) => fn(event, payload)
    ipcRenderer.on('mtkprof:event', h)
    return () => void ipcRenderer.off('mtkprof:event', h)
  },
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  platform: process.platform,
})
