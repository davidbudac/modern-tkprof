import { fmtWall, fmtTz, fmtBytes, fmtInt, optFacts, useStore, useActions, scopeOf, ctxKey, FilesToggle, LiveBadge, sourceOf, useSourceQuery, useScopedStatements, fileHeading, selectionInfo, ResponseMini, useScopeResponse, ViewTabs, baseViews, type TraceDoc, type View } from '@lib'

const themeNext = { auto: 'light', light: 'dark', dark: 'auto' } as const
const themeGlyph = { auto: '◐', light: '○', dark: '●' } as const

/** File, the whole-trace profile in miniature, the views, filters and theme. A 10053 file has none of the 10046 counts: `OptTopBar`. */
export function TopBar(p: { doc: TraceDoc; onShowInfo?: () => void }) {
  return p.doc.opt ? <OptTopBar {...p} /> : <TraceTopBar {...p} />
}

/** The top bar of a 10053 file: its name and size, the 10053 view's tab and the theme; no statement, wait or session counts (the file has none). */
function OptTopBar({ doc, onShowInfo }: { doc: TraceDoc; onShowInfo?: () => void }) {
  const actions = useActions()
  const theme = useStore((s) => s.theme)
  const path = doc.file.traceFile || doc.file.path
  const name = doc.opt?.file.name || path.split(/[\\/]/).pop() || path
  return (
    <header className="topbar">
      <span className="brand">mtkprof</span>
      <span className="file mono" title={path}>{name}<span className="dim"> · {fmtBytes(doc.diag.bytes)}</span></span>
      <ViewTabs views={baseViews} />
      {onShowInfo && <button className="quiet theme" onClick={onShowInfo} title="show the trace info bar" aria-label="Show trace info bar">ⓘ</button>}
      <button className="quiet theme" onClick={() => actions.setTheme(themeNext[theme])} title={`theme: ${theme}`} aria-label={`Theme ${theme}`}>{themeGlyph[theme]}</button>
    </header>
  )
}

function TraceTopBar({ doc, onShowInfo }: { doc: TraceDoc; onShowInfo?: () => void }) {
  const actions = useActions()
  const state = useStore((s) => s)
  const compare = state.compare
  const path = doc.file.traceFile || doc.file.path
  const head = fileHeading(doc, state.files, { name: path.split(/[\\/]/).pop() ?? path, title: path, bytes: doc.diag.bytes })
  const source = sourceOf(doc)
  const summary = useScopeResponse(doc) // Σ session spans of the selected files: the Overview's base without the window
  // the tab counts follow the scope: statements with calls in it, events with waits in it (the window counts when set), its sessions
  const ss = useScopedStatements(doc)
  const full = scopeOf(state)
  const waitsQ = useSourceQuery(source, `topw:${full.window ? `${full.window.startTim}:${full.window.endTim}` : ''}|${ctxKey(full.contexts)}|${full.includeIdle ? 1 : 0}`,
    (signal) => (full.window ? source.profile(full, signal) : null), 'topw')
  const waitsProfile = full.window ? waitsQ.data : summary.profile
  const narrowsWaits = !!(full.window || full.contexts)
  const nStmts = ss.narrowed ? ss.inScope : doc.statements.length
  const nEvents = narrowsWaits && waitsProfile ? waitsProfile.events.filter((e) => e.count > 0).length : doc.events.length
  const nSessions = full.contexts ? full.contexts.size : doc.contexts.length
  const counts: Partial<Record<View, string>> = {
    statements: ss.narrowed ? `${nStmts} of ${ss.total}` : `${nStmts}`,
    waits: narrowsWaits && waitsProfile ? `${nEvents} of ${doc.events.length}` : `${doc.events.length}`,
    sessions: full.contexts ? `${nSessions} of ${doc.contexts.length}` : `${doc.contexts.length}`,
  }
  return (
    <header className={'topbar' + (compare ? ' cmp' : '')}>
      <span className="brand">mtkprof</span>
      {compare && (
        <span className="seg side" role="group" aria-label="Trace shown by the views" title="trace shown in the views">
          {(['a', 'b'] as const).map((k) => (
            <button key={k} aria-pressed={state.side === k} onClick={() => actions.setSide(k)} title={(compare[k].file.traceFile || compare[k].file.path).split(/[\\/]/).pop()}>{k.toUpperCase()}</button>
          ))}
        </span>
      )}
      <span className="file mono" title={head.title}>{head.name}<span className="dim"> · {fmtBytes(head.bytes)}</span></span>
      <LiveBadge />
      <ResponseMini summary={summary} />
      <ViewTabs views={baseViews} counts={counts} />
      <span className="chips">
        <FilesToggle doc={doc} />
      </span>
      {onShowInfo && <button className={'quiet theme' + (doc.file.truncated || doc.file.continuedFrom?.length ? ' warn' : '')} onClick={onShowInfo} title="show the trace info bar" aria-label="Show trace info bar">ⓘ</button>}
      <button className="quiet theme" onClick={() => actions.setTheme(themeNext[state.theme])} title={`theme: ${state.theme}`} aria-label={`Theme ${state.theme}`}>{themeGlyph[state.theme]}</button>
    </header>
  )
}

/** Where the trace came from: database, session, module, time span. */
export function SubBar({ doc, onClose }: { doc: TraceDoc; onClose: () => void }) {
  return doc.opt ? <OptSubBar doc={doc} onClose={onClose} /> : <TraceSubBar doc={doc} onClose={onClose} />
}

/** The facts of a 10053 file that mean something: the release and version, the session and pluggable database of its markers, the dumps. */
function OptSubBar({ doc, onClose }: { doc: TraceDoc; onClose: () => void }) {
  const f = optFacts(doc)
  const n = doc.opt?.file.dumps.length ?? 0
  return (
    <div className="subbar">
      {(f.release || f.version) && <span>Oracle <b>{f.version.replace(/\.0\.0\.0$/, '') || f.release}</b>{doc.file.instance && <> · instance <b>{doc.file.instance}</b>{doc.file.node && <> on {doc.file.node.split('.')[0]}</>}</>}</span>}
      {f.pdb && <span>pluggable database <b>{f.pdb}</b></span>}
      {f.session && <span>session <b>{f.session}</b></span>}
      <span><b>{n}</b> optimizer {n === 1 ? 'dump' : 'dumps'} · {fmtInt(doc.opt?.file.lines ?? 0)} lines</span>
      {doc.file.truncated && <span className="warn">cut by max_dump_file_size</span>}
      <button className="quiet close" onClick={onClose} title="hide this bar (ⓘ in the top bar shows it again)" aria-label="Hide trace info bar">×</button>
    </div>
  )
}

function TraceSubBar({ doc, onClose }: { doc: TraceDoc; onClose: () => void }) {
  // follows the file selection: the first context of the selected files, their wall-clock span
  const span = selectionInfo(doc, useStore((s) => s.files))
  const c0 = span.contexts[0]
  const switches = Math.max(0, span.contexts.length - 1)
  return (
    <div className="subbar">
      {doc.file.version && <span>Oracle <b>{doc.file.version.replace(/\.0\.0\.0$/, '')}</b>{doc.file.instance && <> · instance <b>{doc.file.instance}</b>{doc.file.node && <> on {doc.file.node.split('.')[0]}</>}</>}</span>}
      {c0?.sessionId && <span>session <b>{c0.sessionId}</b>{c0.service && <> · service {c0.service}</>}{c0.clientDriver && <> · {c0.clientDriver}</>}</span>}
      {c0?.module && <span>module <b>{c0.module}</b>{switches > 0 && <> · {switches} context switch{switches === 1 ? '' : 'es'}</>}</span>}
      <span>
        {span.firstWallUs
          ? <><b>{fmtWall(span.firstWallUs, doc.tzOffsetMin, { date: true }).slice(0, 10)}</b> {fmtWall(span.firstWallUs, doc.tzOffsetMin)} → {fmtWall(span.lastWallUs, doc.tzOffsetMin)} {fmtTz(doc.tzOffsetMin)}</>
          : <>no wall clock</>}
      </span>
      {doc.file.truncated && <span className="warn">cut by max_dump_file_size</span>}
      {doc.file.continuedFrom?.length ? <span className="warn">continues an earlier file</span> : null}
      <button className="quiet close" onClick={onClose} title="hide this bar (ⓘ in the top bar shows it again)" aria-label="Hide trace info bar">×</button>
    </div>
  )
}
