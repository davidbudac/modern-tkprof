import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { hashOf, isMac, useStore, useStoreApi, type State } from '@lib'
import type { ApiClient } from '@lib/data/client'
import { assistKeyForget, getJSON, send, useEngine, type Schemas } from '../engine'
import { inTauri } from '../platform'
import { useSettings } from '../settings/settings'
import { DeskMenu } from '../ui/DeskMenu'
import { briefNotes, briefScope, fmtTokens, noteOf } from '../workspace/session/brief'
import { navHistoryOf } from '../workspace/session/navHistory'
import { useWorkspace } from '../workspace/WorkspaceProvider'
import type { Tab } from '../workspace/workspace'
import { citedHashes, citedTargets, noteText, saveNote, targetLabel, targetName } from './answerNote'
import { answerText, chatOf, streaming, totalUsage, type AssistantMessage, type ChatSession, type ChatView, type IntentPart, type Message, type SendContext, type ToolPart, type TurnUsage } from './conversation'
import { applyIntent, intentHash, receiveIntent } from './intents'
import { chipOf, openChip, unresolvedText } from './links'
import { Markdown, type ChipRenderer } from './markdown'
import { KINDS, needsKey, type AssistProvider } from './providers'
import './chat.css'

type Backend = Schemas['BackendInfo']

const backendLists = new WeakMap<ApiClient, Promise<Backend[]>>()

/** The engine's provider kinds and CLIs, asked once per engine. */
function useBackends(client: ApiClient | null): Backend[] {
  const [list, setList] = useState<Backend[]>([])
  useEffect(() => {
    if (!client) return
    let p = backendLists.get(client)
    if (!p) {
      p = getJSON<Schemas['BackendList']>(client, '/engine/assist/backends').then((l) => l.backends)
      p.catch(() => backendLists.delete(client!))
      backendLists.set(client, p)
    }
    let live = true
    p.then((l) => live && setList(l), () => {})
    return () => { live = false }
  }, [client])
  return list
}

/** The providers to pick from: those of Settings, then each CLI found on the engine's PATH with its own login. */
function pickable(settings: AssistProvider[], backends: Backend[]): AssistProvider[] {
  const cli = backends
    .filter((b) => b.command && b.path && !b.error)
    .map((b): AssistProvider => ({ id: `cli.${b.kind}`, kind: b.kind, name: `${b.command} CLI${b.loggedIn === false ? ' (not logged in)' : ''}`, auth: 'login' }))
  return [...settings, ...cli]
}

/** Where a provider's turns go, in the consent banner's words. */
function destination(p: AssistProvider): string {
  if (p.kind === 'claude') return 'the claude CLI, which sends it to Anthropic with your claude login'
  if (p.kind === 'codex') return `the codex CLI, which sends it to OpenAI with ${p.auth === 'login' ? 'your codex login' : 'your API key'}`
  try {
    return new URL(p.baseUrl ?? '').host
  } catch {
    return p.baseUrl ?? p.name
  }
}

/** What the views show, in the engine's terms (the URL state's ids). */
function viewOf(s: State): Schemas['View'] {
  const p = s.doc ? new URLSearchParams(hashOf(s.doc, s).slice(1)) : new URLSearchParams()
  const v: Schemas['View'] = { view: s.view }
  if (p.get('sql')) v.sql_id = p.get('sql')!
  if (p.get('ev')) v.event = p.get('ev')!
  if (s.window) {
    v.from = Math.floor(s.window.startTim)
    v.to = Math.ceil(s.window.endTim)
  }
  if (s.files) v.files = [...s.files].sort((a, b) => a - b)
  if (s.contexts) v.contexts = [...s.contexts].sort((a, b) => a - b)
  if (s.view === 'lines') {
    v.file = s.linesView.file
    v.line = s.linesView.line
  }
  return v
}

const usageText = (u: TurnUsage) =>
  `${fmtTokens(u.inputTokens)} in${u.cachedInputTokens ? ` (${fmtTokens(u.cachedInputTokens)} cached)` : ''} · ${fmtTokens(u.outputTokens)} out`

const ERRORS: Record<string, string> = {
  no_key: 'No key was entered.',
  auth: 'The provider refused the key, so it was forgotten: send again to enter another one.',
  session_closed: 'The trace was closed in the engine: send again to start over (the chat so far goes with it).',
  too_many_steps: 'The assistant used too many tool calls for one answer.',
}

const SUGGESTIONS = ['Where does the time go in this trace?', 'Which statement is the slowest, and why?', 'Are there waits worth a closer look?']

/**
 * An `mtkprof:` link of an answer: a chip that opens its place in the views, or plain text when this trace has nothing there.
 * `onOpen` is what a click does instead (an intent also keeps Back and its Pivot setting).
 */
function LinkChip({ hash, label, onOpen }: { hash: string; label: ReactNode; onOpen?: () => void }) {
  const store = useStoreApi()
  const doc = useStore((s) => s.doc)
  const chip = useMemo(() => (doc ? chipOf(doc, hash) : null), [doc, hash])
  if (!chip || chip.unresolved.length > 0)
    return (
      <span className="chip unresolved" title={chip ? unresolvedText(chip.unresolved) : 'No trace loaded'}>
        {label}
        <span className="sr-only"> (not in this trace)</span>
      </span>
    )
  return (
    <button type="button" className="chip" data-kind={chip.kind} title={`Show in the views (${hash.slice(1)})`} onClick={onOpen ?? (() => openChip(store, hash))}>
      {label}
    </button>
  )
}

const chip: ChipRenderer = (hash, label, key) => <LinkChip key={key} hash={hash} label={label} />

function argsText(args: ToolPart['args']): string {
  if (typeof args === 'string') return args
  const entries = Object.entries(args ?? {})
  return entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
}

/** A tool call: its name and arguments, and, opened, exactly what the model was given. */
function ToolRow({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false)
  const r = part.result
  return (
    <details className="tool-row" data-error={r?.isError || undefined} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="tool-name">{part.name}</span>
        <span className="tool-args">{argsText(part.args)}</span>
        <span className="tool-meta">{r ? (r.isError ? 'error' : `${fmtTokens(r.estTokens)} tok`) : 'running…'}</span>
      </summary>
      {open && (
        <div className="tool-body">
          <span className="tool-label">Arguments</span>
          <pre>{typeof part.args === 'string' ? part.args : JSON.stringify(part.args, null, 2)}</pre>
          <span className="tool-label">{r ? 'Result, as the model got it' : 'No result yet'}</span>
          {r && <pre>{r.content}</pre>}
        </div>
      )}
    </details>
  )
}

/** What an intent shows, short: the view and the one thing it selects. */
function intentLabel(t: IntentPart['target']): string {
  if (t.sql_id) return `${t.view} · ${t.sql_id}${t.execNo ? ` #${t.execNo}` : ''}`
  if (t.event) return `${t.view} · ${t.event}`
  if (t.line) return `${t.view} · line ${t.line}`
  if (t.from !== undefined || t.to !== undefined) return `${t.view} · time window`
  if (t.contexts?.length) return `${t.view} · ${t.contexts.length} session${t.contexts.length === 1 ? '' : 's'}`
  if (t.pivot) return `pivot · ${t.pivot.by.join(' × ')}`
  return t.view
}

/**
 * A place the assistant asked to show: moved to already ("Moved by the assistant", with Back while it is the latest move and the
 * views still stand there), waiting for a click, or not in this trace.
 */
function IntentRow({ m, part, session, latest }: { m: AssistantMessage; part: IntentPart; session: ChatSession; latest: boolean }) {
  const store = useStoreApi()
  const nav = navHistoryOf(store)
  const here = useSyncExternalStore(nav.subscribe, () => nav.current)
  const hash = intentHash(part)
  const what = intentLabel(part.target)
  const o = part.outcome
  if (hash === null || o?.state === 'unresolved')
    return (
      <p className="intent-row">
        <span className="muted">Could not show</span> <span className="chip unresolved">{what}</span>
        <span className="muted">{o?.state === 'unresolved' && o.keys.length ? unresolvedText(o.keys) : 'Not a place the app can open'}</span>
      </p>
    )
  const moved = o?.state === 'applied'
  return (
    <p className="intent-row">
      <span className="muted">{moved ? 'Moved by the assistant' : 'Asked to show'}</span>
      <LinkChip hash={hash} label={what} onOpen={() => session.settleIntent(m.id, part.id, applyIntent(store, part))} />
      {!moved && <span className="muted">click to move the view</span>}
      {moved && latest && here === o.at && nav.canBack && <button className="quiet intent-back" onClick={() => nav.back()} aria-label="Back to the view before the assistant moved it">Back</button>}
    </p>
  )
}

/** Save as note: the answer becomes a note on the statement, execution or time window its links name (a menu when it names several). */
function SaveNote({ m }: { m: AssistantMessage }) {
  const store = useStoreApi()
  const doc = useStore((s) => s.doc)
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const targets = useMemo(() => (doc ? citedTargets(doc, citedHashes(m)) : []), [doc, m])
  if (!doc || !answerText(m).trim()) return null
  if (saved) return <span className="note-saved" role="status">{saved}</span>
  const save = (i: number) => {
    const t = targets[i]
    const r = saveNote(store, t, noteText(m))
    setSaved(`${r === 'present' ? 'Already a note on' : 'Saved as a note on'} ${targetName(doc, t)}`)
  }
  if (targets.length === 0)
    return <button className="quiet note-save" disabled title="This answer links to no statement, execution or time window to attach a note to">Save as note</button>
  if (targets.length === 1)
    return <button className="quiet note-save" onClick={() => save(0)} title={`Add the answer as a note on ${targetName(doc, targets[0])}`}>Save as note</button>
  return (
    <DeskMenu label="Save as note" title="The answer links to several places: pick the one to attach the note to" align="end" fixed open={open} onOpenChange={setOpen} className="note-save">
      {targets.map((t, i) => (
        <button key={t.key} onClick={() => save(i)}>{targetLabel(doc, t)}</button>
      ))}
    </DeskMenu>
  )
}

const Answer = memo(function Answer({ m, session, moved }: { m: AssistantMessage; session: ChatSession; /** the id of the intent of this answer that moved the views last */ moved?: string }) {
  const empty = m.parts.length === 0
  return (
    <article className="msg answer" aria-busy={m.state === 'streaming' || undefined}>
      {m.parts.map((p, i) =>
        p.kind === 'text' ? <Markdown key={i} text={p.text} chip={chip} /> : p.kind === 'tool' ? <ToolRow key={i} part={p} /> : <IntentRow key={i} m={m} part={p} session={session} latest={moved === p.id} />,
      )}
      {m.state === 'streaming' && (empty || m.waitingKey) && <p className="msg-wait">{m.waitingKey ? 'Waiting for the API key…' : 'Thinking…'}</p>}
      {m.state === 'stopped' && <p className="msg-note">Stopped.</p>}
      {m.error && <p className="msg-error" role="alert">{ERRORS[m.error.code] ?? m.error.message}</p>}
      {(m.usage || m.state !== 'streaming') && (
        <footer className="msg-usage">
          <span>{m.provider}</span>
          {m.usage && <span title={`${m.usage.requests} model request${m.usage.requests === 1 ? '' : 's'}`}>{usageText(m.usage)}</span>}
          {m.state !== 'streaming' && <SaveNote m={m} />}
        </footer>
      )}
    </article>
  )
})

function Messages({ messages, session, moved }: { messages: Message[]; session: ChatSession; moved: ChatView['moved'] }) {
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true) // the user is at the bottom: new text keeps it in view
  useEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  })
  return (
    <div
      ref={box}
      className="chat-log"
      role="log"
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {messages.map((m) =>
        m.role === 'user' ? (
          <article key={m.id} className="msg question">
            <p>{m.text}</p>
          </article>
        ) : (
          <Answer key={m.id} m={m} session={session} moved={moved?.message === m.id ? moved.id : undefined} />
        ),
      )}
    </div>
  )
}

/** Asked once per trace and provider before the first message goes out: what leaves the machine. */
function Consent({ provider, title, binds, onAccept, onCancel }: { provider: AssistProvider; title: string; binds: 'mask' | 'keep'; onAccept: () => void; onCancel: () => void }) {
  const accept = useRef<HTMLButtonElement>(null)
  useEffect(() => accept.current?.focus(), [])
  return (
    <section className="chat-consent" role="alertdialog" aria-labelledby="chat-consent-h" aria-describedby="chat-consent-what">
      <h3 id="chat-consent-h">Send {title} to {provider.name}?</h3>
      <p>This goes to {destination(provider)}:</p>
      <ul id="chat-consent-what">
        <li>your messages, the notes on this trace and what the views show;</li>
        <li>what the assistant reads through mtkprof's analysis tools: file names, statements with their SQL text, plans, timings, waits, sessions and trace lines;</li>
        <li>bind values {binds === 'mask' ? 'masked: each one as its type, length and a hash' : 'as traced (Settings → Assistant: keep)'}.</li>
      </ul>
      <p className="chat-consent-warn">SQL text is never masked: literals in it, such as names, ids and amounts, are sent as written.</p>
      <p className="muted">Every tool result shows in the chat. Asked once for this trace and provider.</p>
      <div className="chat-consent-actions">
        <button className="quiet" onClick={onCancel}>Cancel</button>
        <button ref={accept} className="primary" onClick={onAccept}>Agree and send</button>
      </div>
    </section>
  )
}

/**
 * The assistant beside a tab's views: pick a provider, ask, read answers whose `mtkprof:` links open the views.
 * `focus`: the user just opened it (not a tab switch to a tab that has it open), so the message box takes the focus.
 */
export function ChatPanel({ tab, focus, onClose }: { tab: Tab; focus: boolean; onClose: () => void }) {
  const store = useStoreApi()
  const ws = useWorkspace()
  const { client } = useEngine()
  const { settings } = useSettings()
  const backends = useBackends(client)
  const providers = useMemo(() => pickable(settings.assistProviders, backends), [settings.assistProviders, backends])
  const session = chatOf(tab.key, tab.identity)
  const { chat, provider: picked, moved } = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const provider = providers.find((p) => p.id === picked) ?? providers[0]
  const experimental = provider && (backends.find((b) => b.kind === provider.kind)?.experimental ?? provider.kind === 'codex')
  const running = streaming(chat) !== null
  const [draft, setDraft] = useState('')
  const [asking, setAsking] = useState<string | null>(null) // a message waiting for the consent banner
  const input = useRef<HTMLTextAreaElement>(null)
  const ask = useRef(settings.assistAskBeforeMoving)
  ask.current = settings.assistAskBeforeMoving
  const focusAtMount = useRef(focus)
  useEffect(() => {
    if (focusAtMount.current) input.current?.focus()
  }, [])
  useEffect(() => setAsking(null), [provider?.id])

  const forgetKey = useCallback(
    (p: AssistProvider) => {
      if (!needsKey(p)) return
      if (client) void send(client, 'DELETE', `/engine/assist/providers/${encodeURIComponent(p.id)}/key`).catch((e) => console.warn('forget key:', String(e)))
      if (inTauri) void assistKeyForget(p.id).catch((e) => console.warn('forget key:', String(e)))
    },
    [client],
  )

  const go = (text: string) => {
    if (!client || !tab.sessionId || !provider) return
    const s = store.getState()
    const ctx: SendContext = {
      client, session: tab.sessionId, provider, binds: settings.assistBinds,
      view: viewOf(s), scope: briefScope(s), notes: briefNotes(s).map(noteOf), onAuthError: forgetKey,
      // an intent moves the views of the tab the question was asked in, while that tab still shows the trace the chat is about
      onIntent: (part) => {
        const t = ws.tab(tab.key)
        return t?.session?.store === store && t.identity === tab.identity ? receiveIntent(store, part, ask.current) : undefined
      },
    }
    setDraft('')
    void session.send(text, ctx)
  }
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || running || !provider) return
    if (!session.hasConsent(provider.id)) setAsking(text)
    else go(text)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }
  const total = totalUsage(chat)
  const ready = !!client && !!tab.sessionId && (tab.state === 'ready' || tab.state === 'live')

  return (
    <aside className="chat-panel" aria-label="Assistant">
      <header className="chat-head">
        <h2>Assistant</h2>
        {providers.length > 0 && (
          <select aria-label="Provider" value={provider?.id} onChange={(e) => session.pickProvider(e.target.value)} disabled={running}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.kind === 'codex' ? ' (experimental)' : ''}
              </option>
            ))}
          </select>
        )}
        {experimental && <span className="badge experimental">Experimental</span>}
        <span className="spacer" />
        {chat.messages.length > 0 && (
          <button className="quiet" onClick={() => session.clear(client)} disabled={running} title="Start a new chat about this trace">
            New chat
          </button>
        )}
        <button className="quiet chat-close" onClick={onClose} aria-label="Close the assistant" title={`Close (${isMac ? '⌘J' : 'Ctrl+J'})`}>
          ×
        </button>
      </header>

      {providers.length === 0 ? (
        <div className="chat-empty">
          <p>No provider to ask yet.</p>
          <p className="muted">Add an OpenAI-compatible endpoint in Settings → Assistant, or install the claude or codex CLI and log in. Settings → Assistant also shows how to use these tools from Claude Code in your terminal.</p>
          <button onClick={() => ws.go({ kind: 'page', id: 'settings' })}>Open Settings</button>
        </div>
      ) : chat.messages.length === 0 ? (
        <div className="chat-empty">
          <p>Ask about {tab.title}.</p>
          <p className="muted">
            Answers cite the trace: a chip opens what it names in the views. {KINDS[provider!.kind].http ? '' : `${provider!.name} runs with mtkprof's tools only. `}
            Nothing is sent before you agree.
          </p>
          <div className="chat-suggest">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="quiet" onClick={() => { setDraft(s); input.current?.focus() }}>{s}</button>
            ))}
          </div>
        </div>
      ) : (
        <Messages messages={chat.messages} session={session} moved={moved} />
      )}

      {asking !== null && provider && (
        <Consent
          provider={provider}
          title={tab.title}
          binds={settings.assistBinds}
          onCancel={() => { setAsking(null); input.current?.focus() }}
          onAccept={() => {
            session.giveConsent(provider.id)
            const text = asking
            setAsking(null)
            go(text)
          }}
        />
      )}

      {providers.length > 0 && (
        <form className="chat-compose" onSubmit={submit}>
          <textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={ready ? 'Ask about this trace (Enter sends, Shift+Enter a new line)' : 'The trace is not open in the engine'}
            aria-label="Message to the assistant"
            disabled={!ready || asking !== null}
            rows={2}
          />
          <div className="chat-compose-row">
            <span className="chat-total" title="Tokens of every turn in this chat">
              {total.requests > 0 ? `This chat: ${usageText(total)}` : settings.assistBinds === 'mask' ? 'Bind values masked' : 'Bind values sent as traced'}
            </span>
            {running ? (
              <button type="button" onClick={() => session.stop()}>Stop</button>
            ) : (
              <button type="submit" className="primary" disabled={!ready || !draft.trim() || asking !== null}>Send</button>
            )}
          </div>
        </form>
      )}
    </aside>
  )
}
