import { useEffect, useRef, useState } from 'react'
import { fmtBytes, fmtInt } from '@lib/data/format'
import type { JobInfo } from '../engine'
import { EXIT_MS, prefersReducedMotion } from '../motion'
import { useConnections, type Notice } from './ConnectionsProvider'
import { finished, fraction, type TrackedJob } from './jobs'
import './connections.css'

const base = (p: string) => p.split(/[\\/]/).pop() ?? p

function progressText(j: JobInfo): string {
  const n = (v: number) => (j.unit === 'bytes' ? fmtBytes(v) : fmtInt(v))
  const unit = j.unit === 'bytes' || !j.unit ? '' : ` ${j.unit}`
  if (j.kind === 'follow') return `${fmtBytes(j.done)} mirrored`
  if (j.total > 0) return `${n(j.done)} / ${n(j.total)}${unit}`
  return j.done > 0 ? `${n(j.done)}${unit}` : ''
}

/** One notice; dismissing plays its exit first. A notice that expires on its own just goes. */
function NoticeItem({ n, onDismiss }: { n: Notice; onDismiss: (id: number) => void }) {
  const [leaving, setLeaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const dismiss = () => {
    if (leaving) return
    if (prefersReducedMotion()) return onDismiss(n.id)
    setLeaving(true)
    timer.current = setTimeout(() => onDismiss(n.id), EXIT_MS.fast)
  }
  return (
    <div className={'notice' + (leaving ? ' leaving' : '')} data-kind={n.kind} role={n.kind === 'error' ? 'alert' : 'status'} inert={leaving}>
      <span>{n.text}</span>
      <button className="quiet" onClick={dismiss} aria-label="Dismiss" title="Dismiss">×</button>
    </div>
  )
}

/** Bottom-right: running and finished fetch/follow/ref jobs, plus the connections' notices. */
export function JobsPanel() {
  const { jobs, notices, dismissNotice, dispatchJobs, cancelJob, bridge, notify } = useConnections()
  const [collapsed, setCollapsed] = useState(false)
  const running = jobs.list.filter((t) => !finished(t.job)).length
  const anyFinished = jobs.list.some((t) => finished(t.job))

  const open = async (t: TrackedJob) => {
    dispatchJobs({ type: 'opened', id: t.job.id })
    try {
      await bridge.openPaths(t.job.localPaths ?? [])
    } catch (e) {
      notify(`Opening failed: ${(e as Error).message}`, 'error')
    }
  }

  if (!jobs.list.length && !notices.length) return null
  return (
    <aside className="jobs-dock" aria-label="Jobs">
      {notices.map((n) => <NoticeItem key={n.id} n={n} onDismiss={dismissNotice} />)}
      {jobs.list.length > 0 && (
        <section className="jobs" data-open={!collapsed}>
          <header>
            <button className="quiet" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
              Jobs{running ? ` · ${running} running` : ''}
            </button>
            <span className="spacer" />
            {anyFinished && !collapsed && (
              <button className="quiet" onClick={() => dispatchJobs({ type: 'clearFinished' })}>Clear finished</button>
            )}
          </header>
          {/* the list stays mounted: the wrapper's grid row animates 0fr to 1fr, inert while collapsed */}
          <div className="jobs-body" inert={collapsed}>
            <div className="jobs-clip">
              <ul>
                {jobs.list.map((t) => {
                  const j = t.job
                  const f = fraction(j)
                  return (
                    <li key={j.id} data-state={j.state}>
                      <div className="job-line">
                        <span className="job-label" title={t.label}>{t.label}</span>
                        <span className="job-state">
                          {j.state === 'running' ? progressText(j) : j.state === 'done' && j.done > 0 && j.kind !== 'ref' ? `done · ${progressText(j)}` : j.state}
                        </span>
                      </div>
                      {j.state === 'running' && (
                        <div className={'bar' + (f === null ? ' indeterminate' : '')} role="progressbar" aria-valuemin={0} aria-valuemax={1} aria-valuenow={f ?? undefined}>
                          <span style={f === null ? undefined : { inlineSize: `${(f * 100).toFixed(1)}%` }} />
                        </div>
                      )}
                      {j.state === 'done' && j.kind === 'fetch' && !!j.localPaths?.length && (
                        <p className="job-msg mono" title={j.localPaths.join('\n')}>{j.localPaths.map(base).join(', ')}</p>
                      )}
                      {j.message && j.message !== 'cancelled' && <p className={'job-msg' + (j.state === 'failed' ? ' err' : '')}>{j.message}</p>}
                      <div className="job-actions">
                        {j.state === 'done' && j.kind === 'fetch' && !!j.localPaths?.length && (
                          <button onClick={() => void open(t)}>{t.opened ? 'Open again' : 'Open'}</button>
                        )}
                        {j.state === 'running' && <button onClick={() => void cancelJob(j.id)}>{j.kind === 'follow' ? 'Stop' : 'Cancel'}</button>}
                        {finished(j) && (
                          <button className="quiet" onClick={() => dispatchJobs({ type: 'dismiss', id: j.id })}>Dismiss</button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        </section>
      )}
    </aside>
  )
}
