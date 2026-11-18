// The PGA readings: `pga-summary` (the dump's own tables of a PGA memory summary, read as tables: the top uses of the process, the private heap summary by depth,
// the memory of each Oracle process, the estimated uses for all processes, the swap lines) and `pga-detail` (a pga_detail_dump with exact bytes). Every row links
// to its line. The summary's figures are rounded and it has no total to check them against: the reading says so and no row is green or red.
import { Fragment, useMemo, type ReactNode } from 'react'
import { fmtInt } from '../../../data/format'
import { sortRows, toggleSort, type Sort } from '../../../data/diagheap'
import { normalizePgaDetail, normalizePgaSummary, type PGAProc, type PGASize, type PGAUse } from '../../../data/diagreadings'
import { Bar, LineLink, SortTh, useReadingUi } from './parts'
import { registerReading, type ReadingProps } from './registry'

type Link = (line: number, text?: ReactNode) => ReactNode

const sizeText = (s: PGASize | undefined) => (s ? s.text : '')

/** A size as printed with its exact bytes as the tooltip. */
const Sz = ({ s }: { s: PGASize }) => <span title={`${fmtInt(s.bytes)} bytes`}>{s.text}</span>

// ---- the summary --------------------------------------------------------------------------------------------------------------------------------

export interface SummaryUi {
  ptab: 'top' | 'all'
  /** the process table's sort ('' col: the dump's own order) */
  sort: Sort
  /** the processes whose session detail is shown ("<line>") */
  open: string[]
  /** how many rows of the "all processes" table are shown */
  limit: number
}
export const initSummaryUi = (): SummaryUi => ({ ptab: 'top', sort: { col: '', dir: -1 }, open: [], limit: 200 })

export function PgaSummaryView({ node, reading, source, goLine }: ReadingProps) {
  const r = useMemo(() => normalizePgaSummary(reading), [reading])
  const [st, patch] = useReadingUi<SummaryUi>(source, node.id, initSummaryUi)
  const link: Link = (line, text) => <LineLink line={line} text={text} source={source} goLine={goLine} />
  const p = r.processes
  const maxTop = Math.max(1, ...r.top.map((u) => u.size.bytes))
  return (
    <div className="rd" data-reading="pga-summary">
      <header className="rd-head">
        <h3 className="rd-title">PGA memory summary</h3>
        <span className="rd-meta">lines {link(r.from)}–{link(r.to, fmtInt(r.to))} · {fmtInt(r.lines)} lines</span>
      </header>
      <p className="rd-note" role="note">{r.note}</p>

      {r.top.length > 0 && (
        <section className="rd-sec">
          <div className="rd-k">Top uses of this process {r.topLine ? link(r.topLine) : null}</div>
          <UseTable rows={r.top} unitHead="Chunks" link={link} max={maxTop} />
        </section>
      )}

      {r.private.length > 0 && (
        <section className="rd-sec">
          <div className="rd-k">Private heap summary <span className="rd-dim">(the heap and its sub-heaps by depth, as the dump sums them)</span></div>
          {r.private.map((b) => (
            <div className="rd-blk" key={b.line}>
              <div className="rd-blk-h">
                <b>{b.title}</b> {link(b.line)}
                <span className="rd-meta">
                  <Sz s={b.total} /> total
                  {b.commented && <> · {sizeText(b.commented)} commented</>}
                  {b.permanent && <> · {sizeText(b.permanent)} permanent</>}
                  {b.free && <> · {sizeText(b.free)} free</>}
                  {b.emptyExtents && <> · {sizeText(b.emptyExtents)} in empty extents</>}
                </span>
              </div>
              {b.rows.length > 0 && (
                <table className="rd-tbl rd-narrow">
                  <thead><tr><th className="num">Size</th><th className="num">Count</th><th>Comment</th><th className="num">Free held</th><th className="num">Line</th></tr></thead>
                  <tbody>
                    {b.rows.map((x) => (
                      <tr key={x.line}>
                        <td className="num"><Sz s={x.size} /></td>
                        <td className="num">{fmtInt(x.count)} <span className="rd-dim">{x.unit}</span></td>
                        <td className="mono wrap">{x.comment}</td>
                        <td className="num">{x.freeHeld ? <><Sz s={x.freeHeld} /> <span className="rd-dim">free</span></> : null}</td>
                        <td className="num">{link(x.line)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </section>
      )}

      {p && (
        <section className="rd-sec">
          <div className="rd-k">Memory per Oracle process {link(p.line)}</div>
          <div className="rd-actions">
            <div className="rd-seg" role="group" aria-label="Processes">
              <button type="button" aria-pressed={st.ptab === 'top'} onClick={() => patch({ ptab: 'top' })}>Top<span className="n">{fmtInt(p.top.length)}</span></button>
              <button type="button" aria-pressed={st.ptab === 'all'} onClick={() => patch({ ptab: 'all' })}>All<span className="n">{fmtInt(p.all.length + (p.allOmitted ?? 0))}</span></button>
            </div>
            {p.totalAllocated && <span>Total allocated <b className="rd-strong"><Sz s={p.totalAllocated} /></b>{st.ptab === 'top' ? ' (the percentages are of it)' : ''}</span>}
            {p.mga && <span>MGA used size accounted under PGA values: {p.mga}</span>}
          </div>
          <ProcTable rows={st.ptab === 'top' ? p.top : p.all} all={p.all} top={st.ptab === 'top'} st={st} patch={patch} link={link} omitted={st.ptab === 'all' ? p.allOmitted ?? 0 : 0} />
        </section>
      )}

      {r.estimated && (
        <section className="rd-sec">
          <div className="rd-k">Estimated uses for all processes {link(r.estimated.line)}
            <span className="rd-dim"> · from {fmtInt(r.estimated.snapshots)} {r.estimated.snapshots === 1 ? 'snapshot' : 'snapshots'} out of {fmtInt(r.estimated.processes)} processes</span></div>
          <UseTable rows={r.estimated.rows} unitHead="Processes" link={link} max={Math.max(1, ...r.estimated.rows.map((u) => u.size.bytes))} estimated />
          {r.estimated.omitted ? <p className="rd-note">{fmtInt(r.estimated.omitted)} more rows are not listed here.</p> : null}
        </section>
      )}

      {r.swap.length > 0 && (
        <section className="rd-sec">
          <div className="rd-k">Swap information</div>
          <dl className="rd-kv">
            {r.swap.map((s) => <Fragment key={s.line}><dt>{s.name}</dt><dd><span className="rd-mono">{s.value.trim()}</span> {link(s.line)}</dd></Fragment>)}
          </dl>
        </section>
      )}

      {r.instance.length > 0 && (
        <section className="rd-sec">
          <details className="rd-details">
            <summary>Instance-wide figures ({fmtInt(r.instance.length)} lines: SGA and the process counts)</summary>
            <dl className="rd-kv">
              {r.instance.map((i) => <Fragment key={i.line}><dt>{i.scope} · {i.name}</dt><dd><span className="rd-mono">{i.value}</span> {link(i.line)}</dd></Fragment>)}
            </dl>
          </details>
        </section>
      )}
    </div>
  )
}

/** The rows of "top uses" or "estimated uses": the share as the dump prints it with a bar, the size as printed, the count, the comment and where the chunks are. */
function UseTable({ rows, unitHead, link, max, estimated }: { rows: readonly PGAUse[]; unitHead: string; link: Link; max: number; estimated?: boolean }) {
  return (
    <div className="rd-tblwrap">
      <table className="rd-tbl rd-uses">
        <thead>
          <tr>
            <th className="num">Share</th><th className="bc" aria-hidden="true" /><th className="num">Size</th><th className="num">{unitHead}</th><th>Comment</th><th className="ty">Category</th><th>Heap</th>{estimated && <th className="num opt-col" title="The chunks of the line under the row">Chunks</th>}<th className="num">Line</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.line}>
              <td className="num">{u.percent !== undefined ? `${u.percent}%` : ''}</td>
              <td className="bc"><Bar frac={u.size.bytes / max} /></td>
              <td className="num"><Sz s={u.size} /></td>
              <td className="num">{fmtInt(u.count)} <span className="rd-dim">{u.unit}</span></td>
              <td className="mono wrap">{u.comment}</td>
              <td className="ty dim">{u.category ?? ''}</td>
              <td className="mono wrap" title={u.ds ? `ds=${u.ds}${u.dsParent ? `  dsprt=${u.dsParent}` : ''}` : undefined}>
                {u.heap ?? ''}
              </td>
              {estimated && <td className="num opt-col">{u.chunks ? fmtInt(u.chunks) : ''}</td>}
              <td className="num">{link(u.line)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ProcTable({ rows, all, top, st, patch, link, omitted }: { rows: readonly PGAProc[]; all: readonly PGAProc[]; top: boolean; st: SummaryUi; patch(p: Partial<SummaryUi>): void; link: Link; omitted: number }) {
  const sorted = useMemo(() => sortRows(rows, st.sort, {
    percent: (r: PGAProc) => r.percent, ospid: (r) => r.ospid, name: (r) => r.name, used: (r) => r.used.bytes, alloc: (r) => r.alloc.bytes, freeable: (r) => r.freeable?.bytes,
  }), [rows, st.sort])
  const shown = top ? sorted : sorted.slice(0, st.limit)
  const onSort = (col: string) => patch({ sort: toggleSort(st.sort, col, col === 'ospid' || col === 'name' ? 1 : -1) })
  const toggle = (key: string) => patch({ open: st.open.includes(key) ? st.open.filter((k) => k !== key) : [...st.open, key] })
  const sum = (f: (r: PGAProc) => number) => rows.reduce((s, r) => s + f(r), 0)
  const cols = top ? 8 : 7
  // the top list's rows carry no session detail of their own: the dump prints it under the process in the list of all processes
  const sessions = useMemo(() => new Map(all.filter((x) => x.session).map((x) => [x.ospid, x.session!])), [all])
  const maxAlloc = Math.max(1, ...rows.map((r) => r.alloc.bytes))
  return (
    <div className="rd-tblwrap">
      <table className="rd-tbl rd-procs">
        <thead>
          <tr>
            <th aria-hidden="true" />
            {top && <SortTh label="Share" col="percent" sort={st.sort} onSort={onSort} num />}
            <SortTh label="ospid" col="ospid" sort={st.sort} onSort={onSort} num />
            <SortTh label="Process" col="name" sort={st.sort} onSort={onSort} />
            <SortTh label="Used" col="used" sort={st.sort} onSort={onSort} num />
            <SortTh label="Allocated" col="alloc" sort={st.sort} onSort={onSort} num />
            <th className="bc" aria-hidden="true" />
            <SortTh label="Freeable" col="freeable" sort={st.sort} onSort={onSort} num />
            <th className="num">Line</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((x) => {
            const key = String(x.line)
            const open = st.open.includes(key)
            const session = x.session ?? sessions.get(x.ospid)
            return (
              <Fragment key={key}>
                <tr className={open ? 'rd-open' : undefined}>
                  <td className="nw">{session
                    ? <button type="button" className="rd-tw" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the session detail of process ${x.ospid}`} title="The session detail the dump prints under this process" onClick={() => toggle(key)}>{open ? '▾' : '▸'}</button>
                    : <span className="rd-tw none" />}</td>
                  {top && <td className="num">{x.percent !== undefined ? `${x.percent}%` : ''}</td>}
                  <td className="num mono">{x.ospid}</td>
                  <td className="mono">{x.name || <span className="rd-dim">(foreground)</span>}{x.pdb ? <span className="rd-dim"> ({x.pdb})</span> : null}</td>
                  <td className="num"><Sz s={x.used} /></td>
                  <td className="num"><Sz s={x.alloc} /></td>
                  <td className="bc"><Bar frac={x.alloc.bytes / maxAlloc} /></td>
                  <td className="num">{x.freeable ? <Sz s={x.freeable} /> : ''}</td>
                  <td className="num">{link(x.line)}</td>
                </tr>
                {open && session && (
                  <tr className="rd-open">
                    <td />
                    <td colSpan={cols}>
                      <div className="rd-session">
                        <dl className="rd-kv">
                          <dt>Session</dt><dd><span className="rd-mono">{session.sid}.{session.serial}</span> · Oracle pid {session.pid}{session.ospid ? ` · ospid ${session.ospid}` : ''}</dd>
                          {session.user && (<><dt>User</dt><dd><span className="rd-mono">{session.user}</span>{session.pdb ? <span className="rd-dim"> in {session.pdb}</span> : null}</dd></>)}
                          {session.program && (<><dt>Program</dt><dd>{session.program}{session.machine ? <span className="rd-dim"> on {session.machine}</span> : null}</dd></>)}
                          {session.image && (<><dt>Image</dt><dd className="rd-mono">{session.image}</dd></>)}
                          <dt>Lines</dt><dd>{link(session.from)}–{link(session.to, fmtInt(session.to))}</dd>
                        </dl>
                        {session.currentSql && session.currentSql !== '<none>' ? <pre className="rd-code">{session.currentSql}</pre> : <span className="rd-dim">No current SQL for this session.</span>}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
        <tfoot>
          <tr>
            <td />
            {top && <td />}
            <td colSpan={2}>{fmtInt(rows.length)} {rows.length === 1 ? 'process' : 'processes'}{omitted ? `, ${fmtInt(omitted)} more not listed` : ''}</td>
            <td className="num" title={`${fmtInt(sum((r) => r.used.bytes))} bytes`}>{fmtKb(sum((r) => r.used.bytes))}</td>
            <td className="num" title={`${fmtInt(sum((r) => r.alloc.bytes))} bytes`}>{fmtKb(sum((r) => r.alloc.bytes))}</td>
            <td />
            <td className="num" title={`${fmtInt(sum((r) => r.freeable?.bytes ?? 0))} bytes`}>{fmtKb(sum((r) => r.freeable?.bytes ?? 0))}</td>
            <td />
          </tr>
        </tfoot>
      </table>
      {!top && sorted.length > shown.length && (
        <p className="rd-note"><button type="button" className="rd-more" onClick={() => patch({ limit: st.limit + 200 })}>Show {fmtInt(Math.min(200, sorted.length - shown.length))} more</button> · {fmtInt(shown.length)} of {fmtInt(sorted.length)} shown</p>
      )}
    </div>
  )
}

/** Bytes as a figure of the dump's own kind: whole KB below 10 MB, whole MB above (the footer's sums). */
function fmtKb(bytes: number): string {
  return bytes >= 10 * 1048576 ? `${fmtInt(bytes / 1048576)} MB` : `${fmtInt(bytes / 1024)} KB`
}

// ---- the detail ---------------------------------------------------------------------------------------------------------------------------------

interface DetailUi { sort: Sort; limit: number }
const initDetailUi = (): DetailUi => ({ sort: { col: 'bytes', dir: -1 }, limit: 300 })

export function PgaDetailView({ node, reading, source, goLine }: ReadingProps) {
  const r = useMemo(() => normalizePgaDetail(reading), [reading])
  const [st, patch] = useReadingUi<DetailUi>(source, node.id, initDetailUi)
  const link: Link = (line, text) => <LineLink line={line} text={text} source={source} goLine={goLine} />
  const rows = useMemo(() => sortRows(r.rows, st.sort, {
    bytes: (u: PGAUse) => u.size.bytes, count: (u) => u.count, comment: (u) => u.comment, category: (u) => u.category, heap: (u) => u.heap, line: (u) => u.line,
  }), [r.rows, st.sort])
  const shown = rows.slice(0, st.limit)
  const max = Math.max(1, ...r.rows.map((u) => u.size.bytes))
  const onSort = (col: string) => patch({ sort: toggleSort(st.sort, col, col === 'comment' || col === 'category' || col === 'heap' || col === 'line' ? 1 : -1) })
  return (
    <div className="rd" data-reading="pga-detail">
      <header className="rd-head">
        <h3 className="rd-title">PGA memory detail{r.pid !== undefined ? <> for pid <span className="rd-mono">{r.pid}</span></> : null}{r.ospid !== undefined ? <>, OS pid <span className="rd-mono">{r.ospid}</span></> : null}</h3>
        <span className="rd-meta">lines {link(r.from)}–{link(r.to, fmtInt(r.to))} · {fmtInt(r.lines)} lines · sizes are exact bytes, as <span className="rd-mono">pga_detail_dump</span> prints them</span>
      </header>
      <p className="rd-note" role="note">
        The rows are a listing of the largest uses, not a total of the process: together they hold <b className="rd-strong">{fmtInt(r.bytes)}</b> bytes in {fmtInt(r.chunks)} {r.chunks === 1 ? 'chunk' : 'chunks'} ({fmtInt(r.rows.length)} {r.rows.length === 1 ? 'row' : 'rows'}{r.omitted ? `; ${fmtInt(r.omitted)} more rows are not listed` : ''}).
      </p>
      <section className="rd-sec">
        <div className="rd-tblwrap">
          <table className="rd-tbl rd-uses">
            <thead>
              <tr>
                <SortTh label="Bytes" col="bytes" sort={st.sort} onSort={onSort} num />
                <th className="bc" aria-hidden="true" />
                <SortTh label="Chunks" col="count" sort={st.sort} onSort={onSort} num />
                <SortTh label="Comment" col="comment" sort={st.sort} onSort={onSort} />
                <SortTh label="Category" col="category" sort={st.sort} onSort={onSort} className="ty" />
                <SortTh label="Heap" col="heap" sort={st.sort} onSort={onSort} />
                <SortTh label="Line" col="line" sort={st.sort} onSort={onSort} num />
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.line}>
                  <td className="num">{fmtInt(u.size.bytes)}</td>
                  <td className="bc"><Bar frac={u.size.bytes / max} /></td>
                  <td className="num">{fmtInt(u.count)}{u.unit !== 'chunks' ? <span className="rd-dim"> {u.unit}</span> : null}</td>
                  <td className="mono wrap">{u.comment}</td>
                  <td className="ty dim">{u.category ?? ''}</td>
                  <td className="mono wrap" title={u.ds ? `ds=${u.ds}${u.dsParent ? `  dsprt=${u.dsParent}` : ''}` : undefined}>{u.heap ?? ''}</td>
                  <td className="num">{link(u.line)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="num">{fmtInt(r.bytes)}</td>
                <td className="bc" />
                <td className="num">{fmtInt(r.chunks)}</td>
                <td colSpan={4}>{fmtInt(r.rows.length)} {r.rows.length === 1 ? 'row' : 'rows'}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {rows.length > shown.length && <p className="rd-note"><button type="button" className="rd-more" onClick={() => patch({ limit: st.limit + 300 })}>Show {fmtInt(Math.min(300, rows.length - shown.length))} more</button> · {fmtInt(shown.length)} of {fmtInt(rows.length)} rows shown</p>}
      </section>
    </div>
  )
}

registerReading('pga-summary', PgaSummaryView)
registerReading('pga-detail', PgaDetailView)
