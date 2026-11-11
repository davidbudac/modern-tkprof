import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefImportDialog, engineRefImporter } from '@lib'
import type { SessionInfo } from '../engine'
import { useConnections } from './ConnectionsProvider'
import { errorText, remoteApi, type DBSession, type DBTraceFile, type PlanStat } from './api'
import type { Entry } from './model'
import { pickDirectory } from './persist'

function fmtWhen(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p

/** db: server and ADR home, sessions with trace on/off, the ADR's trace files with fetch, reference data. */
export function DbPanel({ conn }: { conn: Entry }) {
  return (
    <div className="dbp">
      <DbSessions conn={conn} />
      <DbTraceFiles conn={conn} />
      <RefData conn={conn} />
    </div>
  )
}

function DbSessions({ conn }: { conn: Entry }) {
  const { run, notify } = useConnections()
  const [rows, setRows] = useState<DBSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [waits, setWaits] = useState(true)
  const [binds, setBinds] = useState(true)
  const [planStat, setPlanStat] = useState<PlanStat>('all_executions')
  const [filter, setFilter] = useState('')
  const [pending, setPending] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRows((await run(conn.id, (cl) => remoteApi.sessions(cl, conn.id))).sessions)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [run, conn.id])

  const toggle = async (s: DBSession) => {
    const enable = s.sqlTrace !== 'ENABLED'
    const key = `${s.sid},${s.serial}`
    setPending(key)
    try {
      const r = await run(conn.id, (cl) =>
        remoteApi.trace(cl, conn.id, s.self ? { self: true, enable } : { sid: s.sid, serial: s.serial, enable, waits, binds, planStat }),
      )
      notify(
        r.enabled
          ? `Trace on for ${s.username} (${key})${r.traceFile ? `: ${base(r.traceFile)}` : ''}`
          : `Trace off for ${s.username} (${key})`,
      )
      await load()
    } catch (e) {
      notify(`Trace ${enable ? 'on' : 'off'} failed: ${errorText(e)}`, 'error')
    } finally {
      setPending(null)
    }
  }

  const f = filter.trim().toLowerCase()
  const shown = (rows ?? []).filter(
    (s) => !f || [s.username, s.program, s.module, s.machine, s.osuser, s.sqlId, String(s.sid)].some((v) => v?.toLowerCase().includes(f)),
  )
  return (
    <section className="dbp-sec">
      <header>
        <h3>Sessions</h3>
        <span className="muted">V$SESSION, type USER</span>
        <span className="spacer" />
        <input type="search" placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter sessions" />
        <button onClick={() => void load()} disabled={loading}>{rows ? 'Refresh' : 'Load sessions'}</button>
      </header>
      <div className="dbp-opts">
        <span className="muted">Trace on with</span>
        <label className="check"><input type="checkbox" checked={waits} onChange={(e) => setWaits(e.target.checked)} /> waits</label>
        <label className="check"><input type="checkbox" checked={binds} onChange={(e) => setBinds(e.target.checked)} /> binds</label>
        <label className="check">
          plan_stat
          <select value={planStat} onChange={(e) => setPlanStat(e.target.value as PlanStat)}>
            <option value="all_executions">all_executions</option>
            <option value="first_execution">first_execution</option>
            <option value="never">never</option>
          </select>
        </label>
        <span className="muted small">DBMS_MONITOR (needs EXECUTE on it); the own session uses DBMS_SESSION with waits, binds, all_executions.</span>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {rows && (
        <div className="dbp-table-wrap">
          <table className="rb-table">
            <thead>
              <tr>
                <th className="num">SID</th>
                <th className="num">Serial#</th>
                <th>User</th>
                <th>Program</th>
                <th>Module</th>
                <th>Status</th>
                <th className="mono">SQL_ID</th>
                <th>Trace</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const key = `${s.sid},${s.serial}`
                const on = s.sqlTrace === 'ENABLED'
                return (
                  <tr key={key} className={s.self ? 'self' : ''}>
                    <td className="num">{s.sid}</td>
                    <td className="num">{s.serial}</td>
                    <td>
                      {s.username}
                      {s.self && <span className="badge">this</span>}
                    </td>
                    <td title={s.machine ? `${s.osuser ?? ''}@${s.machine}` : undefined}>{s.program}</td>
                    <td title={s.action}>{s.module}</td>
                    <td className={s.status === 'ACTIVE' ? 'active' : 'muted'}>{s.status}</td>
                    <td className="mono">{s.sqlId}</td>
                    <td>
                      <span className={'trace-state ' + (on ? 'on' : 'off')}>{on ? 'on' : 'off'}</span>
                    </td>
                    <td className="act">
                      <button onClick={() => void toggle(s)} disabled={pending !== null} title={s.traceFile || undefined}>
                        {pending === key ? '…' : on ? 'Trace off' : 'Trace on'}
                      </button>
                    </td>
                  </tr>
                )
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted empty-row">No sessions{f ? ' match' : ''}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function DbTraceFiles({ conn }: { conn: Entry }) {
  const { run, trackJob, notify, entries } = useConnections()
  const [rows, setRows] = useState<DBTraceFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [since, setSince] = useState('1d')
  const [sid, setSid] = useState('')
  const [serial, setSerial] = useState('')
  const [autoOpen, setAutoOpen] = useState(true)
  const sshTwin = entries.find((e) => e.kind === 'ssh' && e.host === conn.host)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const q = { since: since || undefined, sid: sid ? Number(sid) : undefined, serial: serial ? Number(serial) : undefined }
      setRows((await run(conn.id, (cl) => remoteApi.tracefiles(cl, conn.id, q))).files)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [run, conn.id, since, sid, serial])

  const fetchOne = async (f: DBTraceFile) => {
    try {
      const r = await run(conn.id, (cl) => remoteApi.fetchDb(cl, conn.id, f.name, f.adrHome))
      trackJob(r.job, `fetch ${f.name} from ${conn.name} (ADR)`, autoOpen)
    } catch (e) {
      notify(`Fetch failed: ${errorText(e)}`, 'error')
    }
  }

  return (
    <section className="dbp-sec">
      <header>
        <h3>Trace files</h3>
        <span className="muted">V$DIAG_TRACE_FILE, newest first</span>
      </header>
      <form
        className="dbp-opts"
        onSubmit={(e) => {
          e.preventDefault()
          void load()
        }}
      >
        <label className="check">
          modified within
          <input type="text" className="short" value={since} onChange={(e) => setSince(e.target.value)} placeholder="1d" aria-label="Since (2h, 30m, 1d or RFC 3339)" />
        </label>
        <label className="check">
          SID <input type="text" inputMode="numeric" className="short" value={sid} onChange={(e) => setSid(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="check">
          serial# <input type="text" inputMode="numeric" className="short" value={serial} onChange={(e) => setSerial(e.target.value.replace(/\D/g, ''))} />
        </label>
        <button type="submit" disabled={loading}>{rows ? 'Refresh' : 'List files'}</button>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} /> open when done
        </label>
      </form>
      <p className="note small">
        The ADR view reads about 0.4–1 MB/s (2–5 min for 100 MB): above ~200 MB fetch over SSH instead
        {sshTwin ? <> (<b>{sshTwin.name}</b> reaches the same host)</> : ' (add an ssh connection to the database host)'}.
        Sizes are not known before the fetch; the job says when it passes 200 MB.
      </p>
      {error && <p className="err" role="alert">{error}</p>}
      {rows && (
        <div className="dbp-table-wrap">
          <table className="rb-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Modified</th>
                <th className="num">SID</th>
                <th className="num">Serial#</th>
                <th>User</th>
                <th className="num">Con</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={`${f.adrHome}/${f.name}`} className="trc">
                  <td className="name mono" title={f.path || `${f.adrHome}/trace/${f.name}`}>
                    {f.name}
                    {f.fromProcess && <span className="badge" title="V$DIAG_TRACE_FILE not readable: the file a live session writes">process</span>}
                  </td>
                  <td>{fmtWhen(f.modified)}</td>
                  <td className="num">{f.sid ?? ''}</td>
                  <td className="num">{f.serial ?? ''}</td>
                  <td>{f.username ?? ''}</td>
                  <td className="num">{f.conId ?? ''}</td>
                  <td className="act">
                    <button onClick={() => void fetchOne(f)}>Fetch</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted empty-row">No trace files</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function RefData({ conn }: { conn: Entry }) {
  const { client, run, trackJob, notify, bridge } = useConnections()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [target, setTarget] = useState('')
  const [lite, setLite] = useState(false)
  const [pasting, setPasting] = useState(false)
  // the target session's ref routes, for the Import names dialog
  const importer = useMemo(
    () => (client && target ? engineRefImporter({ base: client.base, token: client.token, fetch: (p, init) => client.fetch(`/s/${encodeURIComponent(target)}${p}`, init) }) : null),
    [client, target],
  )

  const load = useCallback(async () => {
    if (!client) return
    try {
      // a bundle is kept per trace identity; a live session has none
      // (an optimizer (10053) trace has no object, file or user ids to name: its sessions are not offered)
      const list = (await remoteApi.sessionsList(client)).sessions.filter((s) => s.state === 'ready' && s.identity && !s.optSqlIds)
      setSessions(list)
      const active = bridge.activeSession?.()
      setTarget((t) => (t && list.some((s) => s.id === t) ? t : list.find((s) => s.id === active)?.id ?? list[0]?.id ?? ''))
    } catch {
      setSessions([])
    }
  }, [client, bridge])
  useEffect(() => {
    void load()
  }, [load])

  const fromDb = async () => {
    if (!target) return
    try {
      const r = await run(conn.id, (cl) => remoteApi.ref(cl, target, { connection: conn.id, lite }))
      trackJob(r.job, `reference data from ${conn.name}${lite ? ' (lite)' : ''}`)
    } catch (e) {
      notify(`Reference data failed: ${errorText(e)}`, 'error')
    }
  }
  const fromDir = async () => {
    if (!target || !client) return
    const dir = await pickDirectory('Reference bundle directory')
    if (!dir) return
    try {
      const r = await remoteApi.ref(client, target, { dir })
      trackJob(r.job, `reference bundle from ${base(dir)}`)
    } catch (e) {
      notify(`Applying the bundle failed: ${errorText(e)}`, 'error')
    }
  }

  const label = (s: SessionInfo) => s.files.map((f) => f.name).join(', ') || s.paths.map(base).join(', ')
  const targetSession = sessions.find((s) => s.id === target)
  const targetLabel = targetSession ? label(targetSession) : undefined
  return (
    <section className="dbp-sec">
      <header>
        <h3>Reference data</h3>
        <span className="muted">object, user and file names and plans for a trace (docs/REF-BUNDLE.md)</span>
      </header>
      <div className="dbp-opts">
        <label className="check">
          for
          <select value={target} onChange={(e) => setTarget(e.target.value)} onFocus={() => void load()} aria-label="Session">
            {sessions.length === 0 && <option value="">no open trace (live sessions have no bundle)</option>}
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{label(s)}</option>
            ))}
          </select>
        </label>
        <label className="check" title="ALL_ views only: no extra grants needed, no datafile names">
          <input type="checkbox" checked={lite} onChange={(e) => setLite(e.target.checked)} /> lite
        </label>
        <button className="primary" onClick={() => void fromDb()} disabled={!target}>Fetch reference data</button>
        <button onClick={() => void fromDir()} disabled={!target}>Apply bundle from directory…</button>
        <button onClick={() => setPasting(true)} disabled={!importer} title="Run a script yourself (SQL*Plus, SQL Developer) and paste what it prints: no connection needed">Paste script output…</button>
      </div>
      <p className="note small">Runs the queries of <code>mtkprof refscript</code> on this connection; queries the user may not run are skipped (the job says which) and DBA_ views fall back to ALL_ ones. Without a connection: <b>Paste script output…</b> gives a script to run elsewhere and takes what it prints. The open tab refreshes when the names are applied.</p>
      {importer && (
        <RefImportDialog open={pasting} importer={importer} onClose={() => setPasting(false)} subject={targetLabel} />
      )}
    </section>
  )
}
