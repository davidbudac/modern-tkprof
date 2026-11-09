import { useEffect, useState } from 'react'
import { EXIT_MS, useExit } from '@lib/components/motion'
import { fmtBytes } from '@lib'
import { useEngine } from '../engine'
import { useSettings } from '../settings/settings'
import { checkForUpdate, installUpdate, installsItself, releaseUrl, updatesAvailable, useUpdateState, type UpdateState } from './updates'

/** after the start, so the check does not compete with the engine start and the workspace restore */
const START_DELAY_MS = 4_000
let checkedOnStart = false

/**
 * The start's update check (setting `updateCheck`) and its toast: a newer version than the app's
 * offers Install and restart, Later (until the next start) and Skip this version (setting
 * `skippedVersion`); then the download's progress, the install, or why it failed. A failed check
 * is only logged; Settings → About shows it.
 */
export function UpdateToast() {
  const { settings, update } = useSettings()
  const engine = useEngine()
  const state = useUpdateState()
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    if (checkedOnStart || !settings.updateCheck || !updatesAvailable) return
    // the flag is set when the check starts: StrictMode's effect, cleanup, effect would else drop it
    const t = setTimeout(() => {
      checkedOnStart = true
      void checkForUpdate()
    }, START_DELAY_MS)
    return () => clearTimeout(t)
  }, [settings.updateCheck])

  const key = toastKey(state)
  const show = key !== null && key !== dismissed && !(state.kind === 'available' && state.version === settings.skippedVersion)
  const { shown, closing } = useExit(show ? state : null, EXIT_MS.fast)
  if (!shown) return null
  const restart = () => engine.restart(engine.options)

  return (
    <div className={'toast update-toast' + (closing ? ' closing' : '')} role="status" inert={closing}>
      {shown.kind === 'available' && (
        <>
          <b>mtkprof {shown.version} is available</b>
          <span className="muted">
            You have {shown.current}. <a href={releaseUrl(shown.version)} target="_blank" rel="noreferrer">What's new</a>
          </span>
          <div className="toast-actions">
            <button onClick={() => void installUpdate(restart)}>{installsItself ? 'Install and restart' : 'Download'}</button>
            <button className="quiet" onClick={() => setDismissed(key)}>Later</button>
            <button className="quiet" onClick={() => update({ skippedVersion: shown.version })}>Skip this version</button>
          </div>
        </>
      )}
      {shown.kind === 'downloading' && (
        <>
          <b>Downloading mtkprof {shown.version}…</b>
          <span className="progress-bar" {...(shown.total ? {} : { 'data-indeterminate': '' })}>
            <i style={shown.total ? { inlineSize: `${Math.min(100, (100 * shown.done) / shown.total)}%` } : undefined} />
          </span>
          <span className="muted small">
            {fmtBytes(shown.done)}
            {shown.total ? ` of ${fmtBytes(shown.total)}` : ''}
          </span>
        </>
      )}
      {shown.kind === 'installing' && (
        <>
          <b>Installing mtkprof {shown.version}…</b>
          <span className="muted">The app restarts when it is done and opens your tabs again.</span>
        </>
      )}
      {shown.kind === 'error' && (
        <>
          <b>The update to {shown.version} failed</b>
          <span className="muted">{shown.message}</span>
          <div className="toast-actions">
            <a href={releaseUrl(shown.version ?? '')} target="_blank" rel="noreferrer">Download it from the releases page</a>
            <button className="quiet" onClick={() => setDismissed(key)}>Dismiss</button>
          </div>
        </>
      )}
    </div>
  )
}

/** what the toast shows, as a key "Later" and "Dismiss" hide; null: nothing (no update, a check running or failed) */
function toastKey(s: UpdateState): string | null {
  switch (s.kind) {
    case 'available':
      return `available ${s.version}`
    case 'downloading':
    case 'installing':
      return `${s.kind} ${s.version}`
    case 'error':
      return s.during === 'install' ? `error ${s.version} ${s.message}` : null
    default:
      return null
  }
}
