import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { ComparisonTab } from './CompareTabs'
import { OptLinksContext, ResizeHandle, SessionProvider, ViewErrorBoundary, fmtBytes, fmtInt, type OptLinks } from '@lib'
import { ChatPanel } from '../assist/ChatPanel'
import { OptAssistantNotice } from '../assist/OptAssistantNotice'
import { BrandIcon } from '../branding/BrandIcon'
import type { JobInfo } from '../engine'
import { SessionShell } from './session/SessionShell'
import { useWorkspace, useWorkspaceState } from './WorkspaceProvider'
import type { Tab } from './workspace'
import { Shimmer } from '@lib/components/motion'

const phaseLabel: Record<string, string> = {
  open: 'Looking up the index cache',
  parse: 'Parsing',
  index: 'Writing the index cache',
  ready: 'Loading the document',
  follow: 'Reading the file',
}

function pct(j: JobInfo | null): number | null {
  if (!j || j.total <= 0) return null
  return Math.min(100, (100 * j.done) / j.total)
}

const crashNote = 'The other tabs and the rest of the app are not affected. Reload draws the tab\'s views again.'

/**
 * One session tab, behind the lib's error boundary: a crash in its views shows a card here and nothing else goes down.
 * `resetKey` is the tab's engine session id: a new session (re-open after an engine restart, "Open again") clears the error.
 */
export function TabView({ tab }: { tab: Tab }) {
  return (
    <ViewErrorBoundary product="mtkprof-desktop" title={tab.title} note={crashNote} resetKey={tab.sessionId}
      context={[...tab.set.paths.map((p) => `path: ${p}`), `session: ${tab.sessionId ?? '-'}`]}>
      <TabBody tab={tab} />
    </ViewErrorBoundary>
  )
}

/** The tab's views once the document is in, else the open progress or the failure. */
function TabBody({ tab }: { tab: Tab }) {
  const ws = useWorkspace()
  const { tabs } = useWorkspaceState()
  // what the views of this tab can do across tabs: the "10053" mark on a statement, the dump list's "10046" link, a button beside a note.
  // A new object when the tabs change, so a mounted view redraws its marks.
  const links = useMemo<OptLinks>(
    () => ({ to10053: ws.dumpLink(tab.key), to10046: ws.statementLink(tab.key), noteAction: (note) => ws.noteAction(tab.key, note) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, tab.key, tabs],
  )
  // Only the active tab is mounted (App's Routed keys it), so a tab switch remounts this. Mounted without a session
  // means the user watched it open: its views reveal once. Mounted with one (a switch, a re-open banner) they show at once.
  const reveal = useRef(!tab.session).current
  const assistant = !!tab.panes?.assistantOpen
  // open at mount means a tab switch; opened since means the user asked for it (its message box takes the focus)
  const wasOpen = useRef(assistant)
  useEffect(() => {
    wasOpen.current = assistant
  })
  if (tab.origin === 'comparison') return <ComparisonTab tab={tab} />
  if (tab.session) {
    let banner = null
    if (tab.state === 'opening')
      banner = (
        <div className="tab-banner" role="status">
          Re-opening after an engine restart… <Progress tab={tab} compact />
        </div>
      )
    else if (tab.state === 'failed')
      banner = (
        <div className="tab-banner bad" role="alert">
          {tab.error}
          <button onClick={() => ws.retry(tab.key)}>Open again</button>
        </div>
      )
    const width = tab.panes?.assistantW
    // the assistant is a flex sibling of the views, so the lib's grid (and its Files-panel fold) stays as it is
    const views = (
      <SessionProvider session={tab.session}>
        <OptLinksContext.Provider value={links}>
        <div className="tab-split" style={width ? ({ '--assistant-w': `${width}px` } as CSSProperties) : undefined}>
          <SessionShell banner={banner} panes={tab.panes} onPanes={(patch) => ws.setPanes(tab.key, patch)} />
          {assistant && (
            <>
              <ResizeHandle anchor="end" min={280} className="resizer-assistant" label="Resize the assistant" onChange={(w) => ws.setPanes(tab.key, { assistantW: w ?? undefined })} />
              {tab.kind === '10053'
                ? <OptAssistantNotice onClose={() => ws.setPanes(tab.key, { assistantOpen: false })} />
                : <ChatPanel tab={tab} focus={!wasOpen.current} onClose={() => ws.setPanes(tab.key, { assistantOpen: false })} />}
            </>
          )}
        </div>
        </OptLinksContext.Provider>
      </SessionProvider>
    )
    return reveal ? <div className="tab-reveal">{views}</div> : views
  }
  if (tab.state === 'failed') return <OpenFailed tab={tab} />
  return <OpenProgress tab={tab} />
}

function Progress({ tab, compact }: { tab: Tab; compact?: boolean }) {
  const j = tab.job
  const p = j && (j.phase === 'parse' || j.phase === 'follow') ? pct(j) : null
  const label = j ? (phaseLabel[j.phase] ?? j.phase) : 'Starting'
  return (
    <span className={'progress' + (compact ? ' compact' : '')}>
      <span key={label} className="progress-phase"><Shimmer>{`${label}…`}</Shimmer></span>
      <span className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p ?? undefined} data-indeterminate={p === null || undefined}>
        <i style={p === null ? undefined : { inlineSize: `${p}%` }} />
      </span>
      {j && j.unit === 'bytes' && j.done > 0 && (
        <span className="progress-num mono">
          {fmtBytes(j.done)}
          {j.total > 0 && ` of ${fmtBytes(j.total)}`}
          {p !== null && ` · ${p.toFixed(0)} %`}
        </span>
      )}
    </span>
  )
}

/** The open job: phase, bytes, lines and statements so far, cancel. */
function OpenProgress({ tab }: { tab: Tab }) {
  const ws = useWorkspace()
  const j = tab.job
  return (
    <div className="panel-center">
      <section className="card open-progress" aria-labelledby={`op-${tab.key}`}>
        <h2 id={`op-${tab.key}`}>
          <BrandIcon motion="loop" />
          Opening <span className="mono">{tab.title}</span>
          {tab.live && <span className="badge-live">live</span>}
        </h2>
        <ul className="paths mono small muted">
          {tab.set.paths.map((p) => <li key={p}>{p}</li>)}
        </ul>
        <Progress tab={tab} />
        <dl className="stats">
          <div><dt>Lines</dt><dd className="mono">{j?.lines !== undefined ? fmtInt(j.lines) : '–'}</dd></div>
          <div><dt>Statements</dt><dd className="mono">{j?.statements !== undefined ? fmtInt(j.statements) : '–'}</dd></div>
          <div><dt>Phase</dt><dd>{j?.phase ?? '–'}</dd></div>
        </dl>
        <p className="actions">
          <button onClick={() => void ws.cancel(tab.key)} disabled={!j || j.state !== 'running'}>Cancel</button>
          <button className="quiet" onClick={() => ws.close(tab.key)}>Close tab</button>
        </p>
      </section>
    </div>
  )
}

function OpenFailed({ tab }: { tab: Tab }) {
  const ws = useWorkspace()
  const cancelled = tab.error === 'cancelled'
  return (
    <div className="panel-center">
      <section className={'card' + (cancelled ? '' : ' bad')} role="alert">
        <h2>{cancelled ? 'Cancelled' : 'Could not open'} <span className="mono">{tab.title}</span></h2>
        {!cancelled && <pre className="blocker-error">{tab.error}</pre>}
        <ul className="paths mono small muted">
          {tab.set.paths.map((p) => <li key={p}>{p}</li>)}
        </ul>
        <p className="actions">
          <button onClick={() => ws.retry(tab.key)}>Open again</button>
          <button className="quiet" onClick={() => ws.close(tab.key)}>Close tab</button>
        </p>
      </section>
    </div>
  )
}
