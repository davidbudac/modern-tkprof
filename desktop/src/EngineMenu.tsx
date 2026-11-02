import { useEffect, useRef, useState } from 'react'
import { fmtBytes } from '@lib/data/format'
import { useEngine } from './engine'
import { fmtUptime } from './time'
import { useWorkspace, useWorkspaceState } from './workspace/WorkspaceProvider'

/** Opens and scrolls Settings to its About section once the page is on screen (a frame or two after `go`). */
function showSettingsAbout(tries = 5) {
  requestAnimationFrame(() => {
    const el = document.getElementById('settings-about')
    if (el) {
      // the About section is a rollout (collapsed): open it before scrolling
      const d = el.querySelector('details')
      if (d) d.open = true
      el.scrollIntoView({ block: 'start' })
    }
    else if (tries > 0) showSettingsAbout(tries - 1)
  })
}

/** The engine as a dot in the top row; its popover has the state, open traces, cache, restarts, uptime, About (the Settings section) and (dev tools) Kill. */
export function EngineMenu() {
  const ws = useWorkspace()
  const { tabs } = useWorkspaceState()
  const { status, restarts, health, devTools, kill, error } = useEngine()
  const [open, setOpen] = useState(false)
  // the top row clips sideways overflow: the popover is fixed under the button, right-aligned to it
  const [at, setAt] = useState({ top: 0, right: 0 })
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setOpen(false) } }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  const label = status === 'ready' ? 'ready' : status === 'restarting' ? 'restarting…' : status === 'starting' ? 'starting…' : 'failed'
  return (
    <span className="engine-wrap" ref={root} data-status={status}>
      <button
        className="engine-btn"
        data-status={status}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`engine ${label}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ top: r.bottom + 4, right: window.innerWidth - r.right })
          setOpen(!open)
        }}
      >
        <span className="dot" aria-hidden />
        <span className="sr-only">engine {label}</span>
      </button>
      {open && (
        <div className="pop engine-pop" role="dialog" aria-label="Engine" style={{ insetBlockStart: at.top, insetInlineEnd: at.right }}>
          <h4><span className="dot" aria-hidden /> engine {label}</h4>
          <dl className="kv">
            <dt>open traces</dt>
            <dd><b>{tabs.length}</b> {tabs.length === 1 ? 'trace' : 'traces'}</dd>
            {health && (
              <>
                <dt>cache</dt>
                <dd><b>{fmtBytes(health.cache.bytes)}</b> of {fmtBytes(health.cache.cap)}</dd>
              </>
            )}
            <dt>restarts</dt>
            <dd><b>{restarts}</b></dd>
            {health && (
              <>
                <dt>uptime</dt>
                <dd><b>{fmtUptime(health.uptime)}</b></dd>
              </>
            )}
          </dl>
          {status === 'failed' && error && <p className="small">{error}</p>}
          <div className="foot">
            <button
              onClick={() => {
                setOpen(false)
                ws.go({ kind: 'page', id: 'settings' })
                showSettingsAbout()
              }}
            >
              About
            </button>
            {devTools && (
              <button className="danger" disabled={status !== 'ready'} onClick={() => void kill().catch((e) => console.error(e))}>
                Kill engine
              </button>
            )}
          </div>
        </div>
      )}
    </span>
  )
}
