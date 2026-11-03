import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { TraceDoc } from '../data/doc'
import type { DecodeContext } from '../data/linefields'
import type { Event } from '../data/types'
import { fmtDur, fmtInt } from '../data/format'
import { copyText } from '../data/clipboard'
import type { Actions } from '../state/store'
import { StmtPopover, type PopupAnchor, type StmtPopup } from './StmtPopover'
import { usePopover } from './usePopover'
import { MorphText } from './motion'

export type { PopupAnchor }

/** An object popup: the `obj#` a reference named, the statement of its line (when there is one) and where it was clicked. */
export interface ObjPopup { kind: 'obj'; obj: number; stmt?: number; line: number; anchor: PopupAnchor }
/** A wait popup: the WAIT line whose event name was clicked (its text, and the statement of its line when known). */
/** `event`: the event name when the popup comes from a name alone (the inspector), where `text` is not the WAIT line. */
export interface WaitPopup { kind: 'wait'; line: number; text: string; event?: string; stmt?: number; anchor: PopupAnchor }
/** What a click on a reference in a row opens. */
export type LinePopup = ({ kind: 'stmt' } & StmtPopup) | ObjPopup | WaitPopup

interface Props { doc: TraceDoc; file: number; popup: LinePopup; ctx: DecodeContext; actions: Actions; onClose(): void; goTo(line: number): void }

/** The popover of a reference in a row: the statement, object or wait it names, placed and closed by `usePopover`. */
export function LinePopover({ doc, file, popup, ctx, actions, onClose, goTo }: Props): JSX.Element {
  switch (popup.kind) {
    case 'stmt': return <StmtPopover doc={doc} file={file} popup={popup} onClose={onClose} goTo={goTo} />
    case 'obj': return <ObjPopover doc={doc} file={file} popup={popup} ctx={ctx} actions={actions} onClose={onClose} goTo={goTo} />
    case 'wait': return <WaitPopover doc={doc} popup={popup} ctx={ctx} actions={actions} onClose={onClose} />
  }
}

/** A button that copies `text` and says "Copied" for a moment (only the letters that differ from the label cross-blur). */
function CopyButton({ text, label, title, first }: { text: string; label: string; title?: string; first?: boolean }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <button type="button" data-first={first || undefined} title={title} onClick={() => {
      void copyText(text).then((ok) => {
        if (!ok) return
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1500)
      })
    }}><MorphText text={copied ? 'Copied' : label} /></button>
  )
}

const MAX_ROWS = 12

interface ObjRow { line: number; op: string; object: string; rows: number; starts: number; cr: number }

/** The plan lines of the statement's plans in `file` that reference `obj`, as the lines they were printed on. */
function planLinesOfObj(doc: TraceDoc, file: number, stmt: number, obj: number): ObjRow[] {
  const out: ObjRow[] = []
  for (const p of doc.plansOf(stmt)) {
    if (p.line <= 0 || doc.fileOfCursor(p.cursor) !== file) continue
    for (let k = 0; k < p.n; k++) {
      const pl = doc.planLines[p.first + k]
      if (pl && pl.obj === obj) out.push({ line: p.line + k, op: pl.op, object: pl.object, rows: pl.rows, starts: pl.starts, cr: pl.cr })
    }
  }
  return out
}

function ObjPopover({ doc, file, popup, ctx, actions, onClose, goTo }: { doc: TraceDoc; file: number; popup: ObjPopup; ctx: DecodeContext; actions: Actions; onClose(): void; goTo(line: number): void }) {
  const root = usePopover(popup.anchor, onClose, [popup])
  const { obj, stmt } = popup
  const name = ctx.objectName?.(obj)
  const rows = useMemo(() => (stmt === undefined ? [] : planLinesOfObj(doc, file, stmt, obj)), [doc, file, stmt, obj])
  const st = stmt === undefined ? undefined : doc.statements[stmt]
  const done = (f: () => void) => () => { f(); onClose() }

  return createPortal(
    <div className="stmt-pop stmt-pop-obj" ref={root} role="dialog" aria-label={`Object ${name ?? obj}`} onKeyDown={(e) => e.stopPropagation()}>
      <div className="stmt-pop-h">
        <b className="mono">{name ?? `object ${obj}`}</b>
        <span className="muted mono">obj# {obj}</span>
        <button type="button" className="quiet stmt-pop-x" onClick={onClose} aria-label="Close" title="close (Esc)">×</button>
      </div>
      {st ? (
        rows.length > 0 ? (
          <div className="lpop-rows" role="list" aria-label="plan lines with this object">
            {rows.slice(0, MAX_ROWS).map((r) => (
              <div className="lpop-row" role="listitem" key={r.line}>
                <span className="lpop-op mono" title={r.op}>{r.op}</span>
                <span className="lpop-object muted">{r.object}</span>
                <span className="lpop-nums mono muted">
                  {r.rows > 0 && <span>rows {fmtInt(r.rows)}</span>}
                  {r.starts > 0 && <span>starts {fmtInt(r.starts)}</span>}
                  {r.cr > 0 && <span>cr {fmtInt(r.cr)}</span>}
                </span>
                <button type="button" className="lpop-go" onClick={done(() => goTo(r.line))} title={`go to line ${fmtInt(r.line)}`}>line {fmtInt(r.line)}</button>
              </div>
            ))}
            {rows.length > MAX_ROWS && <div className="muted lpop-more">and {fmtInt(rows.length - MAX_ROWS)} more</div>}
          </div>
        ) : <p className="muted lpop-note">not in this statement's plan</p>
      ) : <p className="muted lpop-note">no statement at this line</p>}
      <div className="stmt-pop-acts">
        <CopyButton first text={name ?? String(obj)} label="Copy name" title={name ? 'copy the object name' : 'copy the obj# (the trace has no name for it)'} />
        {st && <button type="button" onClick={done(() => actions.selectStmt(st.id))} title="open this statement in the Statements view">Open in Statements</button>}
      </div>
    </div>,
    document.body,
  )
}

/** The pieces of a WAIT line: the event, the elapsed µs, the printed parameters, the `obj#` and the `tim`. */
export interface WaitText { name: string; ela: number; params: { label: string; value: string }[]; obj?: number; tim?: number }

/** `WAIT #N: nam='…' ela= N p1=v p2=v p3=v obj#=N tim=N` taken apart; undefined for any other text. */
export function parseWait(text: string): WaitText | undefined {
  const m = /^WAIT\s+#\d+:\s*nam='(.*)'\s+ela=\s*(-?\d+)\s*(.*)$/.exec(text)
  if (!m) return undefined
  const [, name, ela, rest] = m
  const tail = rest.search(/\bobj#=|\btim=/)
  const params: WaitText['params'] = []
  for (const x of (tail < 0 ? rest : rest.slice(0, tail)).matchAll(/([^=]+)=(\S*)/g)) params.push({ label: x[1].trim(), value: x[2] })
  const num = (re: RegExp) => { const n = re.exec(tail < 0 ? '' : rest.slice(tail)); return n ? Number(n[1]) : undefined }
  return { name, ela: Number(ela), params, obj: num(/\bobj#=(-?\d+)/), tim: num(/\btim=(\d+)/) }
}

function WaitPopover({ doc, popup, ctx, actions, onClose }: { doc: TraceDoc; popup: WaitPopup; ctx: DecodeContext; actions: Actions; onClose(): void }) {
  const root = usePopover(popup.anchor, onClose, [popup])
  const parsed = useMemo(() => parseWait(popup.text), [popup.text])
  // a name alone (the inspector): the text is another kind of line, so only the event is shown
  const w = parsed && (popup.event === undefined || parsed.name === popup.event) ? parsed : undefined
  const name = w?.name ?? popup.event
  const ev: Event | undefined = useMemo(() => (name ? doc.events.find((e) => e.name === name) : undefined), [doc, name])
  const info = name ? ctx.eventOf?.(name) ?? ev : undefined
  const total = ev ? doc.stats.events.find((e) => e.event === ev.id) : undefined
  const done = (f: () => void) => () => { f(); onClose() }
  const openEvent = ev ? () => { actions.selectEvent(ev.id); actions.setView('waits') } : undefined
  const stmt = popup.stmt !== undefined && doc.statements[popup.stmt] ? popup.stmt : undefined

  const facts: [string, string, string?][] = []
  if (w) {
    facts.push(['Elapsed', fmtDur(w.ela), `${fmtInt(w.ela)} µs`])
    const names = info ? [info.p1Name, info.p2Name, info.p3Name] : []
    w.params.slice(0, 3).forEach((p, i) => facts.push([names[i] || p.label, p.value, names[i] && names[i] !== p.label ? `p${i + 1}; the trace prints "${p.label}"` : `p${i + 1}`]))
    if (w.obj !== undefined && w.obj > 0) {
      const on = ctx.objectName?.(w.obj)
      facts.push(['Object', on ? `${on} (${w.obj})` : `obj# ${w.obj}`])
    }
    if (w.tim !== undefined) {
      const clock = ctx.clock?.(w.tim)
      const off = ctx.firstTim !== undefined ? `+${fmtDur(w.tim - ctx.firstTim)}` : undefined
      facts.push(['Time', [clock, off].filter(Boolean).join(' · ') || `tim ${w.tim}`, `tim=${w.tim}`])
    }
  }

  return createPortal(
    <div className="stmt-pop stmt-pop-wait" ref={root} role="dialog" aria-label={`Wait ${name ?? ''}`} onKeyDown={(e) => e.stopPropagation()}>
      <div className="stmt-pop-h">
        <b>{name ?? 'wait'}</b>
        {info?.class && <span className="muted">{info.class}</span>}
        {(ev?.idle || total?.idle) && info?.class !== 'Idle' && <span className="stmt-pop-cmd">idle</span>}
        <button type="button" className="quiet stmt-pop-x" onClick={onClose} aria-label="Close" title="close (Esc)">×</button>
      </div>
      {w ? (
        <dl className="stmt-pop-facts lpop-facts">
          {facts.map(([k, v, tip]) => (<div key={k} title={tip}><dt>{k}</dt><dd>{v}</dd></div>))}
        </dl>
      ) : !name && <p className="muted lpop-note">this line could not be read as a wait</p>}
      {total && <p className="lpop-total muted">in this trace: <span className="mono">{fmtInt(total.count)}</span> {total.count === 1 ? 'wait' : 'waits'} · <span className="mono">{fmtDur(total.us)}</span></p>}
      <div className="stmt-pop-acts">
        {openEvent && <button type="button" data-first onClick={done(openEvent)} title="open this wait event in the Waits view">Open event</button>}
        {ev && stmt !== undefined && (
          <button type="button" onClick={done(() => { actions.pickStmt(stmt); actions.selectEvent(ev.id); actions.setView('waits') })} title="the Waits view with this event, for the statement">Waits of this statement</button>
        )}
        {w && <CopyButton first={!openEvent} text={popup.text} label="Copy line" title="copy the text of this line" />}
      </div>
    </div>,
    document.body,
  )
}
