import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { fmtBytes } from '@lib/data/format'
import { send, useEngine, type TracePeek } from '../engine'
import { FolderIcon } from '../ui/FolderIcon'
import { useWorkspace } from './WorkspaceProvider'
import { baseName } from './traceSet'
import type { FolderPick, OpenOptions } from './workspace'
import {
  DEFAULT_SORT, filterRows, fmtEnd, fmtSpan, fmtStamp, notSQL, peekBatches, selectionSummary, sessionsText, sessionsTitle, sortRows, toRows,
  type PickRow, type PickSort, type PickSortKey,
} from './folderPick'

/** Peek requests in flight at once. */
const PEEKS = 3
/** Rows drawn before "Show all". */
const ROWS = 300

/**
 * A folder opened on the open screen (DESIGN § Opening a folder): its trace files with what a quick
 * read of each found (traced time, sessions, size), to choose which to open. Nothing is opened
 * until the user does; files asked for by themselves beside the folder start selected.
 */
export function FolderPicker({ pick }: { pick: FolderPick }) {
  const ws = useWorkspace()
  const { client, status } = useEngine()
  const files = pick.list.files
  const [peeks, setPeeks] = useState<ReadonlyMap<string, TracePeek>>(() => new Map())
  const [sort, setSort] = useState<PickSort>(DEFAULT_SORT)
  const [filter, setFilter] = useState('')
  const [sqlOnly, setSqlOnly] = useState(true)
  const [all, setAll] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(files.filter((f) => !f.dir).map((f) => f.path)))
  const anchor = useRef<string | null>(null)

  // peek at every file, newest first, a few requests at a time; the table fills in as they come
  useEffect(() => {
    if (!client || status !== 'ready') return
    const ctl = new AbortController()
    const order = [...files].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
    const batches = peekBatches(order)
    let next = 0
    const run = async () => {
      while (next < batches.length && !ctl.signal.aborted) {
        const paths = batches[next++]
        let got: TracePeek[]
        try {
          got = (await send<{ files: TracePeek[] }>(client, 'POST', '/engine/peek', { paths }, ctl.signal)).files
        } catch (e) {
          if (ctl.signal.aborted) return
          const error = e instanceof Error ? e.message : String(e)
          got = paths.map((path) => ({ path, size: 0, modified: '', elapsedUs: 0, sqlTrace: false, sessions: [], sessionCount: 0, error }))
        }
        if (ctl.signal.aborted) return
        setPeeks((m) => {
          const n = new Map(m)
          for (const p of got) n.set(p.path, p)
          return n
        })
      }
    }
    for (let i = 0; i < PEEKS; i++) void run()
    return () => ctl.abort()
  }, [client, status, files])

  const rows = useMemo(() => toRows(files, peeks), [files, peeks])
  const shown = useMemo(() => sortRows(filterRows(rows, filter, sqlOnly), sort), [rows, filter, sqlOnly, sort])
  const hidden = sqlOnly ? notSQL(rows) : 0
  const drawn = all ? shown : shown.slice(0, ROWS)
  const chosen = useMemo(() => rows.filter((r) => selected.has(r.file.path)), [rows, selected])
  const sum = selectionSummary(chosen)
  const peeked = peeks.size
  const ready = status === 'ready'

  const sortBy = (key: PickSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' ? 1 : -1 }))
  const ariaSort = (key: PickSortKey) => (sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined)
  const arrow = (key: PickSortKey) => (sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : '')

  /** A click toggles the row; with Shift, every shown row from the last clicked one takes its new state. */
  const toggle = (path: string, range: boolean) => {
    setSelected((cur) => {
      const n = new Set(cur)
      const on = !cur.has(path)
      const a = anchor.current ? shown.findIndex((r) => r.file.path === anchor.current) : -1
      const b = shown.findIndex((r) => r.file.path === path)
      if (range && a >= 0 && b >= 0) {
        for (const r of shown.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? n.add(r.file.path) : n.delete(r.file.path)
      } else on ? n.add(path) : n.delete(path)
      return n
    })
    anchor.current = path
  }
  const allShown = shown.length > 0 && shown.every((r) => selected.has(r.file.path))
  const toggleAll = () =>
    setSelected((cur) => {
      const n = new Set(cur)
      for (const r of shown) allShown ? n.delete(r.file.path) : n.add(r.file.path)
      return n
    })

  /** Follow is one live file: a set of several opens without it. */
  const optionsFor = (n: number): OpenOptions => (n === 1 ? pick.options : { ...pick.options, follow: undefined })
  const openSet = (paths: string[]) => {
    if (!paths.length) return
    ws.closePick()
    ws.open({ paths, options: optionsFor(paths.length) })
  }
  const openEach = (paths: string[]) => {
    if (!paths.length) return
    ws.closePick()
    paths.forEach((p, i) => ws.open({ paths: [p], options: optionsFor(1) }, i === paths.length - 1))
  }
  // oldest first: the set's files (and the tabs of "each") in the order they were traced
  const paths = sortRows(chosen, { key: 'start', dir: 1 }).map((r) => r.file.path)
  const shownPaths = new Set(shown.map((r) => r.file.path))
  const offscreen = chosen.filter((r) => !shownPaths.has(r.file.path)).length

  // Esc clears the filter, then leaves the picker (wherever the focus is: a clicked row does not take it)
  const esc = useRef(() => {})
  esc.current = () => (filter ? setFilter('') : ws.closePick())
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
      e.preventDefault()
      esc.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const title = pick.list.dirs.length === 1 ? baseName(pick.list.dirs[0]) : `${pick.list.dirs.length} folders`
  const total = files.reduce((n, f) => n + f.size, 0)

  return (
    <div className="folder-pick">
      <div className="fp-back">
        <button onClick={() => ws.closePick()} aria-label="Back to the open screen">
          <span aria-hidden>←</span> Open a trace
        </button>
      </div>
      <header className="fp-head">
        <h1><FolderIcon className="folder-mark" /> <span>{title}</span></h1>
        <p className="muted small mono fp-paths">{pick.list.dirs.join(' · ')}</p>
        <p className="muted small">
          {files.length === 0
            ? 'No trace files (*.trc) in this folder.'
            : <>{files.length} trace file{files.length === 1 ? '' : 's'} · {fmtBytes(total)}{peeked < files.length && <> · reading {peeked} of {files.length}…</>}. Nothing is opened until you choose.</>}
        </p>
      </header>

      {files.length > 0 && (
        <>
          <div className="fp-bar">
            <input
              type="search"
              className="fp-filter"
              placeholder="Filter: name, session, module, service…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter the files"
              spellCheck={false}
            />
            <label className="check">
              <input type="checkbox" checked={sqlOnly} onChange={(e) => setSqlOnly(e.target.checked)} />
              Only SQL traces
            </label>
            {hidden > 0 && <span className="muted small">{hidden} without SQL trace hidden</span>}
          </div>

          <div className="fp-table-wrap">
            <table className="fp-table">
              <thead>
                <tr>
                  <th className="cb">
                    <input type="checkbox" checked={allShown} onChange={toggleAll} aria-label="Select all shown files" disabled={!shown.length} />
                  </th>
                  <th aria-sort={ariaSort('name')}><button className="fp-sort" onClick={() => sortBy('name')}>Name{arrow('name')}</button></th>
                  <th aria-sort={ariaSort('start')}><button className="fp-sort" onClick={() => sortBy('start')}>From{arrow('start')}</button></th>
                  <th aria-sort={ariaSort('end')}><button className="fp-sort" onClick={() => sortBy('end')}>To{arrow('end')}</button></th>
                  <th className="num" aria-sort={ariaSort('elapsed')}><button className="fp-sort" onClick={() => sortBy('elapsed')}>Traced{arrow('elapsed')}</button></th>
                  <th aria-sort={ariaSort('sessions')}><button className="fp-sort" onClick={() => sortBy('sessions')}>Sessions{arrow('sessions')}</button></th>
                  <th className="num" aria-sort={ariaSort('size')}><button className="fp-sort" onClick={() => sortBy('size')}>Size{arrow('size')}</button></th>
                </tr>
              </thead>
              <tbody>
                {drawn.map((r) => (
                  <Row
                    key={r.file.path}
                    row={r}
                    on={selected.has(r.file.path)}
                    onToggle={(e) => toggle(r.file.path, e.shiftKey)}
                    onOpen={() => ready && openSet([r.file.path])}
                  />
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted empty-row">
                      {filter ? 'Nothing matches the filter.' : 'No SQL trace among these files.'}{' '}
                      {sqlOnly && hidden > 0 && <button className="link" onClick={() => setSqlOnly(false)}>Show all files</button>}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {!all && shown.length > ROWS && (
              <p className="fp-more">
                <button onClick={() => setAll(true)}>Show all {shown.length} files</button>
              </p>
            )}
          </div>

          <div className="fp-actions">
            <span className="small">
              {sum.files === 0 ? (
                <span className="muted">Select the files to open (double-click opens one).</span>
              ) : (
                <>
                  <b>{sum.files} selected</b> · {fmtBytes(sum.bytes)}
                  {sum.start && <> · {fmtStamp(sum.start)} – {fmtEnd(sum.start, sum.end)}</>}
                  {offscreen > 0 && <span className="muted"> · {offscreen} not shown by the filter</span>}
                  {pick.options.follow && sum.files > 1 && <span className="muted"> · a set of several opens without follow</span>}
                </>
              )}
            </span>
            <span className="fp-buttons">
              {sum.files > 1 && <button disabled={!ready} onClick={() => openEach(paths)}>Open each in a tab</button>}
              <button className="primary" disabled={!ready || sum.files === 0} onClick={() => openSet(paths)}>
                {sum.files > 1 ? `Open ${sum.files} as one trace set` : 'Open'}
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function Row({ row, on, onToggle, onOpen }: { row: PickRow; on: boolean; onToggle: (e: MouseEvent) => void; onOpen: () => void }) {
  const p = row.peek
  const facts = p && !p.error ? [p.instance, p.process && `pid ${p.process}`, p.version].filter(Boolean).join(' · ') : ''
  return (
    <tr className={(on ? 'sel' : '') + (p && !p.error && !p.sqlTrace ? ' fp-nosql' : '')} onClick={onToggle} onDoubleClick={onOpen} aria-selected={on}>
      <td className="cb" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={on} readOnly onClick={onToggle} aria-label={`Select ${row.name}`} />
      </td>
      <td className="name" title={row.file.path}>
        <span className="mono fp-name">{row.name}</span>
        {(facts || p) && (
          <span className="fp-sub muted">
            {facts}
            {p?.error && <span className="fp-tag err">{p.error}</span>}
            {p && !p.error && !p.sqlTrace && <span className="fp-tag">no SQL trace</span>}
            {p?.continuedFrom && <span className="fp-tag" title={p.continuedFrom}>continued from {baseName(p.continuedFrom)}</span>}
            {p?.continuesIn && <span className="fp-tag" title={p.continuesIn}>continues in {baseName(p.continuesIn)}</span>}
            {p?.truncated && <span className="fp-tag">truncated</span>}
          </span>
        )}
      </td>
      {p ? (
        <>
          <td className="mono" title={p.start}>{fmtStamp(p.start) || '–'}</td>
          <td className="mono" title={p.end}>{fmtEnd(p.start, p.end) || '–'}</td>
          <td className="num">{fmtSpan(p.elapsedUs)}</td>
          <td className="fp-sessions" title={sessionsTitle(p)}>{sessionsText(p)}</td>
        </>
      ) : (
        <td colSpan={4} className="muted fp-reading">reading…</td>
      )}
      <td className="num">{fmtBytes(row.file.size)}</td>
    </tr>
  )
}
