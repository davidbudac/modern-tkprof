import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import { PageCache } from '../data/linecache'
import { fetchLinesAnnot } from '../data/lines'
import { bindAtOf } from '../data/bindat'
import { fmtInt, preview } from '../data/format'
import { copyText } from '../data/clipboard'
import { decodeContextOf, lineCardOf, refClickOf, refTitleOf, useLineAt } from '../views/linesShared'
import { LinesAt, type LineAct } from '../views/LinesAt'
import { useActions, useClient, useStore } from '../state/session'
import { useLinesPrefs } from '../state/linesPrefs'
import { LineViewer, type ViewerApi } from './LineViewer'
import { LinePopover, type LinePopup } from './LinePopover'
import '../styles/lines.css'

/** pages of annotated lines kept for the drawer */
const CACHE_PAGES = 8
const NO_MARKS: ReadonlyMap<number, number> = new Map()

/** The first visible line and the lines that fit, as the viewer reports them: its own state, so a scroll re-renders the hint and the Back button, not the drawer. */
interface ViewHub { last: { top: number; rows: number }; subs: Set<(v: { top: number; rows: number }) => void> }
function useView(hub: ViewHub) {
  const [view, setView] = useState(hub.last)
  useEffect(() => {
    const sub = (v: { top: number; rows: number }) => setView((o) => (o.top === v.top && o.rows === v.rows ? o : v))
    hub.subs.add(sub)
    sub(hub.last)
    return () => { hub.subs.delete(sub) }
  }, [hub])
  return view
}

function ViewHint({ hub, total }: { hub: ViewHub; total: number }) {
  const { top, rows } = useView(hub)
  if (rows <= 0 || total <= 0) return <span className="hint" />
  return <span className="hint">{fmtInt(top)}–{fmtInt(Math.min(total, top + Math.floor(rows) - 1))} of {fmtInt(total)}</span>
}

/** Back to the line the drawer was opened at: there while that line is out of view (the drawer scrolls the whole file). */
function BackButton({ hub, target, total, onBack }: { hub: ViewHub; target: number; total: number; onBack: () => void }) {
  const { top, rows } = useView(hub)
  if (rows <= 0 || total <= 0 || target > total) return null
  if (target >= top && target <= top + Math.floor(rows) - 1) return null
  return <button onClick={onBack} title="scroll back to the line the drawer was opened at">Back to line {fmtInt(target)}</button>
}

/**
 * The bottom drawer with the trace lines around a line number: the whole input file in a `LineViewer` (colour by kind, heat, references, hover cards),
 * revealed at the target, the breadcrumb of the selected line below the head. Both shells mount this; needs the engine (`annot=2` pages).
 */
export function LineDrawer() {
  const viewer = useStore((s) => s.lineViewer)
  const doc = useStore((s) => s.doc)
  if (!viewer || !doc) return null
  return <DrawerOf key={viewer.file} doc={doc} file={viewer.file} target={viewer.target} center={viewer.center} />
}

function DrawerOf({ doc, file, target, center }: { doc: TraceDoc; file: number; target: number; center: number }) {
  const actions = useActions()
  const client = useClient()
  const tab = useStore((s) => s.linesApi && !!s.doc?.slice)
  const allBookmarks = useStore((s) => s.bookmarks)
  const rev = useStore((s) => s.rev)
  const side = useStore((s) => (s.compare ? s.side : undefined)) // `mtkprof serve a b -compare` serves the lines of either side
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const [prefs] = useLinesPrefs() // wrap, heat and references follow the Lines view's toggles
  const [selected, setSelected] = useState(target)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [popup, setPopup] = useState<LinePopup | null>(null)
  const apiRef = useRef<ViewerApi | null>(null)
  const topRef = useRef(0)
  const hub = useRef<ViewHub>({ last: { top: 1, rows: 0 }, subs: new Set() }).current
  const onViewChange = useCallback((top: number, rows: number) => { hub.last = { top, rows }; hub.subs.forEach((f) => f(hub.last)) }, [hub])

  const cache = useMemo(() => new PageCache((from, n, signal) => fetchLinesAnnot(client, file, from, n, signal, true, side), CACHE_PAGES), [client, file, side])
  useEffect(() => cache.subscribe(bump), [cache])
  useEffect(() => () => cache.close(), [cache])
  const shownRev = useRef(rev)
  useEffect(() => {
    if (rev === shownRev.current) return
    shownRev.current = rev
    void cache.refresh()
  }, [cache, rev])

  // a new target selects its line; every move of the centre (a new target) shows it in the middle
  useEffect(() => { setSelected(target) }, [target])
  useEffect(() => { apiRef.current?.reveal(center, 'center') }, [center, target])

  const flash = useCallback((msg: string) => setNote(msg), [])
  const back = useCallback(() => { apiRef.current?.reveal(target, 'center'); setSelected(target) }, [target])
  useEffect(() => {
    if (note === null) return
    const t = window.setTimeout(() => setNote(null), 2500)
    return () => window.clearTimeout(t)
  }, [note])
  const goTo = useCallback((line: number) => { apiRef.current?.reveal(line, 'center'); setSelected(line) }, [])

  const bindAt = useMemo(() => bindAtOf(doc, file, cache), [doc, file, cache])
  const decodeCtx = useMemo(() => decodeContextOf(doc, bindAt), [doc, bindAt])
  const lineCard = useMemo(() => lineCardOf(decodeCtx), [decodeCtx])
  const onRef = useMemo(() => refClickOf(doc, file, decodeCtx, actions, goTo, flash, setPopup), [doc, file, decodeCtx, actions, goTo, flash])
  const refTitle = useMemo(() => refTitleOf(doc, decodeCtx), [doc, decodeCtx])

  const bmSet = useMemo(() => new Set(allBookmarks.filter((b) => b.file === file).map((b) => b.line)), [allBookmarks, file])
  const toggleBookmark = useCallback((line: number) => {
    if (bmSet.has(line)) actions.removeBookmark(file, line)
    else actions.addBookmark(file, line, preview(cache.line(line)?.text ?? '', 80).trim())
  }, [actions, file, cache, bmSet])

  const at = useLineAt(client, doc, file, cache, selected)
  const lineActs: LineAct[] = [
    { label: 'Bookmark', kbd: 'b', on: bmSet.has(selected), keepOpen: true, run: () => toggleBookmark(selected), title: 'bookmark this line (b; a right-click on a line number does it too)' },
    { label: 'Copy line', title: "copy the line's text", run: () => { const t = cache.line(selected)?.text; if (t !== undefined) void copyText(t).then((ok) => flash(ok ? `Copied line ${fmtInt(selected)}` : 'Could not copy the line')) } },
  ]
  const total = cache.total
  const fileName = doc.traceFileName(file)
  return (
    <aside className="linedrawer" aria-label="Trace lines">
      <div className="linedrawer-head">
        <h2>Trace lines{fileName && <small className="mono"> · {fileName}</small>}</h2>
        <ViewHint hub={hub} total={total} />
        {note && <span className="hint" role="status" aria-live="polite">{note}</span>}
        <span className="tools">
          <BackButton hub={hub} target={target} total={total} onBack={back} />
          {tab && <button onClick={() => actions.openLinesAt(file, selected)} title="open the whole trace in the Lines tab">In Lines tab</button>}
          <button onClick={() => actions.closeLines()} aria-label="Close trace lines">Close</button>
        </span>
      </div>
      <LinesAt doc={doc} file={file} at={at} text={at ? cache.line(at.line)?.text ?? '' : ''} goTo={goTo} note={flash} lineActs={lineActs} />
      <div className="linedrawer-body">
        <LineViewer cache={cache} marks={NO_MARKS} bookmarks={bmSet} selected={selected} wrap={prefs.wrap} heat={prefs.heat} links={prefs.links} onRef={onRef} refTitle={refTitle} card={lineCard}
          onViewChange={onViewChange} apiRef={apiRef} topRef={topRef} onSelect={setSelected} onBookmark={toggleBookmark} onError={setLoadError} />
        {total === 0 && !loadError && <p className="lines-overlay muted">Loading trace lines…</p>}
        {loadError && <p className="lines-overlay lines-error" role="alert">Could not read the trace: {loadError}</p>}
        {total > 0 && target > total && <p className="lines-overlay muted">Line {fmtInt(target)} is past the end of the file ({fmtInt(total)} lines)</p>}
      </div>
      {popup && <LinePopover doc={doc} file={file} popup={popup} ctx={decodeCtx} actions={actions} onClose={() => setPopup(null)} goTo={goTo} />}
    </aside>
  )
}
