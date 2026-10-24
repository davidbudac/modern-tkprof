import type { TraceDoc } from '../data/doc'
import { getState, setState, subscribeStore, type State, type View } from './store'

/**
 * View, selected statement / wait event and time window live in the URL hash:
 *   #view=statements&sql=abc123def4567&ev=db+file+sequential+read&win=1200000-3400000
 * `sql` is the sql_id (`@N` = statement index for statements without one), `ev` the
 * event name, `win` the window as microseconds from the start of the trace.
 * The `?doc=` query string is left alone.
 */
const views: View[] = ['overview', 'statements', 'waits', 'timeline', 'sessions', 'pivot']

type Wanted = { view: View; sql: string; ev: string; win: [number, number] | null }

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
    sql: sqlKey(doc, s.selection.stmt),
    ev: s.selection.event === null ? '' : doc.events[s.selection.event]?.name ?? '',
    win: w ? [Math.round(w.startTim - doc.span.firstTim), Math.round(w.endTim - doc.span.firstTim)] : null,
  }
}

function format(w: Wanted): string {
  const p = new URLSearchParams()
  if (w.view !== 'overview') p.set('view', w.view)
  if (w.sql) p.set('sql', w.sql)
  if (w.ev) p.set('ev', w.ev)
  if (w.win) p.set('win', `${w.win[0]}-${w.win[1]}`)
  const t = p.toString()
  return t ? '#' + t : ''
}

function parse(hash: string): Partial<Wanted> {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const out: Partial<Wanted> = {}
  const v = p.get('view')
  if (v && (views as string[]).includes(v)) out.view = v as View
  if (p.has('sql')) out.sql = p.get('sql')!
  if (p.has('ev')) out.ev = p.get('ev')!
  const m = /^(-?\d+)-(\d+)$/.exec(p.get('win') ?? '')
  if (m) out.win = [Number(m[1]), Number(m[2])]
  return out
}

/** Applies a hash to the store (unknown sql_ids / events are ignored). */
function apply(doc: TraceDoc, hash: string): void {
  const w = parse(hash)
  let stmt: number | null = null
  if (w.sql) {
    stmt = w.sql.startsWith('@') ? Number(w.sql.slice(1)) : doc.statements.findIndex((x) => x.sqlId === w.sql)
    if (!(stmt >= 0 && stmt < doc.statements.length)) stmt = null
  }
  const ev = w.ev ? doc.events.findIndex((e) => e.name === w.ev) : -1
  const base = doc.span.firstTim
  setState({
    view: w.view ?? (stmt !== null ? 'statements' : 'overview'),
    selection: { stmt, event: ev >= 0 ? ev : null, call: null, exec: null },
    window: w.win && w.win[1] > w.win[0] ? { startTim: base + w.win[0], endTim: base + w.win[1] } : null,
  })
}

/**
 * Keeps location.hash and the store in step once a document is loaded:
 * the initial hash is restored, later store changes push history entries
 * (a changed window or a first auto-picked statement only replaces the current one,
 * so brushing does not flood Back), and Back/Forward re-apply the hash.
 */
export function startUrlSync(): void {
  let doc: TraceDoc | null = null
  let last = '' // the hash the store currently corresponds to
  let prev: State | null = null
  let applying = false // store updates caused by a hash must not write one back
  const restore = (d: TraceDoc) => { applying = true; try { apply(d, location.hash) } finally { applying = false } }
  const write = (replace: boolean) => {
    if (!doc) return
    const hash = format(wanted(doc, getState()))
    if (hash === last) return
    last = hash
    const url = location.pathname + location.search + hash
    if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url)
  }
  subscribeStore(() => {
    if (applying) return
    const s = getState()
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
    prev = s
    write(onlyWindow || firstPick)
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
