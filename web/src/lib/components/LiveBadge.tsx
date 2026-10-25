import { useActions, useStore } from '../state/session'

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

/** "live · rev N · updated hh:mm:ss" and pause/resume, for a live session's document (`State.live`); nothing otherwise. */
export function LiveBadge() {
  const live = useStore((s) => s.live)
  const actions = useActions()
  if (!live) return null
  const word = live.paused ? 'paused' : live.state === 'ended' ? 'ended' : live.state === 'error' ? 'reconnecting' : 'live'
  const title = live.state === 'ended' ? 'the server stopped following the trace; this is its last snapshot'
    : live.state === 'error' ? `the last request failed: ${live.error ?? ''}${live.retryAt ? ` (next try at ${clock(live.retryAt)})` : ''}`
    : live.paused ? 'updates paused: the document stays as it is' : 'the trace is followed as it grows; each snapshot replaces the document'
  return (
    <span className="live-badge" data-state={live.paused ? 'paused' : live.state} title={title} role="status" aria-live="polite">
      <i className="live-dot" aria-hidden="true" />
      <b>{word}</b>
      <span className="dim"> · rev {live.rev} · updated {clock(live.updated)}</span>
      {live.state !== 'ended' && (
        <button className="quiet" onClick={() => actions.setLivePaused(!live.paused)} aria-label={live.paused ? 'Resume live updates' : 'Pause live updates'} title={live.paused ? 'resume updates' : 'pause updates'}>
          {live.paused ? '▶' : '❚❚'}
        </button>
      )}
    </span>
  )
}
