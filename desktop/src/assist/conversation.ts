import type { ApiClient } from '@lib/data/client'
import { openKV } from '../platform'
import type { Schemas } from '../engine/types'
import { ndjson, toEngineProvider, type AssistProvider } from './providers'

/**
 * The chat of a tab: the messages, each answer's text, tool rows and intents in the order they streamed, and its usage.
 * `chatReducer` folds the NDJSON events of a turn (`POST /engine/assist/conversations/{c}/messages`, E3) into it;
 * `ChatSession` runs the turns on the engine and keeps the chat per trace identity in `assist.json` (never in a backup).
 */
export type TurnEvent = Schemas['TurnEvent']

export interface TextPart { kind: 'text'; text: string }
/** A tool call and, once it ran, exactly what the model was given (`tool_result.content`). */
export interface ToolPart {
  kind: 'tool'
  id: string
  name: string
  args: Schemas['ToolCallEvent']['args']
  result?: { isError: boolean; content: string; estTokens: number }
}
/** What the app did with an intent: waits for a click (Ask before moving the view), moved the views, or found nothing to open in this trace. */
export type IntentOutcome =
  | { state: 'pending' }
  /** `at`: the hash of the views after the move, so Back is offered only while they still stand there */
  | { state: 'applied'; at: string }
  /** `keys`: what the trace has nothing for (urlstate's keys); none when the link itself is not one the app can open */
  | { state: 'unresolved'; keys: string[] }
/** A place the agent asked to show (the show tool). Without an `outcome` it is as good as pending: a click moves the views. */
export interface IntentPart { kind: 'intent'; id: string; href: string; target: Schemas['Intent']; outcome?: IntentOutcome }
export type Part = TextPart | ToolPart | IntentPart

export interface TurnUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number; requests: number }

export interface UserMessage { role: 'user'; id: string; text: string; at: number }
export interface AssistantMessage {
  role: 'assistant'
  id: string
  at: number
  /** the provider's name when the turn ran */
  provider: string
  parts: Part[]
  state: 'streaming' | 'done' | 'stopped' | 'failed'
  /** waiting for the provider's key (the key prompt is open) */
  waitingKey?: boolean
  usage?: TurnUsage
  error?: { code: string; message: string }
}
export type Message = UserMessage | AssistantMessage

export interface Chat { messages: Message[] }

export type ChatAction =
  | { type: 'send'; id: string; text: string; at: number; provider: string }
  | { type: 'event'; ev: TurnEvent }
  /** an answer's intent got its outcome (parts are told apart by message: a CLI agent's call ids restart each turn) */
  | { type: 'intent'; message: string; id: string; outcome: IntentOutcome }
  /** the stream ended without `done` or `error`: stopped by the user, or the request failed */
  | { type: 'end'; how: 'stopped' | 'failed'; message?: string }
  | { type: 'clear' }

export const emptyChat: Chat = { messages: [] }

const zeroUsage = (): TurnUsage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0 })

/** The answer being streamed, if the last message is one. */
export function streaming(c: Chat): AssistantMessage | null {
  const m = c.messages[c.messages.length - 1]
  return m?.role === 'assistant' && m.state === 'streaming' ? m : null
}

function withAnswer(c: Chat, f: (m: AssistantMessage) => AssistantMessage): Chat {
  const m = streaming(c)
  return m ? { messages: [...c.messages.slice(0, -1), f(m)] } : c
}

function onEvent(m: AssistantMessage, ev: TurnEvent): AssistantMessage {
  switch (ev.type) {
    case 'text': {
      const last = m.parts[m.parts.length - 1]
      if (last?.kind === 'text') return { ...m, parts: [...m.parts.slice(0, -1), { kind: 'text', text: last.text + ev.text }] }
      return { ...m, parts: [...m.parts, { kind: 'text', text: ev.text }] }
    }
    case 'tool_call':
      return { ...m, parts: [...m.parts, { kind: 'tool', id: ev.id, name: ev.name, args: ev.args }] }
    case 'tool_result': {
      const result = { isError: ev.isError, content: ev.content, estTokens: ev.estTokens }
      let i = m.parts.length - 1
      while (i >= 0 && !(m.parts[i].kind === 'tool' && (m.parts[i] as ToolPart).id === ev.id && !(m.parts[i] as ToolPart).result)) i--
      if (i < 0) return { ...m, parts: [...m.parts, { kind: 'tool', id: ev.id, name: ev.name, args: {}, result }] }
      const parts = m.parts.slice()
      parts[i] = { ...(parts[i] as ToolPart), result }
      return { ...m, parts }
    }
    case 'intent':
      return { ...m, parts: [...m.parts, { kind: 'intent', id: ev.id, href: ev.href, target: ev.target }] }
    case 'usage': {
      const u = m.usage ?? zeroUsage()
      return { ...m, usage: { inputTokens: u.inputTokens + ev.inputTokens, outputTokens: u.outputTokens + ev.outputTokens, cachedInputTokens: u.cachedInputTokens + (ev.cachedInputTokens ?? 0), requests: u.requests + 1 } }
    }
    case 'state':
      return { ...m, waitingKey: ev.state === 'waiting_key' }
    case 'done':
      return { ...m, state: 'done', waitingKey: false, usage: { ...ev.usage } }
    case 'error':
      return { ...m, state: ev.code === 'cancelled' ? 'stopped' : 'failed', waitingKey: false, error: ev.code === 'cancelled' ? undefined : { code: ev.code, message: ev.message } }
  }
}

export function chatReducer(c: Chat, a: ChatAction): Chat {
  switch (a.type) {
    case 'send':
      return {
        messages: [
          ...c.messages,
          { role: 'user', id: a.id, text: a.text, at: a.at },
          { role: 'assistant', id: a.id + 'a', at: a.at, provider: a.provider, parts: [], state: 'streaming' },
        ],
      }
    case 'event':
      return withAnswer(c, (m) => onEvent(m, a.ev))
    case 'intent':
      return {
        messages: c.messages.map((m) =>
          m.role === 'assistant' && m.id === a.message
            ? { ...m, parts: m.parts.map((p) => (p.kind === 'intent' && p.id === a.id ? { ...p, outcome: a.outcome } : p)) }
            : m,
        ),
      }
    case 'end':
      return withAnswer(c, (m) => ({ ...m, state: a.how, waitingKey: false, error: a.how === 'failed' ? { code: 'request', message: a.message ?? 'the request failed' } : undefined }))
    case 'clear':
      return emptyChat
  }
}

/** The tokens of every turn so far. */
export function totalUsage(c: Chat): TurnUsage {
  const t = zeroUsage()
  for (const m of c.messages)
    if (m.role === 'assistant' && m.usage) {
      t.inputTokens += m.usage.inputTokens
      t.outputTokens += m.usage.outputTokens
      t.cachedInputTokens += m.usage.cachedInputTokens
      t.requests += m.usage.requests
    }
  return t
}

/** The answer's text, its parts' text joined. */
export const answerText = (m: AssistantMessage) => m.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('')

// ---- persistence: assist.json --------------------------------------------------------------------

/** One trace's entry of `assist.json`, by content identity. */
export interface StoredChat {
  v: 1
  /** ms since the epoch of the last change; the oldest entries go beyond `MAX_TRACES` */
  updated: number
  /** the provider picked for this trace */
  provider?: string
  /** the providers the DBA agreed to send this trace to: id -> ms since the epoch */
  consent: Record<string, number>
  messages: Message[]
}

const FILE = 'assist.json'
export const MAX_TRACES = 30

/** A stored chat as it can be shown: an answer that was streaming when the app went away is stopped. */
export function parseStored(raw: unknown): StoredChat | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<StoredChat>
  if (r.v !== 1 || !Array.isArray(r.messages)) return null
  const messages = r.messages.filter((m): m is Message => !!m && typeof m === 'object' && (m.role === 'user' || (m.role === 'assistant' && Array.isArray(m.parts))))
  return {
    v: 1,
    updated: typeof r.updated === 'number' ? r.updated : 0,
    provider: typeof r.provider === 'string' ? r.provider : undefined,
    consent: r.consent && typeof r.consent === 'object' ? r.consent : {},
    messages: messages.map((m) => (m.role === 'assistant' && m.state === 'streaming' ? { ...m, state: 'stopped', waitingKey: false } : m)),
  }
}

export async function loadChat(identity: string): Promise<StoredChat | null> {
  if (!identity) return null
  return parseStored(await (await openKV(FILE)).get(identity))
}

let queue: Promise<unknown> = Promise.resolve()

/** Writes a trace's entry (one save at a time), dropping the least recently changed traces beyond `MAX_TRACES`. */
export function saveChat(identity: string, entry: StoredChat): Promise<void> {
  const p = queue.then(async () => {
    if (!identity) return
    const kv = await openKV(FILE)
    await kv.set(identity, entry)
    const keys = await kv.keys()
    if (keys.length <= MAX_TRACES) return
    const dated = await Promise.all(keys.map(async (k) => [k, (await kv.get<StoredChat>(k))?.updated ?? 0] as const))
    dated.sort((a, b) => b[1] - a[1])
    for (const [k] of dated.slice(MAX_TRACES)) await kv.delete(k)
  })
  queue = p.catch(() => {})
  return p
}

// ---- turns on the engine -------------------------------------------------------------------------

/** What a send needs from the tab: the engine, its session, the provider and what the views show. */
export interface SendContext {
  client: ApiClient
  session: string
  provider: AssistProvider
  binds: 'mask' | 'keep'
  view: Schemas['View']
  scope: Schemas['BriefScope']
  notes: Schemas['Note'][]
  /** the provider refused its key (`auth`): forget it, or the shell answers the next prompt with it again */
  onAuthError?: (p: AssistProvider) => void
  /** the app's answer to an intent as it arrives (moves the views, or waits for a click); none when the tab is not the chat's any more */
  onIntent?: (p: IntentPart) => IntentOutcome | undefined
}

/** The engine's conversation the chat talks to; a new one is made when the session, the provider or the masking changes. */
interface EngineConv { id: string; session: string; fingerprint: string }

const MAX_CONTEXT_CHARS = 60_000
const BUSY_RETRIES = 6
const BUSY_WAIT_MS = 250

const fingerprint = (ctx: SendContext) => JSON.stringify([toEngineProvider(ctx.provider), ctx.binds])

/**
 * The message for a new engine conversation of a chat that had turns already (the engine restarted, the session closed,
 * the provider changed): the earlier questions and answers as context, the most recent ones when they are long.
 */
export function withHistory(messages: Message[], text: string): string {
  const lines: string[] = []
  for (const m of messages) {
    const t = m.role === 'user' ? m.text : answerText(m)
    if (t.trim()) lines.push(`${m.role === 'user' ? 'DBA' : 'Assistant'}: ${t.trim()}`)
  }
  if (!lines.length) return text
  let past = lines.join('\n\n')
  if (past.length > MAX_CONTEXT_CHARS) past = '…' + past.slice(past.length - MAX_CONTEXT_CHARS)
  return `Earlier in this chat (mtkprof started the conversation again, so the tool results are not repeated; call the tools again for figures):\n\n${past}\n\nThe DBA now asks:\n\n${text}`
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function httpError(r: Response, what: string): Promise<HttpError> {
  let msg = `HTTP ${r.status}`
  try {
    const e = (await r.json()) as Schemas['ErrorEnvelope']
    if (e?.error?.message) msg = `${e.error.code}: ${e.error.message}`
  } catch {
    // not an envelope
  }
  return new HttpError(r.status, `${what}: ${msg}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const raf: (f: () => void) => void = typeof requestAnimationFrame === 'function' ? (f) => void requestAnimationFrame(f) : (f) => void setTimeout(f, 16)

/** What the panel shows of a chat session. `moved`: the intent whose move of the views is the latest (Back is offered on that one only; it is not kept). */
export interface ChatView { chat: Chat; provider?: string; moved?: { message: string; id: string } }

/**
 * One tab's chat: the state for `useSyncExternalStore`, the running turn, and its persistence. Kept per tab outside React,
 * so a turn keeps streaming while another tab is shown. Stream events update the chat at once and notify once a frame.
 */
export class ChatSession {
  private chat: Chat = emptyChat
  private view: ChatView = { chat: emptyChat }
  private moved: ChatView['moved']
  private stored: Omit<StoredChat, 'messages'> = { v: 1, updated: 0, consent: {} }
  private conv: EngineConv | null = null
  private ctl: AbortController | null = null
  private listeners = new Set<() => void>()
  private pending = false
  private loading: Promise<void> | null = null

  constructor(readonly identity: string, private persist = !!identity) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }

  getSnapshot = (): ChatView => this.view

  get running(): boolean { return this.ctl !== null }

  /** Reads the trace's stored chat once; nothing changes when a chat was started meanwhile. */
  load(): Promise<void> {
    if (!this.loading)
      this.loading = (this.persist ? loadChat(this.identity) : Promise.resolve(null)).then((s) => {
        if (!s) return
        this.stored = { ...this.stored, provider: this.stored.provider ?? s.provider, consent: { ...s.consent, ...this.stored.consent }, updated: s.updated }
        if (this.chat.messages.length === 0) this.chat = { messages: s.messages }
        this.emit()
      }, (e) => console.warn('assist.json:', String(e)))
    return this.loading
  }

  hasConsent(provider: string): boolean { return provider in this.stored.consent }

  giveConsent(provider: string) {
    this.stored = { ...this.stored, consent: { ...this.stored.consent, [provider]: Date.now() } }
    this.save()
  }

  pickProvider(provider: string) {
    if (this.stored.provider === provider) return
    this.stored = { ...this.stored, provider }
    this.save()
    this.emit()
  }

  private dispatch(a: ChatAction, now = false) {
    this.chat = chatReducer(this.chat, a)
    if (now) this.emit()
    else if (!this.pending) {
      this.pending = true
      raf(() => {
        this.pending = false
        this.emit()
      })
    }
  }

  private emit() {
    if (this.view.chat !== this.chat || this.view.provider !== this.stored.provider || this.view.moved !== this.moved)
      this.view = { chat: this.chat, provider: this.stored.provider, moved: this.moved }
    for (const l of this.listeners) l()
  }

  private save() {
    if (!this.persist) return
    const entry: StoredChat = { ...this.stored, updated: Date.now(), messages: this.chat.messages }
    this.stored.updated = entry.updated
    void saveChat(this.identity, entry).catch((e) => console.warn('assist.json:', String(e)))
  }

  /** Stops the running turn: the stream's fetch is aborted, which cancels the turn in the engine. */
  stop() {
    this.ctl?.abort()
  }

  private settle(message: string, id: string, outcome: IntentOutcome) {
    if (outcome.state === 'applied') this.moved = { message, id }
    this.dispatch({ type: 'intent', message, id, outcome }, true)
  }

  /** Records what became of an intent after the turn (a click on its chip). */
  settleIntent(message: string, id: string, outcome: IntentOutcome) {
    this.settle(message, id, outcome)
    if (!this.ctl) this.save()
  }

  /** A new chat: the engine's conversation ends, the messages go (the consents stay). */
  clear(client: ApiClient | null) {
    this.stop()
    const c = this.conv
    this.conv = null
    this.moved = undefined
    if (c && client) void client.fetch(`/engine/assist/conversations/${encodeURIComponent(c.id)}`, { method: 'DELETE' }).catch(() => {})
    this.dispatch({ type: 'clear' }, true)
    this.save()
  }

  /** Sends `text` as the next turn and streams the answer; resolves when the turn has ended. */
  async send(text: string, ctx: SendContext): Promise<void> {
    if (this.ctl) return
    const ctl = new AbortController()
    this.ctl = ctl
    const history = this.chat.messages
    const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    this.dispatch({ type: 'send', id, text, at: Date.now(), provider: ctx.provider.name }, true)
    let ended = false
    try {
      const r = await this.post(text, history, ctx, ctl.signal)
      for await (const ev of ndjson<TurnEvent>(r.body!)) {
        this.dispatch({ type: 'event', ev })
        if (ev.type === 'done' || ev.type === 'error') ended = true
        if (ev.type === 'error' && ev.code === 'session_closed') this.conv = null
        if (ev.type === 'error' && ev.code === 'auth') ctx.onAuthError?.(ctx.provider)
        if (ev.type === 'intent') {
          const outcome = ctx.onIntent?.({ kind: 'intent', id: ev.id, href: ev.href, target: ev.target })
          const answer = streaming(this.chat)
          if (outcome && answer) this.settle(answer.id, ev.id, outcome)
        }
      }
      if (!ended) this.dispatch({ type: 'end', how: ctl.signal.aborted ? 'stopped' : 'failed', message: 'the answer ended early' })
    } catch (e) {
      if (!ended) this.dispatch({ type: 'end', how: ctl.signal.aborted ? 'stopped' : 'failed', message: e instanceof Error ? e.message : String(e) })
    } finally {
      this.ctl = null
      this.emit()
      this.save()
    }
  }

  /** The turn's stream: the engine conversation is made (again) when needed, with the earlier chat as context. */
  private async post(text: string, history: Message[], ctx: SendContext, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0, busy = 0; ; attempt++) {
      const fresh = !this.conv || this.conv.session !== ctx.session || this.conv.fingerprint !== fingerprint(ctx)
      if (fresh) this.conv = await this.create(ctx, signal)
      const conv = this.conv!
      const body: Schemas['MessageRequest'] = { text: fresh && history.length ? withHistory(history, text) : text, view: ctx.view, notes: ctx.notes }
      const r = await ctx.client.fetch(`/engine/assist/conversations/${encodeURIComponent(conv.id)}/messages`, {
        method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal,
      })
      if (r.ok && r.body) return r
      const err = await httpError(r, 'send')
      // the conversation ended with its session (idle eviction, engine restart): a new one carries the chat so far
      if ((r.status === 404 || (r.status === 409 && /session/.test(err.message))) && attempt === 0) {
        this.conv = null
        continue
      }
      // the turn before is still winding down (Stop just pressed)
      if (r.status === 409 && busy++ < BUSY_RETRIES) {
        await sleep(BUSY_WAIT_MS)
        continue
      }
      throw err
    }
  }

  private async create(ctx: SendContext, signal: AbortSignal): Promise<EngineConv> {
    const req: Schemas['ConversationRequest'] = {
      session: ctx.session, provider: toEngineProvider(ctx.provider), consent: true, binds: ctx.binds, view: ctx.view, scope: ctx.scope, notes: ctx.notes,
    }
    const r = await ctx.client.fetch('/engine/assist/conversations', { method: 'POST', body: JSON.stringify(req), headers: { 'content-type': 'application/json' }, signal })
    if (!r.ok) throw await httpError(r, 'start the conversation')
    const info = (await r.json()) as Schemas['ConversationInfo']
    return { id: info.id, session: ctx.session, fingerprint: fingerprint(ctx) }
  }
}

const sessions = new Map<string, ChatSession>()

/** Drops the chat of a tab that closed: its running turn stops (the answer so far stays in `assist.json`). */
export function closeChat(key: string) {
  sessions.get(key)?.stop()
  sessions.delete(key)
}

/** The chat of tab `key` for trace `identity` (made on first use; a tab whose identity changes gets a new one). */
export function chatOf(key: string, identity: string): ChatSession {
  let s = sessions.get(key)
  if (!s || s.identity !== identity) {
    s?.stop()
    sessions.set(key, (s = new ChatSession(identity)))
    void s.load()
  }
  return s
}
