import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react'
import { assistKeyAnswer, assistKeyStoreAndAnswer, useEngine } from '../engine'
import { useConnectionsOptional } from '../connections/ConnectionsProvider'
import { remoteApi } from '../connections/api'
import { EXIT_MS, useExit } from '@lib/components/motion'
import { inApp } from '../platform'
import { useSettings } from '../settings/settings'
import { answerOutcome, canSend, emptyQueue, isRetry, isYesNo, promptReducer, promptTitle, shows, type Answered, type QueuedPrompt } from './queue'
import './prompts.css'

/**
 * The engine's questions (ssh passwords, key passphrases, one-time codes, unknown host keys,
 * db passwords, assistant API keys) as a modal, one at a time in arrival order. Answers go to
 * `POST /engine/prompts/{id}` and nowhere else: never logged, never stored. In the app an API
 * key prompt goes to the shell first, which answers it with a key remembered in the OS keychain
 * (the modal shows only when there is none) and remembers a typed one when asked to, after the
 * engine accepted it.
 *
 * The modal stays until the answer is delivered: it shows "sending" meanwhile and, if delivery
 * fails, the error with Retry (the same answer, held in a ref until the prompt is done) and Cancel.
 * Delivery means the engine's 2xx, or its 404 (the prompt is gone: answered elsewhere, timed out).
 */
type Body = { answer: string; remember?: boolean } | { cancel: true }

export function PromptHost() {
  const { events, client } = useEngine()
  const [queue, dispatch] = useReducer(promptReducer, emptyQueue)
  const [answered, setAnswered] = useState<Answered | null>(null)
  // apikey prompts the shell is looking up, and those of them closed meanwhile
  const lookups = useRef(new Set<string>())
  const closedDuring = useRef(new Set<string>())
  // the answer being delivered (or that failed), for Retry; held here and nowhere else, never logged or put in the queue state
  const pending = useRef<{ id: string; body: Body } | null>(null)
  const inFlight = useRef(new Set<string>())

  useEffect(() => {
    const keyLookup = (prompt: QueuedPrompt) => {
      if (lookups.current.has(prompt.id)) return
      lookups.current.add(prompt.id)
      void assistKeyAnswer(prompt.id, prompt.connection)
        .then(
          (r) => (r.status === 'missing' ? { ...prompt, keychain: r.keychain } : null),
          (e) => {
            console.warn('assistant key:', String(e))
            return prompt
          },
        )
        .then((ask) => {
          lookups.current.delete(prompt.id)
          const closed = closedDuring.current.delete(prompt.id)
          if (ask && !closed) dispatch({ type: 'event', prompt: ask })
        })
    }
    const offPrompt = events.on('prompt', (prompt) => {
      if (inApp && prompt.kind === 'apikey') {
        if (prompt.state === 'open') return keyLookup(prompt)
        if (lookups.current.has(prompt.id)) closedDuring.current.add(prompt.id)
      }
      dispatch({ type: 'event', prompt })
    })
    // the engine replays its open prompts on every connect of the stream
    const offStream = events.on('stream', ({ connected }) => connected && dispatch({ type: 'reset' }))
    return () => {
      offPrompt()
      offStream()
    }
  }, [events])

  // once the queue is empty the last prompt plays its exit; a new one shows at once
  const { shown, closing } = useExit(client ? queue.items[0] : null, EXIT_MS.quick)
  if (!shown || !client) return null
  const send = async (body: Body) => {
    if (closing || !canSend(shown) || inFlight.current.has(shown.id)) return
    const { id, connection, kind } = shown
    // a cancel that fails twice in a row is given up on: the user chose to leave, the engine will time the prompt out
    const prev = pending.current
    const secondCancel = 'cancel' in body && prev?.id === id && 'cancel' in prev.body
    inFlight.current.add(id)
    pending.current = { id, body }
    dispatch({ type: 'sending', id })
    const done = () => {
      // a cancel forgets the answer: asking again after it is not a retry
      setAnswered('answer' in body ? { connection, kind, at: Date.now() } : null)
      if (pending.current?.id === id) pending.current = null
      dispatch({ type: 'answered', id })
    }
    try {
      // in the app the shell answers the engine first and remembers a typed key only once the engine took it
      if ('answer' in body && inApp && kind === 'apikey') await assistKeyStoreAndAnswer(id, connection, body.answer, body.remember ?? false)
      else await remoteApi.answerPrompt(client, id, 'answer' in body ? { answer: body.answer } : body)
      done()
    } catch (e) {
      const o = answerOutcome(e)
      if (o.closed || secondCancel) done()
      else dispatch({ type: 'failed', id, error: o.error })
    } finally {
      inFlight.current.delete(id)
    }
  }
  const retry = () => {
    const p = pending.current
    if (p && p.id === shown.id) void send(p.body)
  }
  // the backdrop outlives a prompt replacing another; only the card is keyed by the prompt
  return (
    <div className={'prompt-backdrop' + (closing ? ' closing' : '')} role="presentation" inert={closing}>
      <PromptModal
        key={shown.id}
        prompt={shown}
        waiting={queue.items.length - 1}
        closing={closing}
        last={answered}
        onAnswer={(a, remember) => void send({ answer: a, remember })}
        onCancel={() => void send({ cancel: true })}
        onRetry={retry}
      />
    </div>
  )
}

interface ModalProps {
  prompt: QueuedPrompt
  waiting: number
  closing: boolean
  /** the previous answer, to tell a retry at mount */
  last: Answered | null
  /** `remember`: an API key goes to the keychain too */
  onAnswer: (a: string, remember?: boolean) => void
  onCancel: () => void
  /** send the failed answer again */
  onRetry: () => void
}

function PromptModal({ prompt, waiting, closing, last, onAnswer, onCancel, onRetry }: ModalProps) {
  const conns = useConnectionsOptional()
  const conn = conns?.entries.find((c) => c.id === prompt.connection)
  const apiKey = prompt.kind === 'apikey'
  const provider = useSettings().settings.assistProviders.find((p) => apiKey && p.id === prompt.connection)
  // no keychain: the shell keeps the key for this session instead
  const keychain = inApp && apiKey && prompt.keychain !== false
  const [remember, setRemember] = useState(true)
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const yesNo = isYesNo(prompt.kind)
  const [retry] = useState(() => isRetry(last, prompt, Date.now()))

  const sending = !!prompt.sending
  const failed = !sending && !!prompt.failure
  // while the card plays its exit, or an answer is on its way, it answers nothing (its Escape listener is still registered)
  const answer = (a: string) => !closing && !sending && onAnswer(a)
  const dismiss = () => !closing && !sending && onCancel()
  const cancel = useRef(dismiss)
  cancel.current = dismiss
  useEffect(() => {
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancel.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (closing || sending) return
    if (failed) return onRetry()
    // the field keeps its value: a failed delivery is retried with it (it is cleared when the card leaves)
    onAnswer(value, apiKey && (remember || !keychain))
  }
  useEffect(() => {
    if (closing) setValue('')
  }, [closing])
  const text = prompt.text.trim()
  return (
    <form
      className={'prompt-card' + (retry ? ' retry' : '') + (closing ? ' closing' : '')}
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-title"
      data-kind={prompt.kind}
      aria-busy={sending}
      onSubmit={submit}
      autoComplete="off"
    >
      <header>
        <h2 id="prompt-title">{promptTitle(prompt)}</h2>
        <span className="muted">{provider ? `assistant · ${provider.name}` : conn ? `${conn.name} · ${conn.host}` : prompt.connection || 'engine'}</span>
      </header>
      {prompt.kind === 'hostkey' ? (
        <>
          <p>
            The host key of <b>{conn?.host ?? hostOf(text)}</b> is not known yet. Compare the fingerprint with the one your
            administrator gave you before accepting; it is then added to <code>~/.ssh/known_hosts</code>.
          </p>
          {prompt.fingerprint && <pre className="prompt-fp">{prompt.fingerprint}</pre>}
          <details>
            <summary className="muted">What ssh said</summary>
            <pre className="prompt-text">{text}</pre>
          </details>
        </>
      ) : (
        <pre className="prompt-text">{text}</pre>
      )}
      {!yesNo && (
        <input
          ref={input}
          type={shows(prompt) ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={sending}
          readOnly={failed}
          aria-label={promptTitle(prompt)}
          autoComplete={prompt.kind === 'otp' ? 'one-time-code' : 'off'}
          spellCheck={false}
        />
      )}
      {retry && !failed && <p className="prompt-retry" role="alert">Not accepted. Try again.</p>}
      {sending && <p className="prompt-sending muted small" role="status">Sending…</p>}
      {failed && (
        <p className="prompt-failure" role="alert">
          Could not send the answer: {prompt.failure}
        </p>
      )}
      {(prompt.kind === 'password' || prompt.kind === 'passphrase') && (
        <p className="muted small">Kept only in the engine's memory for this connection until the app quits or you forget it. Never written to disk.</p>
      )}
      {apiKey &&
        (keychain ? (
          <label className="check small">
            <input type="checkbox" checked={remember} disabled={sending || failed} onChange={(e) => setRemember(e.target.checked)} />
            Remember in keychain
          </label>
        ) : inApp ? (
          <p className="muted small" role="note">No keychain is available on this system: the key is kept for this session only, until the app quits.</p>
        ) : (
          <p className="muted small">Kept only in the engine's memory until it stops. Never written to disk.</p>
        ))}
      <footer>
        {waiting > 0 && <span className="muted small">{waiting} more waiting</span>}
        <span className="spacer" />
        {failed ? (
          <>
            <button type="button" onClick={dismiss}>Cancel</button>
            <button type="button" className="primary" onClick={onRetry} autoFocus>Retry</button>
          </>
        ) : yesNo ? (
          <>
            <button type="button" disabled={sending} onClick={() => answer('no')}>{prompt.kind === 'hostkey' ? 'Reject' : 'No'}</button>
            <button type="button" className="primary" disabled={sending} onClick={() => answer('yes')} autoFocus>
              {prompt.kind === 'hostkey' ? 'Accept' : 'Yes'}
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={sending} onClick={dismiss}>Cancel</button>
            <button type="submit" className="primary" disabled={sending}>OK</button>
          </>
        )}
      </footer>
    </form>
  )
}

function hostOf(text: string): string {
  return /host '([^']+)'/.exec(text)?.[1] ?? 'the host'
}
