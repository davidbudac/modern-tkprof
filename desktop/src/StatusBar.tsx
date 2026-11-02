import { useEngine } from './engine'

/** The trouble-only bar at the bottom of the window: shown while the engine is starting, restarting or failed (when it is ready the engine dot's menu has the details). */
export function StatusBar() {
  const { status, restarts } = useEngine()
  if (status === 'ready') return null
  const label = status === 'restarting' ? 'restarting…' : status === 'starting' ? 'starting…' : 'failed'
  return (
    <footer className="statusbar" data-status={status}>
      <span className="dot" aria-hidden />
      <span>engine {label}</span>
      {restarts > 0 && <span>restarts {restarts}</span>}
    </footer>
  )
}
