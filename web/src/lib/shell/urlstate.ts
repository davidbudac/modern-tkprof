import { contextsWithin, formatFilesParam, normalizeFiles, parseFilesParam } from '../data/fileset'
import { execKey } from '../data/annotations'
import type { TraceDoc } from '../data/doc'
import type { Store, Side, State, View } from '../state/store'
import { baseViews } from './views'

/**
 * View, selected statement / wait event and time window live in the URL hash:
 *   #view=statements&sql=abc123def4567&ev=db+file+sequential+read&win=1200000-3400000
 * `sql` is the sql_id (`@N` = statement index for statements without one), `ev` the
 * event name, `win` the window as microseconds from the start of the trace, `exec` one execution of the statement
 * (`<cursorLine>:<execNo>`, `execKey`), `contexts` the selected session contexts (`0,2`; absent = all), `files` the
 * shown input files (indexes, `0,2`; absent = all); the Lines view adds `file` (input file index) and `line`.
 * The assistant's `mtkprof:` links are the same hash (engine/internal/assist/system_prompt.md).
 * The `?doc=` query string is left alone.
 */
const views: View[] = baseViews.map((v) => v.id) // the views a link can name: the view table's (views.tsx)

type Wanted = { view: View; side: Side; sql: string; ev: string; win: [number, number] | null; exec: string; contexts: string; files: string; file: number; line: number }

function sqlKey(doc: TraceDoc, id: number | null): string {
  if (id === null) return ''
  const st = doc.statements[id]
  if (!st) return ''
  if (st.sqlId && doc.statements.findIndex((x) => x.sqlId === st.sqlId) === id) return st.sqlId
  return `@${id}`
}

/** The selected execution when it is one of the selected statement's. */
function execOf(doc: TraceDoc, s: State): string {
  const x = s.selection.exec
  const c = x ? doc.cursors[x.cursor] : undefined
  return x && c && c.statement === s.selection.stmt ? execKey(c.line, x.execNo) : ''
}

function wanted(doc: TraceDoc, s: State): Wanted {
  const w = s.window
  return {
    view: s.view,
    side: s.compare ? s.side : 'a',
    sql: sqlKey(doc, s.selection.stmt),
    ev: s.selection.event === null ? '' : doc.events[s.selection.event]?.name ?? '',
    win: w ? [Math.round(w.startTim - doc.span.firstTim), Math.round(w.endTim - doc.span.firstTim)] : null,
    exec: execOf(doc, s),
    contexts: formatFilesParam(s.contexts),
    files: formatFilesParam(s.files),
    file: s.view === 'lines' ? s.linesView.file : 0,
    line: s.view === 'lines' ? s.linesView.line : 0,
  }
}

function format(w: Wanted): string {
  const p = new URLSearchParams()
  if (w.view !== 'overview') p.set('view', w.view)
  if (w.side === 'b') p.set('side', 'b')
  if (w.sql) p.set('sql', w.sql)
  if (w.ev) p.set('ev', w.ev)
  if (w.win) p.set('win', `${w.win[0]}-${w.win[1]}`)
  if (w.exec) p.set('exec', w.exec)
  if (w.contexts) p.set('contexts', w.contexts)
  if (w.files) p.set('files', w.files)
  if (w.view === 'lines') {
    if (w.file) p.set('file', String(w.file))
    if (w.line > 1) p.set('line', String(w.line))
  }
  const t = p.toString()
  return t ? '#' + t : ''
}

/** What parse() found, with `files` and `contexts` as sets and `exec` as its two numbers. */
type Parsed = Omit<Partial<Wanted>, 'files' | 'contexts' | 'exec'> & { files?: Set<number> | null; contexts?: Set<number> | null; exec?: { cursorLine: number; execNo: number } }

function parse(hash: string): Parsed {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const out: Parsed = {}
  const v = p.get('view')
  if (v && (views as string[]).includes(v)) out.view = v as View
  if (p.get('side') === 'b') out.side = 'b'
  if (p.has('sql')) out.sql = p.get('sql')!
  if (p.has('ev')) out.ev = p.get('ev')!
  const m = /^(-?\d+)-(\d+)$/.exec(p.get('win') ?? '')
  if (m) out.win = [Number(m[1]), Number(m[2])]
  const x = /^(\d+):(\d+)$/.exec(p.get('exec') ?? '')
  if (x) out.exec = { cursorLine: Number(x[1]), execNo: Number(x[2]) }
  if (p.has('contexts')) out.contexts = parseFilesParam(p.get('contexts'))
  if (p.has('files')) out.files = parseFilesParam(p.get('files'))
  if (/^\d+$/.test(p.get('file') ?? '')) out.file = Number(p.get('file'))
  if (/^\d+$/.test(p.get('line') ?? '')) out.line = Number(p.get('line'))
  return out
}

/** The hash that stands for the store's state. */
export function hashOf(doc: TraceDoc, s: State): string { return format(wanted(doc, s)) }

function stmtIn(doc: TraceDoc, sql: string | undefined): number | null {
  if (!sql) return null
  const stmt = sql.startsWith('@') ? (/^@\d+$/.test(sql) ? Number(sql.slice(1)) : -1) : doc.statements.findIndex((x) => x.sqlId === sql)
  return stmt >= 0 && stmt < doc.statements.length ? stmt : null
}

/** The cursor of statement `stmt` opened at `cursorLine`, with execution `execNo` of it; else null. */
function execIn(doc: TraceDoc, stmt: number | null, x: Parsed['exec']): State['selection']['exec'] {
  if (stmt === null || !x || x.execNo < 1) return null
  const cursor = doc.statements[stmt].cursors.find((c) => doc.cursors[c]?.line === x.cursorLine)
  return cursor !== undefined && x.execNo <= doc.cursors[cursor].execs ? { cursor, execNo: x.execNo } : null
}

const within = (set: Set<number> | null | undefined, n: number) => !!set && set.size > 0 && [...set].every((i) => i < n)

/**
 * The keys of `hash` that name something `doc` does not have (an unknown view, sql_id, event, execution, window,
 * context or file): `apply` would drop them. [] when everything resolves.
 */
export function unresolved(doc: TraceDoc, hash: string): string[] {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const w = parse(hash)
  const stmt = stmtIn(doc, w.sql)
  const nFiles = doc.file.files?.length ?? 1
  const fileLines = doc.file.files?.[w.file ?? 0]?.lines ?? 0
  const bad: Record<string, boolean> = {
    view: !w.view || w.view === 'compare',
    sql: stmt === null,
    ev: !w.ev || !doc.events.some((e) => e.name === w.ev),
    win: !w.win || w.win[0] < 0 || w.win[1] <= w.win[0],
    exec: execIn(doc, stmt, w.exec) === null,
    contexts: !within(w.contexts, doc.contexts.length),
    files: !within(w.files, nFiles),
    file: w.file === undefined || w.file >= nFiles,
    line: !w.line || (fileLines > 0 && w.line > fileLines),
  }
  return Object.keys(bad).filter((k) => p.has(k) && bad[k])
}

/** Applies a hash to the store (unknown sql_ids / events / executions / contexts are ignored). */
export function apply(store: Store, doc: TraceDoc, hash: string): TraceDoc {
  const w = parse(hash)
  const cmp = store.getState().compare
  const side: Side = cmp && w.side === 'b' ? 'b' : 'a'
  if (cmp) doc = cmp[side]
  const stmt = stmtIn(doc, w.sql)
  const ev = w.ev ? doc.events.findIndex((e) => e.name === w.ev) : -1
  const base = doc.span.firstTim
  const st = store.getState()
  const view = (w.view === 'compare' && !cmp) || (w.view === 'lines' && !(st.linesApi && doc.slice)) ? undefined : w.view
  const files = doc.file.files?.length ?? 1
  const known = w.files ? new Set([...w.files].filter((f) => f < files)) : null // indexes this trace does not have are ignored; none left = all files
  const shown = normalizeFiles(doc, known && known.size > 0 ? known : null)
  const file = w.file !== undefined && w.file < files ? w.file : shown ? Math.min(...shown) : 0 // the Lines view starts on the first shown file
  const ctxs = w.contexts ? new Set([...w.contexts].filter((c) => c < doc.contexts.length)) : null // unknown contexts are ignored; none left = all
  store.setState({
    doc, side: cmp ? side : 'a',
    view: view ?? (stmt !== null ? 'statements' : 'overview'),
    selection: { stmt, event: ev >= 0 ? ev : null, call: null, exec: execIn(doc, stmt, w.exec) },
    files: shown, contexts: contextsWithin(doc, ctxs && ctxs.size > 0 ? ctxs : null, shown),
    window: w.win && w.win[1] > w.win[0] ? { startTim: base + w.win[0], endTim: base + w.win[1] } : null,
    ioZoom: [], // the I/O map's zoom is not in the hash; it was inside the window it replaces
    ...(view === 'lines' ? { linesView: { file, line: Math.max(1, w.line ?? 1), seq: st.linesView.seq + 1 } } : {}),
  })
  return doc
}

/**
 * Keeps location.hash and the store in step once a document is loaded:
 * the initial hash is restored, later store changes push history entries
 * (a changed window or a first auto-picked statement only replaces the current one,
 * so brushing does not flood Back), and Back/Forward re-apply the hash.
 */
export function startUrlSync(store: Store): void {
  const { getState, subscribe } = store
  let doc: TraceDoc | null = null
  let last = '' // the hash the store currently corresponds to
  let prev: State | null = null
  let applying = false // store updates caused by a hash must not write one back
  const restore = (d: TraceDoc) => { applying = true; try { doc = apply(store, d, location.hash) } finally { applying = false } }
  const write = (replace: boolean) => {
    if (!doc) return
    const hash = format(wanted(doc, getState()))
    if (hash === last) return
    last = hash
    const url = location.pathname + location.search + hash
    if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url)
  }
  subscribe(() => {
    if (applying) return
    const s = getState()
    if (s.doc !== doc && doc && s.doc && s.compare && (s.doc === s.compare.a || s.doc === s.compare.b) && (doc === s.compare.a || doc === s.compare.b)) {
      // the A/B toggle (or "open on side X"): the store already holds the new selection, record it
      doc = s.doc
      prev = s
      write(false)
      return
    }
    if (s.doc !== doc) {
      doc = s.doc
      prev = null
      if (!doc) return
      restore(doc)
      last = format(wanted(doc, getState()))
      if (last !== location.hash) history.replaceState(null, '', location.pathname + location.search + last)
      prev = getState()
      return
    }
    if (!doc || !prev) return
    const a = wanted(doc, prev), b = wanted(doc, s)
    const onlyWindow = a.view === b.view && a.sql === b.sql && a.ev === b.ev
    const firstPick = a.view === b.view && a.sql === '' && b.sql !== '' && a.ev === b.ev
    const lineStep = a.view === 'lines' && b.view === 'lines' && a.file === b.file // clicking through lines must not flood Back
    prev = s
    write(onlyWindow || firstPick || lineStep)
  })
  const onNav = () => {
    if (!doc || location.hash === last || (location.hash === '' && last === '')) return
    restore(doc)
    last = format(wanted(doc, getState()))
    prev = getState()
    if (last !== location.hash) history.replaceState(null, '', location.pathname + location.search + last)
  }
  window.addEventListener('hashchange', onNav)
  window.addEventListener('popstate', onNav)
}
