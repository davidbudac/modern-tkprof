import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ConnectionsProvider, JobsPanel, type WorkspaceBridge } from './connections'
import { EngineProvider, useEngine } from './engine'
import { StatusBar } from './StatusBar'
import { pages } from './pages'
import { EXIT_MS, useExit } from '@lib/components/motion'
import { onDrop } from './platform'
import { PromptHost } from './prompts/PromptHost'
import { SettingsProvider, engineOptionsOf, useSettings } from './settings/settings'
import { OpenScreen } from './workspace/OpenScreen'
import { useTabShortcuts } from './workspace/shortcuts'
import { useKeyHints } from './workspace/keyHints'
import { TabStrip } from './workspace/TabStrip'
import { TabView } from './workspace/TabView'
import { dropOptions, dropOverlayText, leaveRoute } from './workspace/workspace'
import { WorkspaceProvider, useWorkspace, useWorkspaceState } from './workspace/WorkspaceProvider'
import { UpdateToast } from './updates/UpdateToast'

/** The desktop frame: settings first (the engine starts with them), then engine, workspace, the frame. */
export function App() {
  return (
    <SettingsProvider>
      <EngineWithSettings />
    </SettingsProvider>
  )
}

function EngineWithSettings() {
  const { settings } = useSettings()
  return (
    <EngineProvider options={engineOptionsOf(settings)}>
      <WorkspaceProvider>
        <WithConnections>
          <div className="frame">
            <TabStrip />
            <main className="frame-main">
              <Routed />
            </main>
            <StatusBar />
            <DropTarget />
            <TabShortcuts />
            <CrashToast />
            <UpdateToast />
            <JobsPanel />
            <PromptHost />
            <FailedPanel />
          </div>
        </WithConnections>
      </WorkspaceProvider>
    </EngineProvider>
  )
}

/** S6: connections open fetched files and live follows as workspace tabs (no open screen is showing then: the settings' default options, as for a drop elsewhere). */
function WithConnections({ children }: { children: ReactNode }) {
  const ws = useWorkspace()
  const { settings } = useSettings()
  const bridge = useMemo<WorkspaceBridge>(
    () => ({
      openPaths: (paths) =>
        void ws.open({ paths, options: { binds: settings.binds, salt: settings.binds === 'redact' && settings.salt ? settings.salt : undefined } }),
      attachSession: (r, { title, live, reopen }) => void ws.adopt(r, { title, live, reopen: reopen && ((e) => reopen(e.client)) }),
      activeSession: () => {
        const { route, tabs } = ws.getSnapshot()
        return route.kind === 'tab' ? (tabs.find((t) => t.key === route.key)?.sessionId ?? null) : null
      },
    }),
    [ws, settings.binds, settings.salt],
  )
  return <ConnectionsProvider bridge={bridge}>{children}</ConnectionsProvider>
}

/** A desktop page with its way back: to the tab (or open screen) it was entered from; Esc does the same (see `useTabShortcuts`). */
function PageFrame({ children }: { children: ReactNode }) {
  const ws = useWorkspace()
  const { tabs, origin } = useWorkspaceState()
  const to = leaveRoute(tabs, origin)
  const title = to.kind === 'tab' ? tabs.find((t) => t.key === to.key)?.title : undefined
  return (
    <>
      <nav className="page-back">
        <button type="button" onClick={() => ws.leavePage()} title="Back (Esc)">
          <span aria-hidden>‹</span> {title ? <>Back to <span className="page-back-to">{title}</span></> : 'Back'}
        </button>
      </nav>
      {children}
    </>
  )
}

/** The open screen, the active session tab (its store outlives the switch), or a page. */
function Routed() {
  const { tabs, route } = useWorkspaceState()
  if (route.kind === 'tab') {
    const tab = tabs.find((t) => t.key === route.key)
    if (tab) return <TabView key={tab.key} tab={tab} />
  }
  if (route.kind === 'page') {
    const page = pages.find((p) => p.id === route.id)
    if (page) return <PageFrame>{page.render()}</PageFrame>
  }
  return <OpenScreen />
}

const NOTICE_MS = 7_000

/**
 * Files or folders dropped on the window open as one trace set. On the open screen with the
 * options shown there (the same as the picker and the paths box); anywhere else with the default
 * options from Settings (see `dropOptions`). The listener reads the workspace when the drop
 * happens, so it never holds stale options.
 */
function DropTarget() {
  const ws = useWorkspace()
  const { settings } = useSettings()
  const { status } = useEngine()
  const { route, openOptions } = useWorkspaceState()
  const [over, setOver] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const live = useRef({ settings, status })
  live.current = { settings, status }
  useEffect(() => {
    const off = onDrop((e) => {
      setOver(e.over)
      if (!e.paths?.length || live.current.status !== 'ready') return
      const { route, openOptions } = ws.getSnapshot()
      const d = dropOptions(route, openOptions, live.current.settings, e.paths)
      void ws.openOrPick({ paths: e.paths, options: d.options })
      setNotice(d.notice ?? null)
    })
    return () => void off.then((f) => f())
  }, [ws])
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])
  return (
    <>
      {over && (
        <div className="drop-overlay" aria-hidden>
          <div style={{ textAlign: 'center' }}>
            <p>Drop trace files or folders to open them</p>
            <p className="muted small">{dropOverlayText(route, openOptions, settings)}</p>
          </div>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <b>{notice}</b>
          <button className="quiet" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
    </>
  )
}

/** Keyboard shortcuts for the tabs (see `workspace/shortcuts.ts`) and the hints shown while a modifier is held (`workspace/keyHints.ts`). */
function TabShortcuts() {
  useTabShortcuts(useWorkspace())
  useKeyHints()
  return null
}

const TOAST_MS = 10_000

/** Non-blocking notice: "restarting…" on `engine://crashed`, "Engine restarted" once it is back. */
function CrashToast() {
  const { crashes, lastCrash, status } = useEngine()
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (crashes === 0 || status !== 'ready') return
    const t = setTimeout(() => setShown(crashes), TOAST_MS)
    return () => clearTimeout(t)
  }, [crashes, status])
  // the text changing from "restarting" to "restarted" updates the open toast; only dismissing or the timeout exits it
  const { shown: toast, closing } = useExit(crashes === shown || status === 'failed' ? null : { back: status === 'ready', crash: lastCrash }, EXIT_MS.fast)
  if (!toast) return null
  return (
    <div className={'toast' + (closing ? ' closing' : '')} role="status" inert={closing}>
      <b>{toast.back ? 'Engine restarted' : 'Engine stopped, restarting…'}</b>
      {toast.crash && <span className="muted">{toast.crash.message}</span>}
      <button className="quiet" onClick={() => setShown(crashes)}>Dismiss</button>
    </div>
  )
}

/** Blocking panel when the engine cannot run (start error, protocol mismatch, repeated crashes). */
function FailedPanel() {
  const { status, error, restart } = useEngine()
  // an object, so an empty error text still counts as shown
  const { shown, closing } = useExit(status === 'failed' ? { error } : null, EXIT_MS.quick)
  if (!shown) return null
  return (
    <div className={'blocker' + (closing ? ' closing' : '')} role="alertdialog" aria-labelledby="failed-title" inert={closing}>
      <div className="blocker-card">
        <h2 id="failed-title">The engine is not running</h2>
        <pre className="blocker-error">{shown.error}</pre>
        <p className="muted">The app needs the mtkprof engine to open traces.</p>
        <p>
          <button onClick={() => void restart()}>Retry</button>
        </p>
      </div>
    </div>
  )
}
