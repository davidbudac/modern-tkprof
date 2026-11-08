import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyEvent } from 'react'
import { isActivateKey, nextIndex } from '@lib/components/keyNav'
import { useConnections } from './ConnectionsProvider'
import { ConnectionForm, blankConnection } from './ConnectionForm'
import { DeskMenu } from '../ui/DeskMenu'
import { PencilIcon, TrashIcon } from '../ui/icons'
import { DbPanel } from './DbPanel'
import { RemoteBrowser } from './RemoteBrowser'
import { errorText, type ConnectionTest } from './api'
import { address, type ConnKind, type Entry } from './model'
import type { ConnStatus } from './persist'
import './connections.css'

/** `decorative` inside a button that names the kind itself: hidden from assistive tech rather than read twice. */
function KindIcon({ kind, decorative }: { kind: ConnKind; decorative?: boolean }) {
  const a11y = decorative ? ({ 'aria-hidden': true } as const) : ({ role: 'img', 'aria-label': kind === 'ssh' ? 'ssh' : 'database' } as const)
  return kind === 'ssh' ? (
    <svg className="kind-ico" viewBox="0 0 16 16" {...a11y}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
      <path d="M4 6l2.5 2L4 10M8 10.5h4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg className="kind-ico" viewBox="0 0 16 16" {...a11y}>
      <ellipse cx="8" cy="3.5" rx="5.5" ry="2" fill="none" stroke="currentColor" />
      <path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" fill="none" stroke="currentColor" />
    </svg>
  )
}

function ago(iso?: string): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

function StatusDot({ s }: { s?: ConnStatus }) {
  const state = s?.state ?? 'unknown'
  const title = state === 'unknown' ? 'not tested' : `${state === 'ok' ? 'ok' : 'error'}${s?.at ? `, tested ${ago(s.at)}` : ''}${s?.message ? `: ${s.message}` : ''}`
  return <span className="status-dot" data-state={state} title={title} aria-label={title} />
}

// the selection survives leaving the view (nav to the workspace and back)
let lastSelected: string | null = null

type Mode = { kind: 'view' } | { kind: 'edit' } | { kind: 'new'; connKind: ConnKind }

/** The Connections nav entry: the list on the left, the selected connection on the right. */
export function ConnectionsView() {
  const cx = useConnections()
  const { entries, status, loaded } = cx
  const [selId, setSelIdState] = useState<string | null>(lastSelected)
  const setSelId = (id: string | null) => {
    lastSelected = id
    setSelIdState(id)
  }
  const [mode, setMode] = useState<Mode>({ kind: 'view' })
  const [addOpen, setAddOpen] = useState(false)
  const sel = entries.find((e) => e.id === selId) ?? null
  // the list is one tab stop; the selected option is the active descendant and the arrow keys move it (a click does the same)
  const listId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const selIdx = entries.findIndex((e) => e.id === selId)
  const choose = (id: string) => {
    setSelId(id)
    setMode({ kind: 'view' })
  }
  const onListKey = (e: ReactKeyEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || entries.length === 0) return
    if (isActivateKey(e.key)) {
      if (selIdx < 0) return
      e.preventDefault()
      choose(entries[selIdx].id)
      return
    }
    const to = nextIndex(e.key, selIdx, entries.length)
    if (to == null) return
    e.preventDefault()
    choose(entries[to].id)
    listRef.current?.children[to]?.scrollIntoView({ block: 'nearest' })
  }

  useEffect(() => {
    if (mode.kind !== 'view') return
    // no selection, or a stale one (the selected connection was deleted): fall back to the first entry, or none
    if (entries.length && selIdx < 0) setSelId(entries[0].id)
    else if (!entries.length && selId && loaded) setSelId(null)
  }, [entries, selId, selIdx, loaded, mode.kind])

  const taken = entries.map((e) => e.id)
  return (
    <div className="conn-view">
      <aside className="conn-list">
        <div className="conn-toolbar" role="toolbar" aria-label="Connections">
          <DeskMenu label="+ Add" title="Add a connection" align="start" fixed open={addOpen} onOpenChange={setAddOpen}>
            <button onClick={() => setMode({ kind: 'new', connKind: 'ssh' })}>ssh host</button>
            <button onClick={() => setMode({ kind: 'new', connKind: 'db' })}>Oracle database</button>
            <hr />
            <button onClick={() => void cx.importFile()} title="Add the definitions of an mtkprof-connections.json">Import from file…</button>
          </DeskMenu>
          <span className="tb-sep" role="separator" />
          <TeamFile />
          <span className="tb-sep" role="separator" />
          <button onClick={() => void cx.exportFile()} disabled={!entries.length} title="Save all definitions as mtkprof-connections.json (no secrets)">Export…</button>
        </div>
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Connections"
          tabIndex={entries.length ? 0 : undefined}
          aria-activedescendant={selIdx >= 0 ? `${listId}-${selIdx}` : undefined}
          onKeyDown={onListKey}
        >
          {entries.map((e, i) => (
            <li key={e.id} id={`${listId}-${i}`} role="option" aria-selected={e.id === selId} onClick={() => choose(e.id)}>
              <KindIcon kind={e.kind} />
              <div className="conn-li-main">
                <div className="conn-li-name">
                  {e.name}
                  {e.source === 'team' && <span className="badge team">team</span>}
                  {e.source === 'override' && <span className="badge" title="A local definition overrides the team file's">team · local</span>}
                </div>
                <div className="conn-li-addr mono muted">{address(e)}</div>
              </div>
              <div className="conn-li-status">
                <StatusDot s={status[e.id]} />
                <span className="muted small">{status[e.id]?.at ? ago(status[e.id]?.at) : ''}</span>
              </div>
            </li>
          ))}
          {loaded && entries.length === 0 && (
            <li className="conn-empty muted" role="presentation">No connections yet. Add an ssh host or a database, import a file, or set a team file.</li>
          )}
        </ul>
      </aside>
      <main className="conn-detail">
        {mode.kind === 'new' ? (
          <ConnectionForm
            key={`new-${mode.connKind}`}
            initial={blankConnection(mode.connKind, taken)}
            isNew
            taken={taken}
            onCancel={() => setMode({ kind: 'view' })}
            onSave={(c) => {
              cx.save(c)
              setSelId(c.id)
              setMode({ kind: 'view' })
            }}
          />
        ) : mode.kind === 'edit' && sel ? (
          <ConnectionForm
            key={`edit-${sel.id}`}
            initial={sel}
            isNew={false}
            taken={taken}
            onCancel={() => setMode({ kind: 'view' })}
            onSave={(c, prevId) => {
              cx.save(c, prevId)
              setSelId(c.id)
              setMode({ kind: 'view' })
            }}
          />
        ) : sel ? (
          <Detail key={sel.id} conn={sel} onEdit={() => setMode({ kind: 'edit' })} />
        ) : entries.length === 0 ? (
          loaded && (
            <div className="empty conn-start">
              <p className="muted">No connections yet. Add one:</p>
              <ul>
                <li>
                  <button onClick={() => setMode({ kind: 'new', connKind: 'ssh' })}><KindIcon kind="ssh" decorative />ssh host</button>
                  <span className="muted">a host to fetch trace files from</span>
                </li>
                <li>
                  <button onClick={() => setMode({ kind: 'new', connKind: 'db' })}><KindIcon kind="db" decorative />database</button>
                  <span className="muted">an Oracle database to list sessions and start tracing</span>
                </li>
                <li>
                  <button onClick={() => void cx.importFile()}>Import…</button>
                  <span className="muted">the definitions of an mtkprof-connections.json</span>
                </li>
              </ul>
            </div>
          )
        ) : (
          <div className="empty">
            <p className="muted">Select a connection, or add one.</p>
          </div>
        )}
      </main>
    </div>
  )
}

function Detail({ conn, onEdit }: { conn: Entry; onEdit: () => void }) {
  const cx = useConnections()
  const st = cx.status[conn.id]
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ConnectionTest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [browse, setBrowse] = useState(st?.state === 'ok')

  const test = async () => {
    setTesting(true)
    setError(null)
    try {
      setResult(await cx.test(conn.id))
      setBrowse(true)
    } catch (e) {
      setResult(null)
      setError(errorText(e))
    } finally {
      setTesting(false)
    }
  }
  const forget = async () => {
    try {
      await cx.forget(conn.id)
      setResult(null)
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="conn-detail-inner">
      <header className="conn-head">
        <KindIcon kind={conn.kind} />
        <div>
          <h2>
            {conn.name}
            {conn.source === 'team' && <span className="badge team">team</span>}
            {conn.source === 'override' && <span className="badge">overrides team</span>}
          </h2>
          <div className="mono muted">
            {address(conn)}
            {conn.kind === 'ssh' && ` · transport ${conn.transport ?? 'auto'}`}
            {conn.kind === 'db' && conn.tcps && ` · TCPS${conn.tlsSkipVerify ? ' (unverified)' : ''}`}
            {conn.adrHome && ` · ADR ${conn.adrHome}`}
          </div>
        </div>
        <span className="spacer" />
        <button className="primary" onClick={() => void test()} disabled={testing}>{testing ? 'Testing…' : 'Test'}</button>
        <button onClick={() => void forget()} title="The engine drops the passwords and passphrases it holds for this connection">Forget credentials</button>
        {conn.source === 'team' ? (
          <button onClick={() => cx.overrideLocally(conn.id)} title="Copy into your local connections; the copy overrides the team file's">Override locally</button>
        ) : (
          <button className="icon-btn" onClick={onEdit} aria-label={`Edit ${conn.name}`} title="Edit"><PencilIcon /></button>
        )}
        {conn.source === 'override' && <button onClick={() => cx.remove(conn.id)} title="Drop the local copy">Revert to team</button>}
        {conn.source === 'local' && (
          <button className="danger icon-btn" onClick={() => window.confirm(`Delete ${conn.name}?`) && cx.remove(conn.id)} aria-label={`Delete ${conn.name}`} title="Delete"><TrashIcon /></button>
        )}
      </header>

      <div className="conn-test" data-state={error ? 'error' : result ? 'ok' : st?.state ?? 'unknown'}>
        <StatusDot s={error ? { state: 'error' } : result ? { state: 'ok' } : st} />
        {testing ? (
          <span className="muted">Connecting… answer the prompt if one appears.</span>
        ) : error ? (
          <span className="err">{error}</span>
        ) : result ? (
          <span>
            {result.server} · {result.transport}
            {result.diag && (
              <>
                {' '}· ADR home <code>{result.diag.adrHome}</code> · trace dir <code>{result.diag.traceDir}</code>
              </>
            )}
          </span>
        ) : st?.state === 'ok' ? (
          <span className="muted">ok {ago(st.at)}{st.server ? `: ${st.server}` : ''}{st.transport ? ` · ${st.transport}` : ''}</span>
        ) : st?.state === 'error' ? (
          <span className="err">{st.message}{st.at ? ` (${ago(st.at)})` : ''}</span>
        ) : (
          <span className="muted">Not tested. Passwords are asked on use and kept only in the engine's memory.</span>
        )}
      </div>
      {conn.notes && <p className="conn-notes">{conn.notes}</p>}

      {conn.kind === 'ssh' ? (
        browse ? (
          <RemoteBrowser conn={conn} />
        ) : (
          <p className="muted">
            <button onClick={() => setBrowse(true)}>Browse trace files</button>
          </p>
        )
      ) : (
        <DbPanel conn={conn} />
      )}
    </div>
  )
}

/** `Team file ▾`: a popover with the file's path (or none), Choose… / Clear, and what the engine made of it (status, problems). */
function TeamFile() {
  const { team, setTeamPath, chooseTeamFile } = useConnections()
  const [open, setOpen] = useState(false)
  // the list column clips its own overflow: the popover is fixed under the button
  const [at, setAt] = useState({ top: 0, left: 0 })
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setOpen(false) } }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  const trouble = !!team.error || team.problems.length > 0
  return (
    <span className="team-wrap" ref={root}>
      <button
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-pressed={open}
        title={team.path ?? 'No team file set'}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 24 * 16 - 8)) })
          setOpen(!open)
        }}
      >
        Team file{trouble && <span className="warn" role="img" aria-label="problems"> !</span>}<span className="cue" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="pop team-pop" role="dialog" aria-label="Team file" style={{ insetBlockStart: at.top, insetInlineStart: at.left }}>
          <h4>Team file</h4>
          {team.path ? (
            <p className="mono small team-path" title={team.path}>{team.path}</p>
          ) : (
            <p className="muted small">none. A shared mtkprof-connections.json (e.g. in a repo checkout), watched and merged read-only.</p>
          )}
          <p className="actions">
            <button onClick={() => void chooseTeamFile()}>{team.path ? 'Change…' : 'Choose…'}</button>
            {team.path && <button onClick={() => setTeamPath(null)}>Clear</button>}
          </p>
          {team.path && !team.error && team.loadedAt && (
            <p className="muted small">{team.connections.length} connections, re-read every 5 s</p>
          )}
          {team.error && <p className="err small" role="alert">Team file: {team.error}</p>}
          {team.problems.length > 0 && (
            <details className="small">
              <summary className="warn">{team.problems.length} problem{team.problems.length > 1 ? 's' : ''} in the team file</summary>
              <ul className="conn-problems">
                {team.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </span>
  )
}
