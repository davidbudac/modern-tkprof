import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useEngine } from '../engine'
import { appInfo, devEngine, onOpenRequest, takeOpenRequests } from '../platform'
import { useSettings } from '../settings/settings'
import { pruneCuts } from './cuts'
import { Workspace, type Snapshot } from './workspace'

const Ctx = createContext<Workspace | null>(null)

/**
 * The workspace of this window: binds it to the running engine (a new address or token re-opens
 * every tab), feeds it the engine's events, and on the first engine restores last run's tabs
 * (unless "start empty") plus a smoke run's `MTKPROF_SMOKE_OPEN` trace, then the trace files handed to
 * the app from outside (command line, Finder, `mtkprof open`; later ones as they arrive).
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const ws = useMemo(() => new Workspace(), [])
  const { status, client, addr, token, events } = useEngine()
  const { settings } = useSettings()

  useEffect(() => ws.attach(events), [ws, events])

  // outside open requests: taken once the tabs are restored and the engine is ready, else they wait in the shell's queue
  const restored = useRef(false)
  const drain = useRef<() => void>(() => {})
  drain.current = () => {
    if (!restored.current || status !== 'ready') return
    void takeOpenRequests().then(
      (sets) => sets.forEach((paths) => void ws.openOrPick({ paths, options: { binds: settings.binds, salt: settings.binds === 'redact' && settings.salt ? settings.salt : undefined } }, true)),
      (e) => console.error('open requests:', e),
    )
  }
  useEffect(() => {
    const off = onOpenRequest(() => drain.current())
    return () => void off.then((f) => f())
  }, [])
  useEffect(() => drain.current(), [status])

  // Dev browser mode only (`?engine=&token=`; devEngine() is null inside the Tauri app, whose window
  // close stops the engine): a page reload or a hot-reloaded workspace would leave this window's
  // sessions in the engine, so close them. The tabs are restored from workspace.json by the next one.
  useEffect(() => {
    if (!devEngine()) return
    ws.keepSessions()
    const release = () => ws.releaseSessions()
    window.addEventListener('beforeunload', release)
    window.addEventListener('pagehide', release)
    return () => {
      window.removeEventListener('beforeunload', release)
      window.removeEventListener('pagehide', release)
      release() // unmounted or replaced (Vite HMR re-creates the Workspace): its sessions go
    }
  }, [ws])

  useEffect(() => {
    ws.onFirstEngine = () => {
      void appInfo()
        .catch(() => null)
        .then((info) =>
          ws.restore({
            startEmpty: settings.startEmpty,
            extra: info?.smokeOpen
              ? { paths: [info.smokeOpen], options: { binds: settings.binds, salt: settings.salt || undefined } }
              : null,
          }),
        )
        .catch((e) => console.error('restore:', e))
        .finally(() => {
          restored.current = true
          drain.current()
          // the cuts no tab references any more and older than a week (docs/DESKTOP.md § Cuts)
          pruneCuts(ws.getSnapshot().tabs.flatMap((t) => t.set.paths)).catch((e) => console.error('cuts:', e))
        })
    }
  }, [ws, settings.startEmpty, settings.binds, settings.salt])

  useEffect(() => {
    if (status === 'ready' && client && addr && token) ws.bind({ client, addr, token })
  }, [ws, status, client, addr, token])

  return <Ctx.Provider value={ws}>{children}</Ctx.Provider>
}

export function useWorkspace(): Workspace {
  const w = useContext(Ctx)
  if (!w) throw new Error('no WorkspaceProvider above this component')
  return w
}

export function useWorkspaceState(): Snapshot {
  const ws = useWorkspace()
  return useSyncExternalStore(ws.subscribe, ws.getSnapshot, ws.getSnapshot)
}
