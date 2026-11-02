// The trace brief (POST /s/{id}/api/brief): the request the Copy brief dialog builds from a tab's store, and the call.
import { bookmarkToAnnotation, type Annotation } from '@lib/data/annotations'
import type { ApiClient } from '@lib/data/client'
import { scopeOf, type State } from '@lib/state/store'
import { responseError } from '../../engine/client'
import type { Schemas } from '../../engine/types'

export type BriefRequest = Schemas['BriefRequest']
export type BriefBinds = Schemas['BriefOptions']['binds']

/** What the dialog's controls choose. */
export interface BriefChoices {
  caseText: string
  notes: boolean
  plans: boolean
  binds: BriefBinds
  /** of the masked bind hashes: one per dialog, so the preview keeps its hashes while the case text is typed */
  salt: string
}

/** The store's part a brief reads: the scope of the views and the notes. */
export type BriefState = Pick<State, 'doc' | 'window' | 'files' | 'contexts' | 'includeIdle' | 'annotations' | 'bookmarks'>

/** The engine rejects fields it does not know, so a note goes out with exactly the fields of the schema, whatever the stored object carries. */
export const noteOf = (a: Annotation): Schemas['Note'] => ({
  id: a.id, kind: a.kind, note: a.note, created: a.created, updated: a.updated,
  stmt: a.stmt && { sqlId: a.stmt.sqlId, hash: a.stmt.hash },
  execNo: a.execNo, cursorLine: a.cursorLine, from: a.from, to: a.to, label: a.label, file: a.file, line: a.line,
})

/** The notes a brief carries: the annotations, and the bookmarks that have a note, as line notes (the way the Notes export writes them). */
export function briefNotes(s: Pick<State, 'annotations' | 'bookmarks'>): Annotation[] {
  return [...s.annotations, ...s.bookmarks.filter((b) => b.note?.trim()).map(bookmarkToAnnotation)]
}

/** The scope the views show now: the window and the contexts of `scopeOf`. */
export function briefScope(s: Omit<BriefState, 'annotations' | 'bookmarks'>): Schemas['BriefScope'] {
  const { window, contexts } = scopeOf(s)
  return {
    from: window ? Math.floor(window.startTim) : 0,
    to: window ? Math.ceil(window.endTim) : 0,
    contexts: contexts ? [...contexts].sort((a, b) => a - b) : [],
  }
}

/** The request for the scope the views show now; zero options select the engine's defaults. */
export function briefRequest(s: BriefState, c: BriefChoices): BriefRequest {
  return {
    case: c.caseText,
    notes: c.notes ? briefNotes(s).map(noteOf) : [],
    options: { maxStatements: 0, maxSqlChars: 0, maxPlanLines: c.plans ? 0 : -1, binds: c.binds, salt: c.salt },
    scope: briefScope(s),
  }
}

export interface Brief { markdown: string; tokens: number }

/** Renders the brief on the engine: the Markdown and the engine's token estimate. */
export async function fetchBrief(client: ApiClient, req: BriefRequest, signal?: AbortSignal): Promise<Brief> {
  const r = await client.fetch('/api/brief', { method: 'POST', body: JSON.stringify(req), headers: { 'content-type': 'application/json' }, signal })
  if (!r.ok) throw await responseError(r, 'brief')
  return { markdown: await r.text(), tokens: Number(r.headers.get('x-mtkprof-est-tokens')) || 0 }
}

/** `812`, `7.4k`, `120k`: a token estimate in a few characters. */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = Math.round(n / 100) / 10
  return k < 100 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`
}

/** A salt for the masked hashes of one dialog (the engine picks a random one per brief when none is given). */
export const newSalt = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
