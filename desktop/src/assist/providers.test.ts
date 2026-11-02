import { describe, expect, it } from 'vitest'
import {
  type AssistProvider, headerProblem, keyMoved, ndjson, newProviderId, parseHeaders, parseProviders, toEngineProvider, validateProvider,
} from './providers'

const openai: AssistProvider = { id: 'p1', kind: 'openai', name: 'Local', auth: 'bearer', baseUrl: 'http://127.0.0.1:8000/v1', model: 'gpt-x' }
const claude: AssistProvider = { id: 'p2', kind: 'claude', name: 'Claude', auth: 'login' }

describe('validateProvider', () => {
  it('normalizes and defaults the auth of the kind', () => {
    expect(validateProvider({ id: 'a', kind: 'openai', baseUrl: ' http://h/v1 ', model: 'm' })).toEqual({
      provider: { id: 'a', kind: 'openai', name: 'a', auth: 'bearer', baseUrl: 'http://h/v1', model: 'm' },
      problems: [],
    })
    expect(validateProvider({ id: 'c', kind: 'codex' }).provider).toEqual({ id: 'c', kind: 'codex', name: 'c', auth: 'login' })
  })
  it('drops unknown fields and secret-looking fields with a warning', () => {
    const { provider, problems } = validateProvider({ ...openai, apiKey: 'sk-live', token: 't', colour: 'red' })
    expect(provider).toEqual(openai)
    expect(problems.join('\n')).toMatch(/"apiKey" ignored/)
    expect(problems.join('\n')).toMatch(/"token" ignored/)
    expect(problems.join('\n')).toMatch(/unknown field "colour"/)
    expect(JSON.stringify(provider)).not.toContain('sk-live')
  })
  it('drops credential headers and keeps the others', () => {
    const { provider, problems } = validateProvider({ ...openai, headers: { Authorization: 'Bearer sk', 'X-Api-Key': 'k', 'X-Team': 'dba', 'X-Odd': 'Basic abc' } })
    expect(provider?.headers).toEqual({ 'X-Team': 'dba' })
    expect(problems).toHaveLength(3)
    expect(JSON.stringify(provider)).not.toMatch(/sk|abc/)
  })
  it('rejects unusable definitions', () => {
    const bad = (raw: unknown) => validateProvider(raw).provider
    expect(bad(null)).toBeUndefined()
    expect(bad({ ...openai, id: 'bad id' })).toBeUndefined()
    expect(bad({ ...openai, kind: 'gemini' })).toBeUndefined()
    expect(bad({ ...openai, auth: 'login' })).toBeUndefined()
    expect(bad({ ...openai, model: '' })).toBeUndefined()
    expect(bad({ ...claude, auth: 'bearer' })).toBeUndefined()
    expect(bad({ ...claude, model: '--dangerously-skip-permissions' })).toBeUndefined()
    for (const baseUrl of ['ftp://h/v1', 'h/v1', 'http://u:pw@h/v1', 'http://h/v1?key=sk', 'http://h/v1#x']) expect(bad({ ...openai, baseUrl })).toBeUndefined()
  })
  it('a CLI kind takes no base URL or headers', () => {
    const { provider, problems } = validateProvider({ ...claude, baseUrl: 'http://h', headers: { 'X-A': 'b' }, model: 'sonnet' })
    expect(provider).toEqual({ ...claude, model: 'sonnet' })
    expect(problems.join()).toMatch(/ignored/)
  })
})

describe('parseProviders', () => {
  it('skips unusable and repeated entries', () => {
    const r = parseProviders([openai, { id: 'x' }, { ...claude, id: 'p1' }, claude, 7])
    expect(r.providers).toEqual([openai, claude])
    expect(r.problems).toContain('providers[2]: duplicate id "p1" skipped')
    expect(r.problems.some((p) => p.startsWith('providers[1]:'))).toBe(true)
  })
  it('reads nothing from a missing or broken value', () => {
    expect(parseProviders(undefined).providers).toEqual([])
    expect(parseProviders({ a: 1 }).problems).toEqual(['providers: not a list'])
  })
})

describe('headers', () => {
  it('parses Name: value lines and refuses credentials with a pointer to the key prompt', () => {
    expect(parseHeaders('X-Team: dba\n\n  X-Region : eu ')).toEqual({ headers: { 'X-Team': 'dba', 'X-Region': 'eu' }, problems: [] })
    const r = parseHeaders('Authorization: Bearer sk-1\nno colon')
    expect(r.headers).toEqual({})
    expect(r.problems[0]).toMatch(/looks like a credential.*key prompt/)
    expect(r.problems[1]).toMatch(/want Name: value/)
  })
  it.each(['Authorization', 'x-api-key', 'X-Auth-Token', 'Cookie', 'Proxy-Authorization'])('%s is a credential', (h) => {
    expect(headerProblem(h, 'v')).toMatch(/credential/)
  })
})

describe('engine shape', () => {
  it('sends only what the engine Provider takes', () => {
    expect(toEngineProvider({ ...openai, headers: {} })).toEqual({ id: 'p1', kind: 'openai', name: 'Local', auth: 'bearer', baseUrl: 'http://127.0.0.1:8000/v1', model: 'gpt-x' })
    expect(toEngineProvider(claude)).toEqual({ id: 'p2', kind: 'claude', name: 'Claude', auth: 'login' })
  })
  it('new ids are engine ids and do not repeat', () => {
    const a = newProviderId()
    expect(a).toMatch(/^p[0-9a-f]{12}$/)
    expect(validateProvider({ ...openai, id: a }).provider).toBeDefined()
    expect(newProviderId()).not.toBe(a)
  })
  it('a key moves with the endpoint, not with the name or model', () => {
    expect(keyMoved(openai, { ...openai, name: 'x', model: 'y' })).toBe(false)
    expect(keyMoved(openai, { ...openai, baseUrl: 'https://elsewhere/v1' })).toBe(true)
    expect(keyMoved(openai, { ...openai, auth: 'none' })).toBe(true)
  })
})

describe('ndjson', () => {
  it('splits objects across chunk boundaries', async () => {
    const chunks = ['{"type":"te', 'xt","text":"O"}\n{"type":"done"}', '\n\n{"type":"x"}']
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(new TextEncoder().encode(s))
        c.close()
      },
    })
    const got: unknown[] = []
    for await (const ev of ndjson(body)) got.push(ev)
    expect(got).toEqual([{ type: 'text', text: 'O' }, { type: 'done' }, { type: 'x' }])
  })
})
