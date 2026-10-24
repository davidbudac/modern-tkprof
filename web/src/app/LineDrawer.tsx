import { useEffect, useRef, useState } from 'react'
import { useStore, actions } from './store'
import { fetchLines, LINES_PAGE, type LinePage } from '../data/lines'
import { fmtInt } from '../data/format'

const HALF = (LINES_PAGE - 1) / 2

/** Bottom pane with the raw trace lines around a line number (±40), target highlighted, paged by Prev/Next. */
export function LineDrawer() {
  const viewer = useStore((s) => s.lineViewer)
  const side = useStore((s) => (s.compare ? s.side : undefined))
  const [page, setPage] = useState<LinePage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const center = viewer?.center ?? 1
  const target = viewer?.target ?? 1

  useEffect(() => {
    const ac = new AbortController()
    setError(null)
    fetchLines(Math.max(1, center - HALF), LINES_PAGE, ac.signal, side).then(setPage, (e) => { if (!ac.signal.aborted) setError(String(e)) })
    return () => ac.abort()
  }, [center, side])

  // bring the target line (or the page start when paging) into view
  useEffect(() => {
    const box = bodyRef.current
    if (!box || !page) return
    const el = box.querySelector<HTMLElement>('[data-target="true"]')
    box.scrollTop = el ? el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2 : 0
  }, [page])

  if (!viewer) return null
  const last = page ? page.from + page.lines.length - 1 : 0
  const atEnd = page ? page.total > 0 && last >= page.total : false
  return (
    <aside className="linedrawer" aria-label="Trace lines">
      <div className="linedrawer-head">
        <h2>Trace lines</h2>
        <span className="hint">{page && page.lines.length ? `${fmtInt(page.from)}–${fmtInt(last)}${page.total ? ` of ${fmtInt(page.total)}` : ''}` : ''}</span>
        <span className="tools">
          <button onClick={() => actions.pageLines(center - LINES_PAGE + 1)} disabled={!page || page.from <= 1} title="the 80 lines before">‹ Prev</button>
          <button onClick={() => actions.pageLines(center + LINES_PAGE - 1)} disabled={!page || atEnd} title="the 80 lines after">Next ›</button>
          {center !== target && <button onClick={() => actions.pageLines(target)}>Back to line {fmtInt(target)}</button>}
          <button onClick={() => actions.closeLines()} aria-label="Close trace lines">Close</button>
        </span>
      </div>
      <div className="linedrawer-body" ref={bodyRef} tabIndex={0}>
        {error && <p className="small muted">Could not read the trace: {error}</p>}
        {page && page.lines.length === 0 && !error && <p className="small muted">Line {fmtInt(target)} is past the end of the file{page.total ? ` (${fmtInt(page.total)} lines)` : ''}.</p>}
        {page && page.lines.length > 0 && (
          <ol className="tracelines" start={page.from}>
            {page.lines.map((text, i) => {
              const n = page.from + i
              return <li key={n} value={n} data-target={n === target ? 'true' : undefined} className={n === target ? 'on' : undefined}><span className="ln">{n}</span><code>{text || ' '}</code></li>
            })}
          </ol>
        )}
      </div>
    </aside>
  )
}
