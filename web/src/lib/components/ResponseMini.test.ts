import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { TraceDoc } from '../data/doc'
import { effectiveContexts } from '../data/fileset'
import { fmtDur, fmtPct } from '../data/format'
import { LocalSource } from '../data/source'
import type { Scope } from '../state/store'
import type { RawDocument } from '../data/types'
import { responseSummary } from './ResponseMini'

// basic_binds.trc + bind_types.trc, traced after two different instance starts: their tim values are 12.27 h apart, so the
// set's span is not the time of either file (internal/report TestFindingsDocsCurrent writes the document).
const load = async () => {
  const raw = JSON.parse(gunzipSync(readFileSync(fileURLToPath(new URL('../data/testdata/findings-two_boots.json.gz', import.meta.url)))).toString('utf8'))
  return TraceDoc.fromRaw(raw.doc as RawDocument)
}
const scopeOfFiles = (doc: TraceDoc, files: Set<number> | null): Scope => ({ window: null, files, contexts: effectiveContexts(doc, files, null), includeIdle: true })
const line = (doc: TraceDoc, scope: Scope) => {
  const s = responseSummary(doc, scope, new LocalSource(doc).profile(scope))
  return `${fmtDur(s.resp.responseUs)} · ${s.top.map((x) => `${fmtPct(x.us, s.resp.responseUs, 0)} ${x.label}`).join(' · ')}`
}

describe('the top bar response time of a set traced across instance restarts', () => {
  it('measures one file by its session, not by the set\'s tim span', async () => {
    const doc = await load()
    expect(fmtDur(doc.spanUs())).toBe('12.27 h') // what the desktop top bar showed, with every class at 0 %
    expect(line(doc, scopeOfFiles(doc, new Set([1])))).toBe('6.72 ms · 77% CPU · 8% Idle · 0% Network')
    expect(line(doc, scopeOfFiles(doc, new Set([0])))).toBe('190 ms · 67% Idle · 18% CPU · 2% Commit')
  })

  it('sums the two sessions for the whole set', async () => {
    const doc = await load()
    const s = responseSummary(doc, scopeOfFiles(doc, null), new LocalSource(doc).profile(scopeOfFiles(doc, null)))
    expect(s.resp).toMatchObject({ responseUs: 190063 + 6720, sessions: 2 })
  })

  it('has no class split for a narrowed scope until its profile answers', async () => {
    const doc = await load()
    const s = responseSummary(doc, scopeOfFiles(doc, new Set([1])), undefined)
    expect(s.resp.responseUs).toBe(6720)
    expect(s.segs).toEqual([])
  })
})
