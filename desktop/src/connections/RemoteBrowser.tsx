import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@lib/data/client'
import { fmtBytes } from '@lib/data/format'
import { useConnections } from './ConnectionsProvider'
import { errorText, remoteApi, type RemoteEntry, type RemoteListing } from './api'
import type { Entry } from './model'

type SortKey = 'name' | 'size' | 'modTime'

/** The last directory per connection (a UI preference, kept in the webview's localStorage). */
const LAST_KEY = 'mtkprof.connections.lastPaths'
const lastPaths = {
  all(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}') as Record<string, string>
    } catch {
      return {}
    }
  },
  get(id: string): string | undefined {
    return this.all()[id]
  },
  set(id: string, path: string) {
    localStorage.setItem(LAST_KEY, JSON.stringify({ ...this.all(), [id]: path }))
  },
}
const isTrace = (e: RemoteEntry) => !e.dir && /\.trc$/i.test(e.name)

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleString(undefined, { year: sameYear ? undefined : 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Parent directory of a remote (POSIX) path. */
export function parentOf(path: string): string {
  const p = path.replace(/\/+$/, '')
  const i = p.lastIndexOf('/')
  if (i <= 0) return '/'
  return p.slice(0, i)
}

/** Breadcrumb segments: [label, path] from the root. */
export function crumbs(path: string): [string, string][] {
  const abs = path.startsWith('/')
  const parts = path.split('/').filter(Boolean)
  const out: [string, string][] = abs ? [['/', '/']] : []
  parts.forEach((p, i) => out.push([p, (abs ? '/' : '') + parts.slice(0, i + 1).join('/')]))
  return out
}

/** ssh: candidate trace directories (`diag`), a directory listing (`ls`), fetch and follow. */
export function RemoteBrowser({ conn }: { conn: Entry }) {
  const { run, runOn, trackJob, bridge, notify } = useConnections()
  const [dirs, setDirs] = useState<string[] | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)
  const [path, setPath] = useState(lastPaths.get(conn.id) ?? '')
  const [typed, setTyped] = useState(path)
  const [listing, setListing] = useState<RemoteListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'modTime', dir: -1 })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [gzip, setGzip] = useState(true)
  const [autoOpen, setAutoOpen] = useState(true)
  const [busy, setBusy] = useState(false)

  const open = useCallback(
    async (p: string, signal?: AbortSignal) => {
      if (!p) return
      setLoading(true)
      setError(null)
      try {
        const l = await run(conn.id, (cl) => remoteApi.ls(cl, conn.id, p, signal))
        if (signal?.aborted) return
        setListing(l)
        setPath(l.path)
        setTyped(l.path)
        lastPaths.set(conn.id, l.path)
        setSelected(new Set())
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(errorText(e))
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [run, conn.id],
  )

  // diag once per connection; then the last directory, or the first candidate
  useEffect(() => {
    const ac = new AbortController()
    setDirs(null)
    setDiagError(null)
    setListing(null)
    run(conn.id, (cl) => remoteApi.diag(cl, conn.id)).then(
      (d) => {
        if (ac.signal.aborted) return
        setDirs(d.dirs)
        const start = lastPaths.get(conn.id) ?? d.dirs[0]
        if (start) void open(start, ac.signal)
      },
      (e) => {
        if (ac.signal.aborted) return
        setDiagError(errorText(e))
        const start = lastPaths.get(conn.id)
        if (start) void open(start, ac.signal)
      },
    )
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, conn.host, conn.port, conn.user, conn.transport])

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const list = (listing?.entries ?? []).filter((e) => !f || e.name.toLowerCase().includes(f))
    const { key, dir } = sort
    return list.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1
      const va = a[key]
      const vb = b[key]
      if (va === vb) return a.name.localeCompare(b.name)
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * dir
    })
  }, [listing, filter, sort])

  const files = rows.filter((e) => !e.dir)
  const chosen = files.filter((e) => selected.has(e.path))
  const toggle = (p: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(p)) n.delete(p)
      else n.add(p)
      return n
    })
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' ? 1 : -1 }))
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : '')

  const fetchSelected = async () => {
    if (!chosen.length) return
    setBusy(true)
    try {
      const r = await run(conn.id, (cl) => remoteApi.fetchSsh(cl, conn.id, chosen.map((e) => e.path), gzip))
      const label = `fetch ${chosen.length === 1 ? chosen[0].name : `${chosen.length} files`} from ${conn.name}`
      trackJob({ ...r.job, localPaths: r.job.localPaths ?? (r.job.state === 'done' ? r.localPaths : undefined) }, label, autoOpen)
      setSelected(new Set())
    } catch (e) {
      notify(`Fetch failed: ${errorText(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const follow = async () => {
    if (chosen.length !== 1) return
    const f = chosen[0]
    setBusy(true)
    try {
      const follow = async (cl: ApiClient) => {
        const r = await remoteApi.follow(cl, conn.id, f.path)
        trackJob(r.job, `follow ${f.name} on ${conn.name}`)
        if (!r.session) throw new Error('the engine answered without a session')
        return { session: r.session, job: r.job }
      }
      const r = await run(conn.id, follow)
      // after an engine restart the tab follows again (the connection is registered on the new engine first)
      bridge.attachSession(r, { title: f.name, live: true, reopen: (cl) => runOn(cl, conn.id, follow) })
      notify(`Following ${f.name}: a live tab is open; closing it stops the follow.`)
    } catch (e) {
      notify(`Follow failed: ${errorText(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const allChecked = files.length > 0 && files.every((e) => selected.has(e.path))
  return (
    <section className="rb">
      <div className="rb-quick">
        <span className="muted">Trace directories:</span>
        {dirs === null && !diagError && <span className="muted">looking…</span>}
        {dirs?.length === 0 && <span className="muted">none found (no oratab, no ORACLE_BASE); type a path</span>}
        {diagError && <span className="err">{diagError}</span>}
        {dirs?.map((d) => (
          <button key={d} className="chip mono" aria-pressed={d === path} onClick={() => void open(d)} title={d}>
            {d.replace(/^.*\/diag\/rdbms\//, '…/')}
          </button>
        ))}
      </div>

      <form
        className="rb-path"
        onSubmit={(e) => {
          e.preventDefault()
          void open(typed.trim())
        }}
      >
        <button type="button" onClick={() => void open(parentOf(path))} disabled={!path || path === '/'} title="Parent directory">
          ↑
        </button>
        <nav className="crumbs mono" aria-label="Path">
          {crumbs(path).map(([label, p], i, all) => (
            <span key={p}>
              {i > 0 && all[i - 1][0] !== '/' && <span className="sep">/</span>}
              <button type="button" className="link" onClick={() => void open(p)} disabled={i === all.length - 1}>
                {label}
              </button>
            </span>
          ))}
        </nav>
        <input type="text" className="mono grow" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="/u01/app/oracle/diag/rdbms/…/trace" aria-label="Remote path" />
        <button type="submit">Go</button>
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter" aria-label="Filter by name" className="rb-filter" />
      </form>

      {error && <p className="err" role="alert">{error}</p>}

      <div className="rb-table-wrap" aria-busy={loading}>
        <table className="rb-table">
          <thead>
            <tr>
              <th className="cb">
                <input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(files.map((e) => e.path)))} aria-label="Select all files" />
              </th>
              <th aria-sort={sort.key === 'name' ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined} onClick={() => sortBy('name')}>Name{arrow('name')}</th>
              <th className="num" onClick={() => sortBy('size')}>Size{arrow('size')}</th>
              <th onClick={() => sortBy('modTime')}>Modified{arrow('modTime')}</th>
              <th className="mono">Mode</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr
                key={e.path}
                className={[e.dir ? 'dir' : '', isTrace(e) ? 'trc' : '', selected.has(e.path) ? 'sel' : ''].join(' ')}
                onClick={() => (e.dir ? void open(e.path) : toggle(e.path))}
                onDoubleClick={() => !e.dir && isTrace(e) && setSelected(new Set([e.path]))}
              >
                <td className="cb" onClick={(ev) => ev.stopPropagation()}>
                  {!e.dir && <input type="checkbox" checked={selected.has(e.path)} onChange={() => toggle(e.path)} aria-label={`Select ${e.name}`} />}
                </td>
                <td className="name">
                  <span className="ico" aria-hidden>{e.dir ? '▸' : e.link ? '↪' : ''}</span>
                  {e.name}
                  {e.dir ? '/' : ''}
                </td>
                <td className="num">{e.dir ? '' : fmtBytes(e.size)}</td>
                <td>{fmtTime(e.modTime)}</td>
                <td className="mono muted">{e.mode}</td>
              </tr>
            ))}
            {!loading && listing && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted empty-row">{filter ? 'Nothing matches the filter' : 'Empty directory'}</td>
              </tr>
            )}
            {loading && !listing && (
              <tr>
                <td colSpan={5} className="muted empty-row">Listing…</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="rb-actions">
        <span className="muted">
          {listing ? `${files.length} files${files.length !== listing.entries.filter((e) => !e.dir).length ? ' shown' : ''}` : ''}
          {chosen.length > 0 && ` · ${chosen.length} selected, ${fmtBytes(chosen.reduce((a, e) => a + e.size, 0))}`}
        </span>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={gzip} onChange={(e) => setGzip(e.target.checked)} /> gzip in transit
        </label>
        <label className="check">
          <input type="checkbox" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} /> open when done
        </label>
        <button onClick={() => void follow()} disabled={busy || chosen.length !== 1} title="Live session over a growing file (tail -f)">
          Follow
        </button>
        <button className="primary" onClick={() => void fetchSelected()} disabled={busy || chosen.length === 0}>
          Fetch{chosen.length > 1 ? ` ${chosen.length}` : ''}
        </button>
      </footer>
    </section>
  )
}
