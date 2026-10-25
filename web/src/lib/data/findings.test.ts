import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { TraceDoc } from './doc'
import type { Finding, RawDocument } from './types'
import { fmtUsGo, goFixed, goG, scopedFindings } from './findings'
import { LocalSource, RemoteSource } from './source'
import type { ApiClient } from './client'
import { effectiveContexts } from './fileset'

// Documents written by internal/report TestFindingsDocsCurrent (`go test ./internal/report -run FindingsDocs
// -update-findings-docs`): real trace sets with thresholds that make the rules fire, plus the engine's
// analyze.FindingsOn answers for some scopes.
const dir = fileURLToPath(new URL('./testdata/', import.meta.url))
const fixtures = readdirSync(dir).filter((f) => f.startsWith('findings-') && f.endsWith('.json.gz'))

interface Fixture { doc: RawDocument; scopes: { contexts: number[] | null; from: number; to: number; findings: Finding[] }[] }
const load = (f: string): Fixture => JSON.parse(gunzipSync(readFileSync(dir + f)).toString('utf8'))

describe('scopedFindings (the in-browser api/findings)', () => {
  it('has fixtures', () => expect(fixtures.length).toBeGreaterThanOrEqual(4))

  for (const f of fixtures) {
    it(`${f}: the whole set gives doc.stats.findings, each scope the engine's answer`, async () => {
      const fx = load(f)
      const doc = await TraceDoc.fromRaw(fx.doc)
      expect(doc.stats.findings.length).toBeGreaterThan(0)
      expect(scopedFindings(doc, { window: null, contexts: null })).toEqual(doc.stats.findings)
      for (const sc of fx.scopes) {
        const window = sc.from || sc.to ? { startTim: sc.from, endTim: sc.to } : null
        const got = scopedFindings(doc, { window, contexts: sc.contexts ? new Set(sc.contexts) : null })
        expect(got, `${f} contexts ${sc.contexts} window ${sc.from}..${sc.to}`).toEqual(sc.findings)
      }
    })
  }

  it('every rule is covered by the fixtures', () => {
    const rules = new Set<string>()
    for (const f of fixtures) for (const x of load(f).doc.stats.findings ?? []) rules.add(x.rule)
    expect([...rules].sort()).toEqual(['commit-per-row', 'hard-closes', 'hard-parses', 'in-call-idle', 'outlier-executions', 'parse-per-exec', 'plan-change', 'round-trips', 'small-fetches', 'think-time'])
  })

  it('an empty context set has no findings', async () => {
    const doc = await TraceDoc.fromRaw(load(fixtures[0]).doc)
    expect(scopedFindings(doc, { window: null, contexts: new Set() })).toEqual([])
  })
})

describe('Go formatting', () => {
  it('%.Nf rounds exact ties to even', () => {
    expect(goFixed(1.25, 1)).toBe('1.2')
    expect(goFixed(1.35, 1)).toBe('1.4') // 1.35 is below the tie in binary: as toFixed
    expect(goFixed(0.5, 0)).toBe('0')
    expect(goFixed(1.5, 0)).toBe('2')
    expect(goFixed(2.5, 0)).toBe('2')
    expect(goFixed(-2.5, 0)).toBe('-2')
    expect(goFixed(0.125, 2)).toBe('0.12')
    expect(goFixed(3.14159, 3)).toBe('3.142')
  })
  it('%g', () => {
    expect(goG(3)).toBe('3')
    expect(goG(0.5)).toBe('0.5')
    expect(goG(1.2)).toBe('1.2')
    expect(goG(100000)).toBe('100000')
    expect(goG(1e6)).toBe('1e+06')
    expect(goG(1e9)).toBe('1e+09')
    expect(goG(1234567)).toBe('1.234567e+06')
    expect(goG(0.0001)).toBe('0.0001')
    expect(goG(0.00001)).toBe('1e-05')
  })
  it('fmtUs', () => {
    expect(fmtUsGo(999)).toBe('999 us')
    expect(fmtUsGo(1250)).toBe('1.2 ms')
    expect(fmtUsGo(1_500_000)).toBe('1.500 s')
  })
})

function fakeClient(answer: (url: string) => Response) {
  const fetch = vi.fn(async (url: string) => answer(url))
  return { client: { base: '', fetch } as unknown as ApiClient, fetch }
}

describe('DataSource.findings', () => {
  it('LocalSource computes them from the fact columns (one file of a set: that file\'s), null without facts', async () => {
    const fx = load('findings-multisession.json.gz')
    const doc = await TraceDoc.fromRaw(fx.doc)
    const files = new Set([1])
    const contexts = effectiveContexts(doc, files, null)!
    const want = fx.scopes.find((s) => s.contexts && !s.from && s.contexts.join() === [...contexts].sort((a, b) => a - b).join())!
    expect(want).toBeDefined()
    const src = new LocalSource(doc)
    const got = src.findings({ window: null, files, contexts, includeIdle: false })
    expect(got).toEqual(want.findings)
    expect(got).not.toEqual(doc.stats.findings)
    Object.defineProperty(doc, 'hasFacts', { value: false })
    expect(new LocalSource(doc).findings({ window: null, files: null, contexts: null, includeIdle: true })).toBeNull()
  })

  it('RemoteSource asks api/findings with the scope (no idle: it does not apply); 404 is "not available", asked once', async () => {
    const doc = await TraceDoc.fromRaw(load(fixtures[0]).doc)
    const list = doc.stats.findings.slice(0, 2)
    const ok = fakeClient(() => new Response(JSON.stringify({ findings: list })))
    const r = await new RemoteSource(doc, ok.client).findings({ window: { startTim: 5, endTim: 9 }, files: new Set([0]), contexts: new Set([1, 0]), includeIdle: false })
    expect(r).toEqual(list)
    expect(ok.fetch.mock.calls[0][0]).toBe('/api/findings?from=5&to=9&contexts=0%2C1')
    const none = fakeClient(() => new Response('{"findings":[]}'))
    await new RemoteSource(doc, none.client).findings({ window: null, files: new Set(), contexts: new Set(), includeIdle: true })
    expect(none.fetch.mock.calls[0][0]).toBe('/api/findings?contexts=-')
    const old = fakeClient(() => new Response('not found', { status: 404 }))
    const src = new RemoteSource(doc, old.client)
    expect(await src.findings({ window: null, files: null, contexts: new Set([0]), includeIdle: true })).toBeNull()
    expect(await src.findings({ window: null, files: null, contexts: new Set([1]), includeIdle: true })).toBeNull()
    expect(old.fetch).toHaveBeenCalledTimes(1)
    const bad = fakeClient(() => new Response('boom', { status: 500 }))
    await expect(new RemoteSource(doc, bad.client).findings({ window: null, files: null, contexts: new Set([0]), includeIdle: true })).rejects.toThrow(/boom/)
  })
})
