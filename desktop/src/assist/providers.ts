import type { ApiClient } from '@lib/data/client'
import { responseError, send } from '../engine/client'
import type { Schemas } from '../engine/types'

/**
 * The assistant's model providers as Settings keeps them (`assistProviders` in `settings.json`):
 * what the engine's `Provider` takes, never a secret. A key is asked through the engine's
 * `apikey` prompt and lives in the OS keychain or the engine's memory, not here.
 */
export type ProviderKind = Schemas['Provider']['kind']
export type ProviderAuth = NonNullable<Schemas['Provider']['auth']>

export interface AssistProvider {
  id: string
  kind: ProviderKind
  name: string
  auth: ProviderAuth
  /** openai only: http(s), up to the version (`http://localhost:11434/v1`) */
  baseUrl?: string
  /** openai: required; claude, codex: absent = the CLI's default */
  model?: string
  /** openai only: extra request headers, none a credential */
  headers?: Record<string, string>
}

/** What each kind takes, as the engine checks it (`assist.Provider.Check`); `auth` default first. */
export const KINDS: Record<ProviderKind, { label: string; http: boolean; auth: ProviderAuth[] }> = {
  openai: { label: 'OpenAI-compatible', http: true, auth: ['bearer', 'none'] },
  claude: { label: 'Claude Code', http: false, auth: ['login'] },
  codex: { label: 'Codex', http: false, auth: ['login', 'bearer'] },
}

export const AUTH_LABEL: Record<ProviderAuth, string> = { bearer: 'API key', none: 'no key', login: 'CLI login' }

export const needsKey = (p: Pick<AssistProvider, 'auth'>) => p.auth === 'bearer'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CLI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/
const CREDENTIAL_WORDS = ['auth', 'key', 'token', 'secret', 'password', 'cookie']
const SECRET_FIELDS = ['key', 'apikey', 'api_key', 'token', 'secret', 'password', 'authorization']
const KNOWN_FIELDS = new Set(['id', 'kind', 'name', 'auth', 'baseUrl', 'model', 'headers'])
const MAX_HEADERS = 20

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Why a request header may not be part of a provider, or null. */
export function headerProblem(name: string, value: string): string | null {
  if (!HEADER_NAME_RE.test(name)) return `"${name}" is not a header name`
  const n = name.toLowerCase()
  if (CREDENTIAL_WORDS.some((w) => n.includes(w))) return `"${name}" looks like a credential: the key is asked for when the provider is used (the key prompt)`
  if (/^(bearer|basic)\s/i.test(value.trim())) return `the value of "${name}" looks like a credential: the key is asked for when the provider is used (the key prompt)`
  if (value.length > 1000 || /[\r\n]/.test(value)) return `the value of "${name}" must be one line of at most 1000 characters`
  return null
}

/** `Name: value` per line (the form's headers box); empty lines are skipped. */
export function parseHeaders(text: string): { headers: Record<string, string>; problems: string[] } {
  const headers: Record<string, string> = {}
  const problems: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const i = line.indexOf(':')
    if (i < 0) {
      problems.push(`"${line.trim()}": want Name: value`)
      continue
    }
    const name = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim()
    const bad = headerProblem(name, value)
    if (bad) problems.push(bad)
    else headers[name] = value
  }
  if (Object.keys(headers).length > MAX_HEADERS) problems.push(`at most ${MAX_HEADERS} headers`)
  return { headers, problems }
}

export const formatHeaders = (h: Record<string, string> | undefined) =>
  Object.entries(h ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')

function baseUrlProblem(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'base URL: want an http or https URL'
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.host) return 'base URL: want an http or https URL'
  if (u.username || u.password || u.search || u.hash) return 'base URL: no user, query or fragment (the key is asked for when the provider is used)'
  return null
}

/**
 * Checks one provider definition. Answers the normalized provider (none when it is unusable)
 * and the problems found: unknown fields are dropped, a secret field is dropped with a warning,
 * and so is a header that looks like a credential.
 */
export function validateProvider(raw: unknown, where = 'provider'): { provider?: AssistProvider; problems: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problems: [`${where}: not an object`] }
  const r = raw as Record<string, unknown>
  const problems: string[] = []
  for (const k of Object.keys(r)) {
    if (SECRET_FIELDS.includes(k.toLowerCase())) problems.push(`${where}: "${k}" ignored (keys are never stored with a provider; they are asked for on use)`)
    else if (!KNOWN_FIELDS.has(k)) problems.push(`${where}: unknown field "${k}" ignored`)
  }
  const id = str(r.id)
  const kind = r.kind as ProviderKind
  const k = KINDS[kind] as (typeof KINDS)[ProviderKind] | undefined
  const bad: string[] = []
  if (!ID_RE.test(id)) bad.push(`id ${JSON.stringify(r.id ?? '')} must be 1-128 of A-Z a-z 0-9 . _ : - (starting with a letter or digit)`)
  if (!k) bad.push(`kind must be one of ${Object.keys(KINDS).join(', ')}`)
  const name = str(r.name) || id
  if (name.length > 200) bad.push('name: at most 200 characters')
  const auth = (str(r.auth) || k?.auth[0]) as ProviderAuth
  if (k && !k.auth.includes(auth)) bad.push(`auth: ${kind} takes ${k.auth.join(' or ')}`)
  const model = str(r.model)
  const baseUrl = str(r.baseUrl)
  const headers: Record<string, string> = {}
  if (k?.http) {
    const u = baseUrlProblem(baseUrl)
    if (u) bad.push(u)
    if (!model || model.length > 200) bad.push('model: required, at most 200 characters')
    if (r.headers !== undefined) {
      if (!r.headers || typeof r.headers !== 'object' || Array.isArray(r.headers)) bad.push('headers: want an object of name: value')
      else
        for (const [hn, hv] of Object.entries(r.headers as Record<string, unknown>)) {
          const p = typeof hv === 'string' ? headerProblem(hn, hv) : `the value of "${hn}" must be text`
          if (p) problems.push(`${where}: header ${p}; dropped`)
          else headers[hn] = hv as string
        }
      if (Object.keys(headers).length > MAX_HEADERS) bad.push(`headers: at most ${MAX_HEADERS}`)
    }
  } else if (k) {
    if (baseUrl || r.headers !== undefined) problems.push(`${where}: base URL and headers ignored: ${kind} runs the ${kind} CLI`)
    if (model && !CLI_MODEL_RE.test(model)) bad.push('model: a model name of letters, digits and . _ : / @ [ ] - (not an option)')
  }
  if (bad.length) return { problems: [...problems, ...bad.map((b) => `${where}: ${b}`)] }

  const p: AssistProvider = { id, kind, name, auth }
  if (k!.http) {
    p.baseUrl = baseUrl
    if (Object.keys(headers).length) p.headers = headers
  }
  if (model) p.model = model
  return { provider: p, problems }
}

/** The stored list: unusable and repeated entries are skipped, with a line each. */
export function parseProviders(raw: unknown): { providers: AssistProvider[]; problems: string[] } {
  if (raw === undefined || raw === null) return { providers: [], problems: [] }
  if (!Array.isArray(raw)) return { providers: [], problems: ['providers: not a list'] }
  const providers: AssistProvider[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  raw.forEach((x, i) => {
    const { provider, problems: p } = validateProvider(x, `providers[${i}]`)
    problems.push(...p)
    if (!provider) return
    if (seen.has(provider.id)) return void problems.push(`providers[${i}]: duplicate id "${provider.id}" skipped`)
    seen.add(provider.id)
    providers.push(provider)
  })
  return { providers, problems }
}

/** A fresh id: random, so a key remembered for a removed provider never answers for a new one. */
export function newProviderId(): string {
  const b = crypto.getRandomValues(new Uint8Array(6))
  return 'p' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** What `POST /engine/assist/conversations` takes as `provider`. */
export function toEngineProvider(p: AssistProvider): Schemas['Provider'] {
  const o: Schemas['Provider'] = { id: p.id, kind: p.kind, name: p.name, auth: p.auth }
  if (p.baseUrl) o.baseUrl = p.baseUrl
  if (p.model) o.model = p.model
  if (p.headers && Object.keys(p.headers).length) o.headers = p.headers
  return o
}

/** The key of a provider changes meaning when it points somewhere else: forget it then. */
export const keyMoved = (a: AssistProvider, b: AssistProvider) => a.kind !== b.kind || a.auth !== b.auth || (a.baseUrl ?? '') !== (b.baseUrl ?? '')

/** The JSON objects of an NDJSON body, one per line. */
export async function* ndjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let rest = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (value) rest += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, nl).trim()
      rest = rest.slice(nl + 1)
      if (line) yield JSON.parse(line) as T
    }
    if (done) break
  }
  if (rest.trim()) yield JSON.parse(rest) as T
}

export const TEST_MESSAGE = 'This is a connection test from mtkprof. Reply with the single word OK and do not call any tools.'

export type TestResult = { ok: true; ms: number; text: string } | { ok: false; code: string; message: string }

/**
 * A provider test: one short conversation on the session `session` (the key prompt, if any,
 * shows on the way), which is ended afterwards. It passes when the turn answers (`done`).
 */
export async function testProvider(client: ApiClient, session: string, p: AssistProvider, signal?: AbortSignal): Promise<TestResult> {
  const t0 = performance.now()
  let conv: Schemas['ConversationInfo']
  try {
    conv = await send(client, 'POST', '/engine/assist/conversations', { session, provider: toEngineProvider(p), consent: true, binds: 'mask' })
  } catch (e) {
    return { ok: false, code: 'request', message: e instanceof Error ? e.message : String(e) }
  }
  const path = `/engine/assist/conversations/${encodeURIComponent(conv.id)}`
  try {
    const r = await client.fetch(`${path}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: TEST_MESSAGE }),
      headers: { 'content-type': 'application/json' },
      signal,
    })
    if (!r.ok || !r.body) throw await responseError(r, 'POST messages')
    let text = ''
    for await (const ev of ndjson<Schemas['TurnEvent']>(r.body)) {
      if (ev.type === 'text') text += ev.text
      else if (ev.type === 'done') return { ok: true, ms: Math.round(performance.now() - t0), text: text.trim() }
      else if (ev.type === 'error') return { ok: false, code: ev.code, message: ev.message }
    }
    return { ok: false, code: 'internal', message: 'the turn ended without an answer' }
  } catch (e) {
    if (signal?.aborted) return { ok: false, code: 'cancelled', message: 'the test was stopped' }
    return { ok: false, code: 'request', message: e instanceof Error ? e.message : String(e) }
  } finally {
    void send(client, 'DELETE', path).catch(() => {})
  }
}
