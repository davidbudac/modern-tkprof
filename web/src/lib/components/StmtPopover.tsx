import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TraceDoc } from '../data/doc'
import { stmtLineIn } from '../data/lines'
import { fmtDur, fmtInt } from '../data/format'
import { copyText } from '../data/clipboard'
import { useActions, useStore } from '../state/session'
import { placePopup } from './popoverPlace'

/** A statement popup asked for by a click on a reference in a row: the statement, the cursor the reference named, where it was clicked and on which line. */
export interface StmtPopup { stmt: number; cursor?: number; anchor: { x: number; y: number; rect?: DOMRect }; line: number }

/**
 * The statement behind a reference in a row: its SQL and a summary, with the way on to the Statements view.
 * A fixed layer on `document.body` under the clicked reference (above it when the viewport ends first); closes on Esc, a click outside,
 * a scroll or a wheel outside it, and a resize. Focus goes to the first action and back to where it was.
 */
export function StmtPopover({ doc, file, popup, onClose, goTo }: { doc: TraceDoc; file: number; popup: StmtPopup; onClose(): void; goTo(line: number): void }) {
  const actions = useActions()
  const marked = useStore((s) => s.selection.stmt)
  const root = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [copied, setCopied] = useState(false)
  const st = doc.statements[popup.stmt]
  const cur = popup.cursor !== undefined ? doc.cursors[popup.cursor] : undefined
  const stats = st ? doc.stats.statements[st.id] : undefined

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const p = placePopup(popup.anchor, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight })
    el.style.setProperty('--x', `${p.left}px`)
    el.style.setProperty('--y', `${p.top}px`)
  }, [popup])

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    root.current?.querySelector<HTMLElement>('button[data-first]')?.focus({ preventScroll: true })
    const inside = (t: EventTarget | null) => t instanceof Node && !!root.current?.contains(t)
    const onDown = (e: PointerEvent) => { if (!inside(e.target)) closeRef.current() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeRef.current() } }
    const onMove = (e: Event) => { if (!inside(e.target)) closeRef.current() }
    const onResize = () => closeRef.current()
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('wheel', onMove, { capture: true, passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('wheel', onMove, true)
      window.removeEventListener('resize', onResize)
      if (before && before.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  const copyTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  if (!st) return null
  const parsedAt = (() => {
    if (cur && cur.line > 0 && doc.fileOfCursor(cur.id) === file) return cur.line
    return stmtLineIn(doc, file, st.id)
  })()
  const total = stats?.total
  const facts: [string, string][] = stats ? [
    ['Executions', fmtInt(stats.executions)],
    ['Elapsed', fmtDur(stats.elapsed)],
    ['CPU', fmtDur(stats.cpu)],
    ['Waits', fmtDur(stats.waitUs)],
    ['Rows', fmtInt(total?.rows ?? 0)],
    ['Disk reads', fmtInt(total?.disk ?? 0)],
    ['Buffer gets', fmtInt((total?.query ?? 0) + (total?.current ?? 0))],
    ['Hard parses', fmtInt(stats.hardParses)],
    ['Cursors', fmtInt(stats.cursors)],
    ...(stats.errors > 0 ? [['Errors', fmtInt(stats.errors)] as [string, string]] : []),
  ] : []
  const done = (f: () => void) => () => { f(); onClose() }
  const label = doc.label(st)

  return createPortal(
    <div className="stmt-pop" ref={root} role="dialog" aria-label={`Statement ${label}`} onKeyDown={(e) => e.stopPropagation()}>
      <div className="stmt-pop-h">
        <b className="mono">{label}</b>
        {cur && <span className="muted">cursor #{cur.number} · dep {cur.depth}</span>}
        {st.commandName && <span className="stmt-pop-cmd">{st.commandName}</span>}
        <button type="button" className="quiet stmt-pop-x" onClick={onClose} aria-label="Close" title="close (Esc)">×</button>
      </div>
      {facts.length > 0 && (
        <dl className="stmt-pop-facts">
          {facts.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
        </dl>
      )}
      <pre className="sql stmt-pop-sql" tabIndex={0}>{st.text || '(no SQL text)'}</pre>
      <div className="stmt-pop-acts">
        <button type="button" data-first onClick={done(() => actions.selectStmt(st.id))} title="open this statement in the Statements view">Open in Statements</button>
        {marked !== st.id && <button type="button" onClick={done(() => actions.pickStmt(st.id))} title="mark this statement: its calls and waits get gutter marks">Mark</button>}
        {parsedAt !== undefined && <button type="button" onClick={done(() => goTo(parsedAt))} title={`go to line ${fmtInt(parsedAt)}, where ${cur ? 'this cursor' : 'the statement'} was parsed`}>Parsed at line {fmtInt(parsedAt)}</button>}
        <button type="button" onClick={() => {
          void copyText(st.text).then((ok) => {
            if (!ok) return
            setCopied(true)
            window.clearTimeout(copyTimer.current)
            copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
          })
        }}>{copied ? 'Copied' : 'Copy SQL'}</button>
      </div>
    </div>,
    document.body,
  )
}
