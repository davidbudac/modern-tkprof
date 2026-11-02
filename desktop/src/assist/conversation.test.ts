import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@lib/data/client'

// an in-memory assist.json
const kv = new Map<string, unknown>()
vi.mock('../platform', () => ({
  openKV: async () => ({
    get: async (k: string) => kv.get(k),
    set: async (k: string, v: unknown) => void kv.set(k, JSON.parse(JSON.stringify(v))),
    delete: async (k: string) => void kv.delete(k),
    keys: async () => [...kv.keys()],
  }),
}))

const { ChatSession, MAX_TRACES, answerText, chatOf, chatReducer, closeChat, emptyChat, loadChat, parseStored, saveChat, totalUsage, withHistory } = await import('./conversation')
type Chat = import('./conversation').Chat
type TurnEvent = import('./conversation').TurnEvent
type AssistantMessage = import('./conversation').AssistantMessage
type SendContext = import('./conversation').SendContext

// A turn recorded from the engine (E3) with the scripted OpenAI fake on basic_binds.trc: three model requests, three tool
// calls (overview, statements, executions), then an answer with mtkprof: links, streamed in pieces.
const recorded = readFileSync(new URL('./testdata/basic_binds-turn.ndjson', import.meta.url), 'utf8')
const events = recorded.trim().split('\n').map((l) => JSON.parse(l) as TurnEvent)

const sent = (c: Chat = emptyChat) => chatReducer(c, { type: 'send', id: 'm1', text: 'Where does the time go?', at: 1, provider: 'Fake' })
const answer = (c: Chat) => c.messages[c.messages.length - 1] as AssistantMessage
const replay = (c: Chat, evs: TurnEvent[]) => evs.reduce((s, ev) => chatReducer(s, { type: 'event', ev }), c)

describe('chatReducer', () => {
  it('replays a recorded E3 stream', () => {
    const c = replay(sent(), events)
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const m = answer(c)
    expect(m.state).toBe('done')
    expect(m.parts.map((p) => (p.kind === 'tool' ? `tool:${p.name}` : p.kind))).toEqual(['tool:overview', 'tool:statements', 'tool:executions', 'text'])
    for (const p of m.parts) {
      if (p.kind !== 'tool') continue
      const result = events.find((e): e is Extract<TurnEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.id === p.id)!
      expect(p.result).toEqual({ isError: false, content: result.content, estTokens: result.estTokens }) // exactly what the model got
    }
    expect(m.parts[2]).toMatchObject({ kind: 'tool', args: { sql_id: 'f6jyzt7462kx2', limit: 3 } })
    const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')
    expect(answerText(m)).toBe(text)
    expect(text).toContain('[f6jyzt7462kx2](mtkprof:#view=statements&sql=f6jyzt7462kx2)')
    const done = events.find((e) => e.type === 'done') as Extract<TurnEvent, { type: 'done' }>
    expect(m.usage).toEqual(done.usage)
    expect(totalUsage(c)).toEqual(done.usage)
  })

  it('adds up the usage of each request until done gives the turn total', () => {
    const c = replay(sent(), events.filter((e) => e.type === 'usage'))
    expect(answer(c).usage).toEqual({ inputTokens: 4259 + 6594 + 7563, outputTokens: 8 + 12 + 190, cachedInputTokens: 0, requests: 3 })
    expect(answer(c).state).toBe('streaming')
  })

  it('ends a turn: cancelled is stopped, an error keeps its code, a broken stream fails', () => {
    const partial = replay(sent(), [{ type: 'text', text: 'Half an' }])
    const stopped = chatReducer(partial, { type: 'event', ev: { type: 'error', code: 'cancelled', message: 'cancelled' } })
    expect(answer(stopped)).toMatchObject({ state: 'stopped', parts: [{ kind: 'text', text: 'Half an' }] })
    expect(answer(stopped).error).toBeUndefined()
    const auth = chatReducer(partial, { type: 'event', ev: { type: 'error', code: 'auth', message: '401 from the provider' } })
    expect(answer(auth)).toMatchObject({ state: 'failed', error: { code: 'auth', message: '401 from the provider' } })
    expect(answer(chatReducer(partial, { type: 'end', how: 'stopped' }))).toMatchObject({ state: 'stopped', parts: [{ text: 'Half an' }] })
    expect(answer(chatReducer(partial, { type: 'end', how: 'failed', message: 'network' })).error).toEqual({ code: 'request', message: 'network' })
    // a finished answer takes no more events
    expect(chatReducer(stopped, { type: 'event', ev: { type: 'text', text: 'more' } })).toBe(stopped)
  })

  it('keeps the key wait, intents and a result without its call', () => {
    let c = replay(sent(), [{ type: 'state', state: 'waiting_key', provider: 'p1' }])
    expect(answer(c).waitingKey).toBe(true)
    c = replay(c, [
      { type: 'state', state: 'running' },
      { type: 'tool_result', id: 'mcp_1', name: 'overview', isError: true, content: 'error: no', estTokens: 2 },
      { type: 'intent', id: 'mcp_2', href: 'mtkprof:#view=statements&sql=abc', target: { view: 'statements', sql_id: 'abc' } },
      { type: 'text', text: 'a' },
      { type: 'tool_call', id: 'mcp_3', name: 'statements', args: '{bad json' },
      { type: 'text', text: 'b' },
    ])
    const m = answer(c)
    expect(m.waitingKey).toBe(false)
    expect(m.parts).toEqual([
      { kind: 'tool', id: 'mcp_1', name: 'overview', args: {}, result: { isError: true, content: 'error: no', estTokens: 2 } },
      { kind: 'intent', id: 'mcp_2', href: 'mtkprof:#view=statements&sql=abc', target: { view: 'statements', sql_id: 'abc' } },
      { kind: 'text', text: 'a' },
      { kind: 'tool', id: 'mcp_3', name: 'statements', args: '{bad json' },
      { kind: 'text', text: 'b' },
    ])
  })
})

describe('withHistory', () => {
  it('carries the earlier questions and answers into a new engine conversation', () => {
    const c = replay(sent(), events)
    const msg = withHistory(c.messages, 'And the second statement?')
    expect(msg).toMatch(/^Earlier in this chat/)
    expect(msg).toContain('DBA: Where does the time go?')
    expect(msg).toContain('Assistant: **f6jyzt7462kx2** takes most of the time')
    expect(msg.endsWith('The DBA now asks:\n\nAnd the second statement?')).toBe(true)
    expect(msg).not.toContain('"units"') // tool results are not repeated
    expect(withHistory([], 'hi')).toBe('hi')
  })
})

// ---- the engine side -----------------------------------------------------------------------------

type Call = { method: string; path: string; body: Record<string, unknown> }

/** An engine that answers the conversation routes: `reply` makes each message's answer. */
function engine(reply: (n: number, signal: AbortSignal) => Response) {
  const calls: Call[] = []
  let n = 0
  let conv = 0
  const client: ApiClient = {
    base: '',
    async fetch(path, init) {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      calls.push({ method: init?.method ?? 'GET', path, body })
      if (path === '/engine/assist/conversations') return Response.json({ id: `c${++conv}` }, { status: 201 })
      if (path.endsWith('/messages')) return reply(n++, init!.signal!)
      return new Response(null, { status: 204 })
    },
  }
  return { client, calls }
}

const lines = (evs: TurnEvent[]) => new Response(evs.map((e) => JSON.stringify(e)).join('\n') + '\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } })

const provider = { id: 'p1', kind: 'openai' as const, name: 'Fake', auth: 'bearer' as const, baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }
const ctxOf = (client: ApiClient, extra: Partial<SendContext> = {}): SendContext => ({
  client, session: 's1', provider, binds: 'mask', view: { view: 'overview' }, scope: { from: 0, to: 0, contexts: [] }, notes: [], ...extra,
})

describe('ChatSession', () => {
  beforeEach(() => kv.clear())

  it('starts the engine conversation with consent and streams a turn into the chat', async () => {
    const { client, calls } = engine(() => lines(events))
    const s = new ChatSession('trace-1')
    await s.send('Where does the time go?', ctxOf(client))
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /engine/assist/conversations', 'POST /engine/assist/conversations/c1/messages'])
    expect(calls[0].body).toMatchObject({ session: 's1', consent: true, binds: 'mask', provider: { id: 'p1', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1' } })
    expect(calls[1].body).toEqual({ text: 'Where does the time go?', view: { view: 'overview' }, notes: [] })
    expect(answer(s.getSnapshot().chat).state).toBe('done')
    // the next turn goes to the same conversation, without the history
    await s.send('More?', ctxOf(client))
    expect(calls.slice(2).map((c) => c.path)).toEqual(['/engine/assist/conversations/c1/messages'])
    expect(calls[2].body.text).toBe('More?')
    // stored under the trace identity
    await new Promise((r) => setTimeout(r, 0))
    expect((await loadChat('trace-1'))?.messages).toHaveLength(4)
  })

  it('stops a turn mid-stream and keeps the partial answer', async () => {
    const { client } = engine((_, signal) => {
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(enc.encode(JSON.stringify({ type: 'text', text: 'The first half' }) + '\n'))
          signal.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return new Response(body, { status: 200 })
    })
    const s = new ChatSession('trace-2')
    const turn = s.send('Long one', ctxOf(client))
    await new Promise((r) => setTimeout(r, 20))
    expect(s.running).toBe(true)
    s.stop()
    await turn
    expect(s.running).toBe(false)
    expect(answer(s.getSnapshot().chat)).toMatchObject({ state: 'stopped', parts: [{ kind: 'text', text: 'The first half' }] })
    expect(answer(s.getSnapshot().chat).error).toBeUndefined()
  })

  it('starts again with the chat so far when the engine conversation is gone', async () => {
    const { client, calls } = engine((n) => (n === 1 ? Response.json({ error: { code: 'not_found', message: 'no conversation' } }, { status: 404 }) : lines(events)))
    const s = new ChatSession('trace-3')
    await s.send('Where does the time go?', ctxOf(client))
    await s.send('And then?', ctxOf(client))
    expect(calls.map((c) => c.path)).toEqual([
      '/engine/assist/conversations', '/engine/assist/conversations/c1/messages',
      '/engine/assist/conversations/c1/messages', // 404: the session closed under it
      '/engine/assist/conversations', '/engine/assist/conversations/c2/messages',
    ])
    expect(String(calls[4].body.text)).toMatch(/^Earlier in this chat[\s\S]*DBA: Where does the time go\?[\s\S]*The DBA now asks:\n\nAnd then\?$/)
    expect(answer(s.getSnapshot().chat).state).toBe('done')
  })

  it('makes a new engine conversation for another provider or session', async () => {
    const { client, calls } = engine(() => lines(events))
    const s = new ChatSession('')
    await s.send('one', ctxOf(client))
    await s.send('two', ctxOf(client, { provider: { ...provider, baseUrl: 'http://127.0.0.1:10/v1' } }))
    await s.send('three', ctxOf(client, { session: 's2', provider: { ...provider, baseUrl: 'http://127.0.0.1:10/v1' } }))
    expect(calls.filter((c) => c.path === '/engine/assist/conversations')).toHaveLength(3)
    expect(kv.size).toBe(0) // a trace without an identity (a live one) is not stored
  })

  it('forgets a refused key and waits out a turn still winding down', async () => {
    const { client, calls } = engine((n) =>
      n === 0 ? lines([{ type: 'error', code: 'auth', message: 'refused' }])
        : n === 1 ? Response.json({ error: { code: 'conflict', message: 'a turn is running' } }, { status: 409 })
          : lines(events))
    const refused: string[] = []
    const s = new ChatSession('trace-4')
    await s.send('one', ctxOf(client, { onAuthError: (p) => refused.push(p.id) }))
    expect(refused).toEqual(['p1'])
    expect(answer(s.getSnapshot().chat).error?.code).toBe('auth')
    await s.send('two', ctxOf(client))
    expect(calls.filter((c) => c.path.endsWith('/messages'))).toHaveLength(3)
    expect(answer(s.getSnapshot().chat).state).toBe('done')
  })

  it('keeps consents and the provider per trace and loads them back', async () => {
    const a = new ChatSession('trace-5')
    expect(a.hasConsent('p1')).toBe(false)
    a.giveConsent('p1')
    const before = a.getSnapshot()
    a.pickProvider('p1')
    expect(a.getSnapshot()).not.toBe(before) // the panel re-renders with the pick
    expect(a.getSnapshot().provider).toBe('p1')
    await new Promise((r) => setTimeout(r, 0))
    const b = new ChatSession('trace-5')
    await b.load()
    expect(b.hasConsent('p1')).toBe(true)
    expect(b.hasConsent('p2')).toBe(false)
    expect(b.getSnapshot().provider).toBe('p1')
    const other = new ChatSession('trace-6')
    await other.load()
    expect(other.hasConsent('p1')).toBe(false)
  })
})

describe('intent outcomes', () => {
  const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, requests: 1 }
  const done: TurnEvent = { type: 'done', usage, total: usage }
  const intentEv = (id: string): TurnEvent => ({ type: 'intent', id, href: 'mtkprof:#view=statements&sql=abc', target: { view: 'statements', sql_id: 'abc' } })

  it('sets the outcome of one intent of one answer, whatever the other answers call theirs', () => {
    // a CLI agent's call ids restart each turn: two answers can hold an intent called mcp_1
    let c = replay(sent(), [intentEv('mcp_1'), done])
    c = chatReducer(c, { type: 'send', id: 'm2', text: 'again', at: 2, provider: 'Fake' })
    c = replay(c, [intentEv('mcp_1'), intentEv('mcp_2')])
    const [first, second] = c.messages.filter((m): m is AssistantMessage => m.role === 'assistant')
    c = chatReducer(c, { type: 'intent', message: second.id, id: 'mcp_1', outcome: { state: 'applied', at: '#view=statements&sql=abc' } })
    const after = c.messages.filter((m): m is AssistantMessage => m.role === 'assistant')
    expect(after[0]).toBe(first)
    expect(after[1].parts).toMatchObject([
      { kind: 'intent', id: 'mcp_1', outcome: { state: 'applied', at: '#view=statements&sql=abc' } },
      { kind: 'intent', id: 'mcp_2' },
    ])
    expect((after[1].parts[1] as { outcome?: unknown }).outcome).toBeUndefined()
  })

  it('asks the app about each intent as it streams in and keeps the outcome in the chat', async () => {
    const { client } = engine(() => lines([{ type: 'text', text: 'Here.' }, intentEv('mcp_1'), intentEv('mcp_2'), done]))
    const seen: string[] = []
    const s = new ChatSession('trace-intents')
    await s.send('show me', ctxOf(client, {
      onIntent: (p) => {
        seen.push(p.id + ' ' + p.href)
        return p.id === 'mcp_1' ? { state: 'applied', at: '#view=statements&sql=abc' } : undefined
      },
    }))
    expect(seen).toEqual(['mcp_1 mtkprof:#view=statements&sql=abc', 'mcp_2 mtkprof:#view=statements&sql=abc'])
    const parts = answer(s.getSnapshot().chat).parts
    expect(s.getSnapshot().moved).toEqual({ message: answer(s.getSnapshot().chat).id, id: 'mcp_1' })
    expect(parts[1]).toMatchObject({ kind: 'intent', id: 'mcp_1', outcome: { state: 'applied' } })
    expect((parts[2] as { outcome?: unknown }).outcome).toBeUndefined()
    // a click later settles the other one, and the chat is stored with it
    const m = answer(s.getSnapshot().chat)
    s.settleIntent(m.id, 'mcp_2', { state: 'unresolved', keys: ['sql'] })
    expect(s.getSnapshot().moved?.id).toBe('mcp_1') // only a move is the latest move
    s.settleIntent(m.id, 'mcp_2', { state: 'applied', at: '#view=statements&sql=abc' })
    expect(s.getSnapshot().moved?.id).toBe('mcp_2')
    s.settleIntent(m.id, 'mcp_2', { state: 'unresolved', keys: ['sql'] })
    expect((answer(s.getSnapshot().chat).parts[2] as { outcome?: unknown }).outcome).toEqual({ state: 'unresolved', keys: ['sql'] })
    await new Promise((r) => setTimeout(r, 0))
    const stored = (await loadChat('trace-intents'))!.messages.find((x) => x.role === 'assistant') as AssistantMessage
    expect(stored.parts.filter((p) => p.kind === 'intent').map((p) => (p as { outcome?: { state: string } }).outcome?.state)).toEqual(['applied', 'unresolved'])
  })
})

describe('closeChat', () => {
  it('drops the chat of a closed tab and stops its running turn', async () => {
    const a = chatOf('tab-1', 'trace-a')
    expect(chatOf('tab-1', 'trace-a')).toBe(a)
    const { client } = engine((_, signal) => {
      const body = new ReadableStream<Uint8Array>({ start: (ctl) => signal.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError'))) })
      return new Response(body, { status: 200 })
    })
    const turn = a.send('long', ctxOf(client))
    await new Promise((r) => setTimeout(r, 10))
    expect(a.running).toBe(true)
    closeChat('tab-1')
    await turn
    expect(a.running).toBe(false)
    expect(chatOf('tab-1', 'trace-a')).not.toBe(a)
    closeChat('tab-1')
    closeChat('never-opened')
  })
})

describe('assist.json', () => {
  beforeEach(() => kv.clear())

  it('shows an answer that was streaming when the app went away as stopped', () => {
    const c = replay(sent(), [{ type: 'text', text: 'partial' }])
    const s = parseStored({ v: 1, updated: 5, consent: { p1: 1 }, messages: c.messages })!
    expect(answer({ messages: s.messages })).toMatchObject({ state: 'stopped', parts: [{ text: 'partial' }] })
    expect(parseStored({ v: 2, messages: [] })).toBeNull()
    expect(parseStored('x')).toBeNull()
  })

  it('keeps the most recently changed traces only', async () => {
    for (let i = 0; i <= MAX_TRACES; i++) await saveChat(`t${i}`, { v: 1, updated: 1000 + i, consent: {}, messages: [] })
    expect(kv.size).toBe(MAX_TRACES)
    expect(kv.has('t0')).toBe(false)
    expect(kv.has(`t${MAX_TRACES}`)).toBe(true)
  })
})
