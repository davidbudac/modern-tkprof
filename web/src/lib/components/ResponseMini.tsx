// The top bar's response time in miniature, shared by the standalone shell and the desktop app so the two cannot drift: the
// scope's response time (Σ session spans of the selected files, no window) with its class split and the three largest classes.
import { useMemo } from 'react'
import type { TraceDoc } from '../data/doc'
import type { ScopeProfile } from '../data/derive'
import { sourceOf, useSourceQuery } from '../data/source'
import { responseOf, type ResponseScope, type ScopeResponse } from '../data/response'
import { traceSegmentsFrom } from '../data/derive'
import { ctxKey } from '../data/fileset'
import { fmtDur, fmtPct } from '../data/format'
import { scopeOf } from '../state/store'
import { useStore } from '../state/session'
import type { Segment } from './ProfileBar'

export interface ResponseSummary {
  resp: ScopeResponse
  /** the class split of `resp.responseUs`, unaccounted included */
  segs: Segment[]
  /** the three largest classes (unaccounted aside) */
  top: Segment[]
}

/**
 * The response time of a scope and its class split, both of that scope. Without a profile answer yet (a remote source loading)
 * a narrowed scope has no split rather than the whole trace's measured against the scope's time.
 */
export function responseSummary(doc: TraceDoc, scope: ResponseScope, profile: ScopeProfile | null | undefined): ResponseSummary {
  const resp = responseOf(doc, scope, profile)
  const segs = !profile && (scope.window || scope.contexts) ? [] : traceSegmentsFrom(doc, profile ?? null, resp.responseUs).filter((s) => s.us > 0)
  const top = segs.filter((s) => s.role !== 'unaccounted').sort((a, b) => b.us - a.us).slice(0, 3)
  return { resp, segs, top }
}

/** The summary of the store's file / session scope (the window aside) and the profile answer it came from. */
export function useScopeResponse(doc: TraceDoc): ResponseSummary & { profile: ScopeProfile | null | undefined } {
  const state = useStore((s) => s)
  const source = sourceOf(doc)
  const scope = { ...scopeOf(state), window: null }
  const q = useSourceQuery(source, `top:${ctxKey(scope.contexts)}:${scope.includeIdle ? 1 : 0}`, (signal) => source.profile(scope, signal), 'top')
  const key = ctxKey(scope.contexts)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sum = useMemo(() => responseSummary(doc, scope, q.data), [doc, key, q.data])
  return { ...sum, profile: q.data }
}

/** "12.3 s ▮▮▮ 58% Idle · 19% Other waits · 18% User I/O" */
export function ResponseMini({ summary }: { summary: ResponseSummary }) {
  const { resp, segs, top } = summary
  const totalUs = resp.responseUs
  return (
    <span className="mini" title={`response time by class${resp.sessions > 1 ? `: sum over ${resp.sessions} sessions, wall clock ${fmtDur(resp.wallUs)}` : ''}`}>
      <b>{fmtDur(totalUs)}</b>
      <span className="mini-track" role="img" aria-label={segs.map((s) => `${s.label} ${fmtPct(s.us, totalUs, 0)}`).join(', ')}>
        {segs.map((s) => <i key={s.role} className={s.role === 'unaccounted' ? 'unaccounted' : undefined} style={{ flex: `${s.us} 1 0`, background: s.role === 'unaccounted' ? undefined : `var(--c-${s.role})` }} />)}
      </span>
      <span className="dim">{top.map((s) => `${fmtPct(s.us, totalUs, 0)} ${s.label}`).join(' · ')}</span>
    </span>
  )
}
