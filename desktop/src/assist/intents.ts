// What the assistant's `show` tool does in the app. The engine checks a target against the trace and sends it as an `intent`
// event with the `mtkprof:` link of the same place (internal/assist/tools_show.go); the app opens that link the way a
// chip of the answer does, after it has kept the views as they are for Back. Only a Pivot setting is not in the link.
import { unresolved, type Store, type TraceDoc } from '@lib'
import { pivotDims, pivotMeasures, type Fact } from '@lib/data/pivot'
import { navHistoryOf } from '../workspace/session/navHistory'
import type { IntentOutcome, IntentPart } from './conversation'
import { linkOf, openChip, statementOf } from './links'

type Intent = Pick<IntentPart, 'href' | 'target'>
type PivotIntent = NonNullable<IntentPart['target']['pivot']>

/** The urlstate hash an intent opens: the link the engine made of its target, which is what a chip of the answer opens too. */
export function intentHash(intent: Pick<Intent, 'href'>): string | null {
  const link = linkOf(intent.href)
  return link?.kind === 'mtkprof' ? link.hash : null
}

const eventOf = (doc: TraceDoc, name: string | undefined) => {
  const i = name ? doc.events.findIndex((e) => e.name === name) : -1
  return i >= 0 ? i : null
}

/** The Pivot setting of an intent that this trace cannot show; `pivot` also when the dimensions or the measure are not ones the view has. */
function pivotMissing(doc: TraceDoc, p: PivotIntent | undefined): string[] {
  if (!p) return []
  const keys: string[] = []
  const fact: Fact = p.fact === 'waits' ? 'waits' : 'calls'
  if (p.fact !== fact || p.by.length < 1 || p.by.length > 2 || !p.by.every((id) => pivotDims(doc, fact).some((d) => d.id === id))) keys.push('pivot')
  else if (p.sort && !pivotMeasures(fact).some((m) => m.id === p.sort)) keys.push('pivot')
  if (p.sql_id && statementOf(doc, p.sql_id) === null) keys.push('sql')
  if (p.event && eventOf(doc, p.event) === null) keys.push('ev')
  return keys
}

/** The hash to open, or the keys the trace has nothing for (none when the link is not one the app can open). */
function resolve(doc: TraceDoc | null, intent: Intent): { hash: string } | { keys: string[] } {
  const hash = intentHash(intent)
  if (!doc || hash === null) return { keys: [] }
  const keys = [...new Set([...unresolved(doc, hash), ...pivotMissing(doc, intent.target.pivot)])]
  return keys.length ? { keys } : { hash }
}

function showPivot(store: Store, p: PivotIntent) {
  const { doc, pivot } = store.getState()
  if (!doc) return
  const fact: Fact = p.fact === 'waits' ? 'waits' : 'calls'
  store.actions.setPivot({
    fact,
    by: p.by.slice(0, 2),
    sort: p.sort ? { ...pivot.sort, [fact]: p.sort } : pivot.sort,
    stmt: statementOf(doc, p.sql_id),
    event: fact === 'waits' ? eventOf(doc, p.event) : null,
  })
}

/**
 * Moves the tab's views to what the intent names. The views as they stand go into the tab's history first, so Back returns
 * to them; a place this trace does not have leaves the store as it is.
 */
export function applyIntent(store: Store, intent: Intent): IntentOutcome {
  const r = resolve(store.getState().doc, intent)
  if ('keys' in r) return { state: 'unresolved', keys: r.keys }
  const nav = navHistoryOf(store)
  nav.move(() => {
    openChip(store, r.hash)
    if (intent.target.pivot) showPivot(store, intent.target.pivot)
  })
  return { state: 'applied', at: nav.current }
}

/** An intent as it arrives in a turn: moved at once, or, with Ask before moving the view, left as a chip that moves on a click. */
export function receiveIntent(store: Store, intent: Intent, ask: boolean): IntentOutcome {
  if (!ask) return applyIntent(store, intent)
  const r = resolve(store.getState().doc, intent)
  return 'keys' in r ? { state: 'unresolved', keys: r.keys } : { state: 'pending' }
}
