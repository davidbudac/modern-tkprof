// What the active session tab says about its trace (the tab is the trace's identity; TabStrip.tsx lays it out): a file count, the
// live mark, the file's status, the response time in miniature and a cue inside the tab's button, the live badge beside it, and the
// trace popover under it. All of it inside the tab's SessionProvider, and nothing until the document is in.
import { fmtWall, fmtTz, fmtBytes, fmtDur, fmtPct, useStore, fileHeading, selectionInfo, useScopeResponse, FilesToggle, FileStatus, type ResponseSummary, type TraceDoc } from '@lib'
import type { FileInfo } from '../../engine'

/** The response time in a few pixels: the class split of the scope, no text (the numbers are in the trace popover). */
function ResponseSpark({ summary }: { summary: ResponseSummary }) {
  const { resp, segs, top } = summary
  const totalUs = resp.responseUs
  // decoration inside the tab's button: the button's name stays the trace's title, the split is spelled out in the popover
  return (
    <span className="mini-spark" aria-hidden="true"
      title={`response ${fmtDur(totalUs)}${top.length ? ' · ' + top.map((s) => `${fmtPct(s.us, totalUs, 0)} ${s.label}`).join(' · ') : ''}`}>
      <Segs segs={segs} />
    </span>
  )
}

function Segs({ segs }: { segs: ResponseSummary['segs'] }) {
  return <>{segs.map((s) => <i key={s.role} className={s.role === 'unaccounted' ? 'unaccounted' : undefined} style={{ flex: `${s.us} 1 0`, background: s.role === 'unaccounted' ? undefined : `var(--c-${s.role})` }} />)}</>
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

/** How many files the trace is: the continuation files of one document, or the files of a set opened together. */
const fileCount = (doc: TraceDoc, files?: FileInfo[]) => (doc.multiFile ? (doc.file.files?.length ?? 1) : (files?.length ?? 1))

/** The tab button's tail, after the title: `▤ N` files, the live mark, the file's status, the response sparkline, the `▾` that says the tab opens the trace popover. */
export function TabTraceExtras({ files, live }: { files?: FileInfo[]; live: boolean }) {
  const doc = useStore((s) => s.doc)
  return doc ? <Extras doc={doc} files={files} live={live} /> : null
}

function Extras({ doc, files, live }: { doc: TraceDoc; files?: FileInfo[]; live: boolean }) {
  // a following session shows its badge (with pause / resume) beside the button instead: a button cannot sit inside one
  const following = useStore((s) => s.live) !== null
  // follows the file selection: its response time (Σ session spans) and class split
  const summary = useScopeResponse(doc)
  const nFiles = fileCount(doc, files)
  return (
    <>
      {nFiles > 1 && <span className="dim">▤ {nFiles}</span>}
      {live && !following && <span className="badge-live" title="following the file as it grows">live</span>}
      {!doc.multiFile && <FileStatus file={doc.file} />}
      <ResponseSpark summary={summary} />
      <span className="cue" aria-hidden="true">▾</span>
    </>
  )
}

/** The trace under the active tab: where it came from (database, session, module, time span) and its full response split. */
export function TabTracePop({ files, at }: { files?: FileInfo[]; at: { top: number; left: number } }) {
  const doc = useStore((s) => s.doc)
  return doc ? <TracePop doc={doc} files={files} at={at} /> : null
}

function TracePop({ doc, files, at }: { doc: TraceDoc; files?: FileInfo[]; at: { top: number; left: number } }) {
  // follows the file selection: the first context of the selected files, their wall-clock span, the name and size of the file(s)
  const selected = useStore((s) => s.files)
  const live = useStore((s) => s.live)
  const span = selectionInfo(doc, selected)
  const summary = useScopeResponse(doc)
  const path = doc.file.traceFile || doc.file.path
  const head = fileHeading(doc, selected, { name: path.split(/[\\/]/).pop() ?? path, title: path, bytes: doc.diag.bytes })
  const nFiles = fileCount(doc, files)
  const c0 = span.contexts[0]
  const switches = Math.max(0, span.contexts.length - 1)
  const { resp, segs } = summary
  return (
    <div className="pop trace-pop" role="dialog" aria-label="Trace" style={{ insetBlockStart: at.top, insetInlineStart: at.left }}>
      <h4 className="mono">{head.name} · {fmtBytes(head.bytes)}{nFiles > 1 && <> · {nFiles} files</>}</h4>
      <dl className="kv">
        {doc.file.version && <><dt>Oracle</dt><dd><b>{doc.file.version.replace(/\.0\.0\.0$/, '')}</b>{doc.file.instance && <> · instance <b>{doc.file.instance}</b>{doc.file.node && <> on {doc.file.node.split('.')[0]}</>}</>}</dd></>}
        {c0?.sessionId && <><dt>session</dt><dd><b>{c0.sessionId}</b>{c0.service && <> · service {c0.service}</>}{c0.clientDriver && <> · {c0.clientDriver}</>}</dd></>}
        {c0?.module && <><dt>module</dt><dd><b>{c0.module}</b>{switches > 0 && <> · {switches} context switch{switches === 1 ? '' : 'es'}</>}</dd></>}
        <dt>span</dt>
        <dd>
          {span.firstWallUs
            ? <><b>{fmtWall(span.firstWallUs, doc.tzOffsetMin, { date: true }).slice(0, 10)}</b> {fmtWall(span.firstWallUs, doc.tzOffsetMin)} → {fmtWall(span.lastWallUs, doc.tzOffsetMin)} {fmtTz(doc.tzOffsetMin)}</>
            : <>no wall clock</>}
        </dd>
        {/* the tab's badge is just the state and pause / resume; the snapshot's number and time are here */}
        {live && <><dt>live</dt><dd>snapshot <b>{live.rev}</b> · updated {clock(live.updated)}</dd></>}
      </dl>
      {segs.length > 0 && (
        <>
          <div className="track" role="img" aria-label={segs.map((s) => `${s.label} ${fmtPct(s.us, resp.responseUs, 0)}`).join(', ')}><Segs segs={segs} /></div>
          <div className="legend">
            {segs.map((s) => (
              <span key={s.role} className="k"><i className={'sw' + (s.role === 'unaccounted' ? ' unaccounted' : '')} style={s.role === 'unaccounted' ? undefined : { background: `var(--c-${s.role})` }} />{s.label} {fmtDur(s.us)}</span>
            ))}
          </div>
        </>
      )}
      <div className="foot">
        <FilesToggle doc={doc} />
        <span>response <b>{fmtDur(resp.responseUs)}</b>{resp.sessions > 1 && ` · ${resp.sessions} sessions, wall ${fmtDur(resp.wallUs)}`}</span>
      </div>
    </div>
  )
}
