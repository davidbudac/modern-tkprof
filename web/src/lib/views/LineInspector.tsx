import { useEffect, useState, type MouseEvent } from 'react'
import type { TraceDoc } from '../data/doc'
import { LINE_KINDS, type PageCache } from '../data/linecache'
import type { AtObjects } from '../data/lines'
import { decodeLine, type DecodeContext } from '../data/linefields'
import { bindCell, cursorOfText, decodeAsText, refOfField } from '../data/inspecttext'
import { loadExecSummary, topWaits, type ExecSummary } from '../data/execsummary'
import { copyText } from '../data/clipboard'
import { fmtDur, fmtInt } from '../data/format'

/** What a click on a reference value tells the owner. */
export type InspectRefKind = 'cursor' | 'sqlid' | 'plh' | 'obj' | 'event'

interface Props {
  doc: TraceDoc
  cache: PageCache
  /** the selected line */
  line: number
  /** what is at the line (`useLineAt`'s answer), null while unknown */
  at: { line: number; objs: AtObjects } | null
  decodeCtx: DecodeContext
  note: (msg: string) => void
  /** a click on a reference value (cursor number, sql_id, plan hash, object id, wait event name): the owner opens the same popup as for the row links; Shift is passed through */
  onRef?(kind: InspectRefKind, value: string, e: { shiftKey: boolean; x: number; y: number; anchor?: DOMRect }): void
  /** the owner shows the line under the pointer (true) or the selected line (false); with `onFollow` the head shows the checkbox */
  follow?: boolean
  onFollow?(v: boolean): void
}

type Summary = { key: string; state: 'loading' | 'none' | 'ok'; s?: ExecSummary }

/**
 * The Line tab of the Lines view's side panel: the selected line translated (every field named, in a meaningful unit, beside its raw
 * token; the meaning is the row's tooltip), the numbers of its execution and the bind set of a bind line. What the line belongs to and
 * the ways to its neighbours are in the breadcrumb above the viewer. It reads the cache while rendering: the view re-renders when a page arrives.
 */
export function LineInspector({ doc, cache, line, at, decodeCtx, note, onRef, follow, onFollow }: Props) {
  const cached = cache.line(line)
  const text = cached?.text
  const kind = cached ? LINE_KINDS[cached.kind] : undefined
  const d = cached && kind ? decodeLine(cached.text, kind, decodeCtx, { verbose: true, line }) : null
  const ba = cached ? decodeCtx.bindAt?.(line) : undefined

  const o = at?.objs
  // a line that starts with `#N` gets a first Cursor row, unless the decoder emits one itself (BINDS)
  const cursorText = text !== undefined && d && !d.fields.some((f) => f.label === 'Cursor') ? cursorOfText(text) : null
  const cursorStmt = o && o.stmt >= 0 ? doc.statements[o.stmt] : undefined
  const hasExec = !!o && o.stmt >= 0 && o.cursor >= 0 && o.execNo >= 1
  const execKey = hasExec ? `${o.stmt}:${o.cursor}:${o.execNo}` : ''
  const [exec, setExec] = useState<Summary | null>(null)
  const stmt = o?.stmt ?? -1, cursorNo = o?.cursor ?? -1, execNo = o?.execNo ?? -1
  useEffect(() => {
    if (!execKey) { setExec(null); return }
    const ac = new AbortController()
    setExec({ key: execKey, state: 'loading' })
    loadExecSummary(doc, stmt, cursorNo, execNo, ac.signal)
      .then((s) => { if (!ac.signal.aborted) setExec(s ? { key: execKey, state: 'ok', s } : { key: execKey, state: 'none' }) })
      .catch(() => { if (!ac.signal.aborted) setExec({ key: execKey, state: 'none' }) })
    return () => ac.abort()
  }, [doc, execKey, stmt, cursorNo, execNo])
  const summary = exec && exec.key === execKey && hasExec ? exec : null
  const eventName = (id: number) => doc.events[id]?.name ?? `event ${id}`

  const copy = async () => {
    if (!d) return
    const text = decodeAsText(d, line, summary?.state === 'ok' ? summary.s : null, eventName)
    note((await copyText(text)) ? 'Copied the translated line' : 'Could not copy the translated line')
  }

  /** A reference value as a link that asks the owner for its popup. */
  const refButton = (kind: InspectRefKind, value: string, shown: string) => (
    <button type="button" className="link" title={refTitle[kind]} onClick={(e: MouseEvent<HTMLButtonElement>) => onRef?.(kind, value, { shiftKey: e.shiftKey, x: e.clientX, y: e.clientY, anchor: e.currentTarget.getBoundingClientRect() })}>{shown}</button>
  )

  return (
    <div className="lines-inspect" aria-label="Line inspector" role="region">
      <div className="lines-inspect-head">
        <span className="mono">Line {fmtInt(line)}</span>
        {d?.kindLabel && <span className="lines-kind">{d.kindLabel}</span>}
        {onFollow && (
          <label className="insp-follow" title="show the line under the pointer instead of the selected line">
            <input type="checkbox" checked={!!follow} onChange={(e) => onFollow(e.target.checked)} /> Follow the pointer
          </label>
        )}
        <button type="button" className="quiet" onClick={() => void copy()} disabled={!d} title="copy the translated line as label: value (raw) lines">Copy</button>
      </div>
      {text === undefined && !at && <p className="muted">Click a line to inspect it.</p>}
      {text === undefined && at && <p className="muted">loading…</p>}

      {d && (
        <>
          <h3>Translated</h3>
          {(d.fields.length > 0 || cursorText) && (
            <table className="lines-inspect-fields">
              <tbody>
                {cursorText && (
                  <tr title="the cursor (its address in the server process) the line belongs to">
                    <th scope="row">Cursor</th>
                    <td>
                      <span className="v">{onRef ? refButton('cursor', cursorText, `#${cursorText}`) : `#${cursorText}`}</span>
                      {cursorStmt && <span className="raw">{doc.label(cursorStmt)}</span>}
                    </td>
                  </tr>
                )}
                {d.fields.map((f, i) => {
                  // value and raw token on one line; the meaning (and the decoder's hint) is the row's tooltip
                  const ref = onRef ? refOfField(f) : null
                  const tip = [f.desc, f.hint].filter(Boolean).join('\n')
                  return (
                    <tr key={i} title={tip || undefined}>
                      <th scope="row">{f.label}</th>
                      <td>
                        <span className="v">{ref ? refButton(ref.kind, ref.value, f.value) : f.value}</span>
                        {f.raw && f.raw !== f.value && <span className="raw">{f.raw}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {d.note && <p className="muted lines-inspect-note">{d.note}</p>}
          {d.fields.length === 0 && !cursorText && !d.note && <p className="muted">Nothing to translate on this line.</p>}
        </>
      )}

      {summary && o && summary.state !== 'none' && (
        <>
          <h3>Execution</h3>
          {summary.state === 'loading' || !summary.s ? <p className="muted">loading…</p> : <ExecBlock s={summary.s} eventName={eventName} refButton={refButton} hasRef={!!onRef} />}
        </>
      )}

      {ba && ba.binds.length > 0 && (
        <>
          <h3>Binds</h3>
          <p className="lines-inspect-sub">Bind set #{ba.set} · {ba.binds.length} {ba.binds.length === 1 ? 'bind' : 'binds'}</p>
          <table className="lines-inspect-binds">
            <tbody>
              {ba.binds.map((b) => {
                const v = bindCell(b)
                return (
                  <tr key={b.pos} className={b.pos === ba.pos ? 'on' : undefined}>
                    <th scope="row">:{b.pos}</th>
                    <td className="ty">{b.type}</td>
                    <td className={'val' + (b.isNull || b.noDef ? ' muted' : '')} title={b.typed ? `${v}\n${b.typed}` : v}>{v}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

const refTitle: Record<InspectRefKind, string> = {
  cursor: 'open the cursor (Shift: keep the current popup)', sqlid: 'open the statement (Shift: keep the current popup)', plh: 'open the plan (Shift: keep the current popup)',
  obj: 'open the object (Shift: keep the current popup)', event: 'open the wait event (Shift: keep the current popup)',
}

interface ExecBlockProps {
  s: ExecSummary
  eventName: (id: number) => string
  refButton: (kind: InspectRefKind, value: string, shown: string) => React.ReactNode
  hasRef: boolean
}

/** The EXECUTION section: the numbers of the line's execution and its top waits (its start, end, binds and neighbours are in the breadcrumb and its Actions). */
function ExecBlock({ s, eventName, refButton, hasRef }: ExecBlockProps) {
  const nWaits = s.waits.reduce((a, w) => a + w.count, 0)
  const cells: [string, string][] = [
    ['Elapsed', fmtDur(s.elapsedUs)], ['CPU', fmtDur(s.cpuUs)], ['Rows', fmtInt(s.rows)], ['Fetches', fmtInt(s.fetches)],
    ['Disk reads', fmtInt(s.disk)], ['Buffer gets', fmtInt(s.gets)], ['Waits', `${fmtInt(nWaits)} · ${fmtDur(s.waitUs)}`],
  ]
  return (
    <div className="insp-exec">
      <p className="lines-inspect-sub">
        exec {fmtInt(s.execNo)} of its cursor · {fmtInt(s.total)} {s.total === 1 ? 'execution' : 'executions'} of the statement
        {s.plh > 0 && <> · plan hash {hasRef ? refButton('plh', String(s.plh), String(s.plh)) : s.plh}</>}
        {s.hardParse && <> · hard parse</>}
      </p>
      <dl className="insp-exec-grid">
        {cells.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {s.waits.length > 0 && (
        <ul className="insp-exec-waits" aria-label="Top waits of this execution">
          {topWaits(s).map((w) => (
            <li key={w.event}>
              {hasRef ? refButton('event', eventName(w.event), eventName(w.event)) : <span>{eventName(w.event)}</span>}
              <span className="muted"> · {fmtInt(w.count)} · {fmtDur(w.us)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
