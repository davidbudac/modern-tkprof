import { contextsWithin, formatFilesParam, normalizeFiles, parseFilesParam } from '@lib/data/fileset'
import type { Store, TraceDoc, Side, State, View } from '@lib'

/**
 * View, selected statement / wait event and time window live in the URL hash:
 *   #view=statements&sql=abc123def4567&ev=db+file+sequential+read&win=1200000-3400000
 * `sql` is the sql_id (`@N` = statement index for statements without one), `ev` the
 * event name, `win` the window as microseconds from the start of the trace, `files` the shown input files (indexes, `0,2`; absent = all); the Lines view adds `file` (input file index) and `line`.
 * The `?doc=` query string is left alone.
 */
const views: View[] = ['overview', 'statements', 'waits', 'timeline', 'sessions', 'pivot', 'lines', 'compare']

type Wanted = { view: View; side: Side; sql: string; ev: string; win: [number, number] | null; files: string; file: number; line: number }

function sqlKey(doc: TraceDoc, id: number | null): string {
  if (id === null) return ''
  const st = doc.statements[id]
  if (!st) return ''
  if (st.sqlId && doc.statements.findIndex((x) => x.sqlId === st.sqlId) === id) return st.sqlId
  return `@${id}`
}

function wanted(doc: TraceDoc, s: State): Wanted {
  const w = s.window
  return {
    view: s.view,
    side: s.compare ? s.side : 'a',
    sql: sqlKey(doc, s.selection.stmt),
    ev: s.selection.event === null ? '' : doc.events[s.selection.event]?.name ?? '',
    win: w ? [Math.round(w.startTim - doc.span.firstTim), Math.round(w.endTim - doc.span.firstTim)] : null,
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
  if (w.files) p.set('files', w.files)
  if (w.view === 'lines') {
    if (w.file) p.set('file', String(w.file))
    if (w.line > 1) p.set('line', String(w.line))
  }
  const t = p.toString()
  return t ? '#' + t : ''
}

/** What parse() found, with `files` as a set. */
type Parsed = Omit<Partial<Wanted>, 'files'> & { files?: Set<number> | null }

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
  if (p.has('files')) out.files = parseFilesParam(p.get('files'))
  if (/^\d+$/.test(p.get('file') ?? '')) out.file = Number(p.get('file'))
  if (/^\d+$/.test(p.get('line') ?? '')) out.line = Number(p.get('line'))
  return out
}

/** The hash that stands for the store's state. */
export function hashOf(doc: TraceDoc, s: State): string { return format(wanted(doc, s)) }

/** Applies a hash to the store (unknown sql_ids / events are ignored). */
export function apply(store: Store, doc: TraceDoc, hash: string): TraceDoc {
  const w = parse(hash)
  const cmp = store.getState().compare
  const side: Side = cmp && w.side === 'b' ? 'b' : 'a'
  if (cmp) doc = cmp[side]
  let stmt: number | null = null
  if (w.sql) {
    stmt = w.sql.startsWith('@') ? Number(w.sql.slice(1)) : doc.statements.findIndex((x) => x.sqlId === w.sql)
    if (!(stmt >= 0 && stmt < doc.statements.length)) stmt = null
  }
  const ev = w.ev ? doc.events.findIndex((e) => e.name === w.ev) : -1
  const base = doc.span.firstTim
  const st = store.getState()
  const view = (w.view === 'compare' && !cmp) || (w.view === 'lines' && !(st.linesApi && doc.slice)) ? undefined : w.view
  const files = doc.file.files?.length ?? 1
  const known = w.files ? new Set([...w.files].filter((f) => f < files)) : null // indexes this trace does not have are ignored; none left = all files
  const shown = normalizeFiles(doc, known && known.size > 0 ? known : null)
  const file = w.file !== undefined && w.file < files ? w.file : shown ? Math.min(...shown) : 0 // the Lines view starts on the first shown file
  store.setState({
    doc, side: cmp ? side : 'a',
    view: view ?? (stmt !== null ? 'statements' : 'overview'),
    selection: { stmt, event: ev >= 0 ? ev : null, call: null, exec: null },
    files: shown, contexts: contextsWithin(doc, st.contexts, shown),
    window: w.win && w.win[1] > w.win[0] ? { startTim: base + w.win[0], endTim: base + w.win[1] } : null,
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
