import { Fragment, useEffect, useState, type MouseEvent } from 'react'
import type { TraceDoc } from '../data/doc'
import { LINE_KINDS, type PageCache } from '../data/linecache'
import type { AtObjects } from '../data/lines'
import { decodeLine, type DecodeContext, type LineField } from '../data/linefields'
import { bindCell, cursorOfText, decodeAsText, refOfField } from '../data/inspecttext'
import { loadExecSummary, topWaits, type ExecSummary } from '../data/execsummary'
import { copyText } from '../data/clipboard'
import { fmtDur, fmtInt } from '../data/format'
import { Shimmer } from '../components/motion'

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
 * The Line tab of the Lines view's side panel: a head (the line number and kind, Follow and Copy), then sections on one grammar of a
 * label and its value: the line's fields (every field named, in a meaningful unit, beside the key of its token as written; the meaning
 * and the raw token are tooltips), the numbers of its execution and the bind set of a bind line. What the line belongs to and the ways
 * to its neighbours are in the breadcrumb above the viewer. It reads the cache while rendering: the view re-renders when a page arrives.
 */
export function LineInspector({ doc, cache, line, at, decodeCtx, note, onRef, follow, onFollow }: Props) {
  const cached = cache.line(line)
  const text = cached?.text
  const kind = cached ? LINE_KINDS[cached.kind] : undefined
  const d = cached && kind ? decodeLine(cached.text, kind, decodeCtx, { verbose: true, line }) : null
  const ba = cached ? decodeCtx.bindAt?.(line) : undefined
  // a Bind#N line: what its attribute lines say (the formatted view folds them under the bind's row)
  const bindAttrs: { line: number; fields: LineField[]; text: string; raw: boolean }[] = []
  if (text !== undefined && kind === 'bind-line' && /^\s*Bind#\d+/.test(text)) {
    for (let n = line + 1; n <= line + MAX_BIND_ATTRS; n++) {
      const l = cache.line(n)
      const k = l ? LINE_KINDS[l.kind] : undefined
      if (!l || (k !== 'bind-line' && k !== 'unknown') || /^\s*Bind#\d+/.test(l.text)) break
      const dd = decodeLine(l.text, k, decodeCtx, { verbose: true, line: n })
      bindAttrs.push({ line: n, fields: dd?.fields ?? [], text: l.text.trim(), raw: !dd || dd.fields.length === 0 })
    }
    // each attribute line's decode repeats the bind's own fields (Bind, Datatype, Value): once, in Fields above, is enough
    const seen = new Set((d?.fields ?? []).map((f) => `${f.label}\u0000${f.value}`))
    for (const a of bindAttrs) a.fields = a.fields.filter((f) => { const k = `${f.label}\u0000${f.value}`; if (seen.has(k)) return false; seen.add(k); return true })
  }

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
      <div className="insp-head">
        <h2 className="insp-title"><span>Line {fmtInt(line)}</span>{d?.kindLabel && <span className="insp-kind">{d.kindLabel}</span>}</h2>
        <div className="insp-acts">
          {onFollow && (
            <button type="button" className="quiet" aria-pressed={!!follow} onClick={() => onFollow(!follow)} aria-label="Follow the pointer"
              title="follow the pointer: show the line under the pointer instead of the selected line">Follow</button>
          )}
          <button type="button" className="quiet" onClick={() => void copy()} disabled={!d} title="copy the translated line as label: value (raw) lines">Copy</button>
        </div>
      </div>
      {text === undefined && !at && <p className="insp-empty">Click a line to inspect it.</p>}
      {text === undefined && at && <p className="insp-empty"><Shimmer>loading…</Shimmer></p>}

      {d && (
        <section className="insp-sec">
          <h3>Fields</h3>
          {(d.fields.length > 0 || cursorText) && (
            <dl className="insp-fields">
              {cursorText && (
                <div title="the cursor (its address in the server process) the line belongs to">
                  <dt>Cursor</dt>
                  <dd className="v">
                    {onRef ? refButton('cursor', cursorText, `#${cursorText}`) : `#${cursorText}`}
                    {cursorStmt && <span className="sub">{doc.label(cursorStmt)}</span>}
                  </dd>
                </div>
              )}
              {d.fields.map((f, i) => {
                // the meaning (and the decoder's hint) is the row's tooltip; the key of the token as written is the last column
                const ref = onRef ? refOfField(f) : null
                const tip = [f.desc, f.hint].filter(Boolean).join('\n')
                const key = keyOf(f)
                return (
                  <div key={i} title={tip || undefined}>
                    <dt>{breakable(f.label)}</dt>
                    <dd className="v">{ref ? refButton(ref.kind, ref.value, f.value) : keepDots(f.value)}</dd>
                    {key && <dd className="k" title={`as written in the trace: ${f.raw}`}>{key}</dd>}
                  </div>
                )
              })}
            </dl>
          )}
          {d.note && <p className="insp-note">{d.note}</p>}
          {d.fields.length === 0 && !cursorText && !d.note && <p className="insp-empty">Nothing to translate on this line.</p>}
        </section>
      )}

      {bindAttrs.length > 0 && (
        <section className="insp-sec">
          <h3>{text!.trim().replace(/\s.*$/, '')}: type, length, value</h3>
          <dl className="insp-fields">
            {bindAttrs.flatMap((a) => (!a.raw ? a.fields : [{ label: `line ${a.line}`, value: a.text, raw: a.text } as LineField]).map((f, i) => {
              const key = keyOf(f)
              return (
                <div key={`${a.line}:${i}`} title={[f.desc, f.hint, `line ${fmtInt(a.line)}`].filter(Boolean).join('\n')}>
                  <dt>{breakable(f.label)}</dt>
                  <dd className="v">{keepDots(f.value)}</dd>
                  {key && <dd className="k" title={`as written in the trace: ${f.raw}`}>{key}</dd>}
                </div>
              )
            }))}
          </dl>
        </section>
      )}

      {summary && o && summary.state !== 'none' && (
        <section className="insp-sec">
          <h3>Execution</h3>
          {summary.state === 'loading' || !summary.s ? <p className="insp-empty"><Shimmer>loading…</Shimmer></p> : <ExecBlock s={summary.s} eventName={eventName} refButton={refButton} hasRef={!!onRef} />}
        </section>
      )}

      {ba && ba.binds.length > 0 && (
        <section className="insp-sec">
          <h3>Binds</h3>
          <p className="insp-sub">Bind set #{ba.set} · {ba.binds.length} {ba.binds.length === 1 ? 'bind' : 'binds'}</p>
          <table className="insp-binds">
            <tbody>
              {ba.binds.map((b) => {
                const v = bindCell(b)
                return (
                  <tr key={b.pos} className={b.pos === ba.pos ? 'on' : undefined}>
                    <th scope="row">:{b.pos}</th>
                    <td className="ty" title={b.type}>{b.type}</td>
                    <td className={'val' + (b.isNull || b.noDef ? ' none' : '')} title={b.typed ? `${v}\n${b.typed}` : v}>{v}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

/** The attribute lines read under a `Bind#N` line (a memory dump goes on longer; the rest is in the trace). */
const MAX_BIND_ATTRS = 24

/** A label with a break opportunity after each slash (`sleeptime/senderid` wraps there, not inside a word). */
function breakable(label: string): React.ReactNode {
  if (!label.includes('/')) return label
  return label.split('/').map((part, i) => <Fragment key={i}>{i > 0 && <>/<wbr /></>}{part}</Fragment>)
}

/** A value whose ` · ` separators stay with the part before them: a wrapped value never starts a line with the dot or leaves it alone. */
function keepDots(value: string): string {
  return value.replaceAll(' · ', '\u00a0· ')
}

/** The trace key of a field's token as written (`ela` of `ela= 218`), or null: no `key=` token, or a key the label already reads as (`passes`). */
function keyOf(f: LineField): string | null {
  const m = f.raw ? /^([\w#/]+)=/.exec(f.raw) : null
  return m && m[1].toLowerCase() !== f.label.toLowerCase() ? m[1] : null
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

/**
 * The Execution section: the numbers of the line's execution, then its waits (the total, then the events by time; an event's numbers
 * only when there are several). Its start, end, binds and neighbours are in the breadcrumb and its Actions.
 */
function ExecBlock({ s, eventName, refButton, hasRef }: ExecBlockProps) {
  const nWaits = s.waits.reduce((a, w) => a + w.count, 0)
  const cells: [string, string][] = [
    ['Elapsed', fmtDur(s.elapsedUs)], ['CPU', fmtDur(s.cpuUs)], ['Rows', fmtInt(s.rows)], ['Fetches', fmtInt(s.fetches)],
    ['Disk reads', fmtInt(s.disk)], ['Buffer gets', fmtInt(s.gets)],
  ]
  const top = topWaits(s)
  const more = s.waits.length - top.length
  const several = s.waits.length > 1
  return (
    <>
      <p className="insp-sub">
        Exec {fmtInt(s.execNo)} of its cursor · {fmtInt(s.total)} {s.total === 1 ? 'execution' : 'executions'} of the statement
        {s.plh > 0 && <> · plan hash {hasRef ? refButton('plh', String(s.plh), String(s.plh)) : s.plh}</>}
        {s.hardParse && <> · hard parse</>}
      </p>
      <dl className="insp-exec">
        {cells.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <dl className="insp-waits" aria-label="Waits of this execution">
        <div>
          <dt>Waits</dt>
          {nWaits > 0 ? <><dd title="waits">{fmtInt(nWaits)}×</dd><dd title="time waited">{fmtDur(s.waitUs)}</dd></> : <dd className="none">none</dd>}
        </div>
        {top.map((w) => (
          <div key={w.event} className="ev">
            <dt>{hasRef ? refButton('event', eventName(w.event), eventName(w.event)) : eventName(w.event)}</dt>
            {several && <><dd>{fmtInt(w.count)}×</dd><dd>{fmtDur(w.us)}</dd></>}
          </div>
        ))}
        {more > 0 && <div className="ev"><dt className="faint">{fmtInt(more)} more {more === 1 ? 'event' : 'events'}</dt></div>}
      </dl>
    </>
  )
}
