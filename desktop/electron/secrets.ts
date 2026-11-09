// Assistant API keys. A key the user chose to remember is kept encrypted with Electron's
// safeStorage (the key of the encryption is in the OS keychain: Keychain Services, DPAPI, the
// Secret Service / kwallet) in `<data dir>/secrets.json` under `assist:<provider id>`, as
// `{"endpoint", "key"}`, bound to the endpoint it was typed for (the provider's kind and base URL).
// The main process reads the open prompt from the engine (`GET /engine/prompts/{id}`) and answers
// an `apikey` prompt itself only when its endpoint is the one the key was kept for
// (`POST /engine/prompts/{id}` with the token it holds), so a stored key never enters the page
// and never goes to another endpoint under the same id. Without a keychain (Linux without a
// Secret Service: safeStorage falls back to a fixed password, which is no protection) a
// remembered key is kept in this process's memory until the app quits.
// Keys the Tauri shell (v0.6.0 and older) remembered are in the OS keychain (service: the app
// identifier, the same account and secret): on macOS a key missing here is taken over from there
// once per provider (`security` asks the user to allow it), then kept here.

const ANSWER_TIMEOUT = 5_000

export class VaultUnavailable extends Error {}

/** Where remembered keys live: safeStorage over a file, or a stand-in in tests. */
export interface Vault {
  get(account: string): string | null
  set(account: string, secret: string): void
  delete(account: string): void
}

export type Stored = { key: string } | { missing: true; keychain: boolean }
/** Where a typed key was kept besides the engine's memory. */
export type Kept = 'keychain' | 'session' | 'engine'
/** What `assist_key_answer` did. */
export type KeyAnswer = { status: 'answered' } | { status: 'missing'; keychain: boolean }

interface Bound {
  endpoint: string
  key: string
}

/** The key when it was kept for `endpoint`; a secret of another shape answers for none. */
function parse(secret: string, endpoint: string): string | null {
  try {
    const b = JSON.parse(secret) as Partial<Bound>
    return b && b.endpoint === endpoint && typeof b.key === 'string' && b.key ? b.key : null
  } catch {
    return null
  }
}

const account = (provider: string) => `assist:${provider}`

/** The Tauri shell's keychain entries, read only (macOS: `security`); null when there is none. */
export type Legacy = (account: string) => Promise<string | null>

type Warn = (m: string) => void

/** The remembered keys by provider id, each bound to an endpoint. */
export class Secrets {
  /** keys remembered while the vault failed, for this run only */
  private session = new Map<string, Bound>()

  constructor(private vault: Vault, private warn: Warn = () => {}) {}

  /** The key remembered for `provider` at `endpoint`; one kept for another endpoint is missing. */
  find(provider: string, endpoint: string): Stored {
    const b = this.session.get(provider)
    if (b && b.endpoint === endpoint) return { key: b.key }
    try {
      const secret = this.vault.get(account(provider))
      const key = secret === null ? null : parse(secret, endpoint)
      return key ? { key } : { missing: true, keychain: true }
    } catch (e) {
      this.warn(`assistant key of ${provider}: ${e}`)
      return { missing: true, keychain: !(e instanceof VaultUnavailable) }
    }
  }

  keep(provider: string, endpoint: string, key: string, remember: boolean): Kept {
    if (!remember) return 'engine'
    const bound = { endpoint, key }
    try {
      this.vault.set(account(provider), JSON.stringify(bound))
      this.session.delete(provider)
      return 'keychain'
    } catch (e) {
      this.warn(`assistant key of ${provider}: ${e}; kept for this session only`)
      this.session.set(provider, bound)
      return 'session'
    }
  }

  /**
   * The key the Tauri shell remembered for `provider` at `endpoint`, moved into the vault; tried
   * once per provider (a refusal is not asked again).
   */
  async takeOver(provider: string, endpoint: string, legacy: Legacy): Promise<string | null> {
    const tried = `legacy-tried:${provider}`
    try {
      if (this.vault.get(tried) !== null) return null
      this.vault.set(tried, '1')
    } catch {
      return null // no vault to move it into
    }
    let secret: string | null
    try {
      secret = await legacy(account(provider))
    } catch (e) {
      this.warn(`assistant key of ${provider} in the old keychain entry: ${e}`)
      return null
    }
    const key = secret === null ? null : parse(secret, endpoint)
    if (!key) return null
    this.keep(provider, endpoint, key, true)
    return key
  }

  forget(provider: string): void {
    this.session.delete(provider)
    try {
      this.vault.delete(account(provider))
    } catch (e) {
      if (!(e instanceof VaultUnavailable)) throw e
    }
  }
}

/** A prompt or provider id as the engine makes them: it goes into a URL path and an account name. */
export function checkId(what: string, id: unknown): string {
  if (typeof id === 'string' && id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) return id
  throw new Error(`${what}: not an id: ${JSON.stringify(id)}`)
}

export type Endpoint = { addr: string; token: string }

/** What the main process reads of an open prompt (`PromptEvent`). */
interface OpenPrompt {
  kind: string
  connection: string
  endpoint?: string
}

async function engineFetch(e: Endpoint, promptId: string, init?: RequestInit): Promise<Response> {
  // a key goes to the app's own engine on loopback, nowhere else
  if (!/^127\.0\.0\.1:\d{1,5}$/.test(e.addr)) throw new Error(`the engine is not on loopback: ${e.addr}`)
  return fetch(`http://${e.addr}/engine/prompts/${encodeURIComponent(promptId)}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${e.token}` },
    signal: AbortSignal.timeout(ANSWER_TIMEOUT),
  })
}

/** `GET /engine/prompts/{id}`: the open prompt as the engine raised it, straight from the engine. */
export async function getPrompt(e: Endpoint, promptId: string): Promise<OpenPrompt> {
  let r: Response
  try {
    r = await engineFetch(e, promptId)
  } catch (err) {
    throw new Error(`read the key prompt: ${err}`)
  }
  if (r.status === 404) throw new Error('the key prompt is gone (its turn ended)')
  if (r.status !== 200) throw new Error(`read the key prompt: HTTP ${r.status}`)
  try {
    return (await r.json()) as OpenPrompt
  } catch (err) {
    throw new Error(`read the key prompt: ${err}`)
  }
}

/** The endpoint of the open prompt when it is the `apikey` prompt of `provider`. */
export function endpointOf(p: OpenPrompt, provider: string): string {
  if (p.kind !== 'apikey' || p.connection !== provider) {
    throw new Error(`the prompt is not the key prompt of ${provider} (kind ${p.kind}, connection ${p.connection})`)
  }
  // the key is bound to where the engine sends it: no endpoint, no key
  if (!p.endpoint) throw new Error(`the key prompt of ${provider} names no endpoint`)
  return p.endpoint
}

/** `POST /engine/prompts/{id}` with `{"answer": key}`, straight to the engine (never a proxy). */
export async function postAnswer(e: Endpoint, promptId: string, key: string): Promise<void> {
  let r: Response
  try {
    r = await engineFetch(e, promptId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: key }) })
  } catch (err) {
    throw new Error(`answer the key prompt: ${err}`)
  }
  if (r.status === 204) return
  if (r.status === 404) throw new Error('the key prompt is gone (its turn ended)')
  throw new Error(`answer the key prompt: HTTP ${r.status}`)
}

/** The three commands, over the engine's endpoint (null: not running) and the remembered keys. */
export class KeyCommands {
  constructor(private secrets: Secrets, private endpoint: () => Endpoint | null, private legacy: Legacy | null = null) {}

  private engine(): Endpoint {
    const e = this.endpoint()
    if (!e) throw new Error('the engine is not running')
    return e
  }

  /** Answers the `apikey` prompt `promptId` with the key remembered for `provider` at the prompt's endpoint, if any. */
  async answer(promptId: unknown, provider: unknown): Promise<KeyAnswer> {
    const id = checkId('prompt', promptId)
    const pv = checkId('provider', provider)
    const e = this.engine()
    const endpoint = endpointOf(await getPrompt(e, id), pv)
    const s = this.secrets.find(pv, endpoint)
    const key = 'key' in s ? s.key : this.legacy && s.keychain ? await this.secrets.takeOver(pv, endpoint, this.legacy) : null
    if (key) {
      await postAnswer(e, id, key)
      return { status: 'answered' }
    }
    return { status: 'missing', keychain: 'keychain' in s ? s.keychain : true }
  }

  /** Answers the prompt with the key the user typed, then remembers it when asked to. */
  async storeAndAnswer(promptId: unknown, provider: unknown, key: unknown, remember: unknown): Promise<Kept> {
    const id = checkId('prompt', promptId)
    const pv = checkId('provider', provider)
    const k = typeof key === 'string' ? key.trim() : ''
    const e = this.engine()
    const endpoint = endpointOf(await getPrompt(e, id), pv)
    await postAnswer(e, id, k)
    if (!k) return 'engine'
    return this.secrets.keep(pv, endpoint, k, remember === true)
  }

  /** Drops the key remembered for `provider` (the engine's own copy goes with its key route). */
  forget(provider: unknown): void {
    this.secrets.forget(checkId('provider', provider))
  }
}
