import { useEffect, useRef, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import { fmtDur, fmtWall } from '../data/format'
import { useAxis } from '../data/scopedstmts'
import { windowFiles, windowStartLine } from '../data/windowlines'
import { activeBlock } from '../state/store'
import { useActions, useClient, useStore } from '../state/session'
import { StmtLink } from './StmtLink'
import '../styles/timeline.css'

const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/**
 * The time window as one row above the Overview timeline and the Timeline tab: its span and length, the lane block it came from,
 * and where to go with it: the Lines tab at the window's first line, the block's statement, clear.
 */
export function WindowBar({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  const client = useClient()
  const win = useStore((s) => s.window)
  const block = useStore(activeBlock)
  const files = useStore((s) => s.files)
  const canLines = useStore((s) => s.linesApi && !!s.doc?.slice) // as LineRef: the Lines tab needs the lines API
  const { base } = useAxis(doc)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ctl = useRef<AbortController | null>(null)
  // a new window (or leaving) drops the pending lookup and its error
  useEffect(() => { setError(null); return () => ctl.current?.abort() }, [win?.startTim, win?.endTim])
  if (!win) return null

  const at = (tim: number) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(tim), doc.tzOffsetMin) : `+${fmtDur(tim - base)}`)
  const openLines = async () => {
    const file = windowFiles(doc, win, files, block?.stmt)[0]
    if (file === undefined) { setError('no selected file covers the window'); return }
    ctl.current?.abort()
    const ac = (ctl.current = new AbortController())
    setBusy(true); setError(null)
    try {
      const line = await windowStartLine(client, file, win, ac.signal)
      if (!ac.signal.aborted) actions.openLinesAt(file, line, block ? { keepSelection: true } : undefined) // the block's statement stays selected (its marks)
    } catch (e) {
      if (!aborted(e)) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (ctl.current === ac) setBusy(false)
    }
  }

  return (
    <div className="winbar" role="group" aria-label="Time window">
      <span className="winbar-range"><b>Window</b> {at(win.startTim)} → {at(win.endTim)} · {fmtDur(win.endTim - win.startTim)}</span>
      {block && <span className="muted">· block of <StmtLink doc={doc} id={block.stmt} /></span>}
      {error && <small className="winbar-err" role="alert">{error}</small>}
      <span className="winbar-acts">
        {canLines && <button className="go" onClick={() => void openLines()} disabled={busy} aria-busy={busy} aria-label="Open the lines of the time window in the Lines tab" title="the Lines tab at the first line of the window">{busy ? 'Lines…' : 'Lines'}</button>}
        {block && <button onClick={() => actions.selectStmt(block.stmt)} aria-label="Open the statement of the block" title="the statement of the block, filtered to the window">Statement</button>}
        <button className="quiet" onClick={() => actions.setWindow(null)} aria-label="Clear time window" title="clear (Esc)">×</button>
      </span>
    </div>
  )
}
