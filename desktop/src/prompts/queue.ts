import type { PromptEvent } from '../engine'

/**
 * The open engine prompts, oldest first; the modal shows the head. `prompt` events with
 * `state: open` add (or update) one, `closed` removes it (answered elsewhere, cancelled, timed
 * out). The engine replays every open prompt when the event stream (re)connects, so a reconnect
 * starts from an empty queue.
 *
 * An answer in flight keeps its prompt in the queue, marked `sending`. The prompt leaves when the
 * engine accepts the answer or says it is gone (`answered`, or its `closed` event) and stays, with
 * the error as `failure`, when the answer could not be delivered: the modal then offers Retry and
 * Cancel. Only the state lives here, never the answer itself.
 */
export interface PromptQueue {
  items: QueuedPrompt[]
}

/** A prompt as the modal shows it; an `apikey` one knows whether there is a keychain to remember the key in (the app). */
export type QueuedPrompt = PromptEvent & {
  keychain?: boolean
  /** an answer is on its way: the modal's inputs and buttons are off */
  sending?: boolean
  /** why the last answer did not arrive (the engine or the shell said so); never the answer */
  failure?: string
}

export type PromptAction =
  | { type: 'event'; prompt: QueuedPrompt }
  | { type: 'sending'; id: string }
  | { type: 'failed'; id: string; error: string }
  | { type: 'answered'; id: string }
  | { type: 'reset' }

export const emptyQueue: PromptQueue = { items: [] }

const replaceAt = (q: PromptQueue, i: number, p: QueuedPrompt): PromptQueue => {
  const items = q.items.slice()
  items[i] = p
  return { items }
}

export function promptReducer(q: PromptQueue, a: PromptAction): PromptQueue {
  switch (a.type) {
    case 'event': {
      const p = a.prompt
      const i = q.items.findIndex((x) => x.id === p.id)
      if (p.state === 'closed') return i < 0 ? q : { items: q.items.filter((x) => x.id !== p.id) }
      if (i < 0) return { items: [...q.items, p] }
      // an update of the prompt keeps the state of the answer in flight
      const { sending, failure } = q.items[i]
      return replaceAt(q, i, { ...p, sending, failure })
    }
    case 'sending': {
      const i = q.items.findIndex((x) => x.id === a.id)
      // unknown, or already sending: nothing changes (a second submit is not another request)
      if (i < 0 || q.items[i].sending) return q
      return replaceAt(q, i, { ...q.items[i], sending: true, failure: undefined })
    }
    case 'failed': {
      const i = q.items.findIndex((x) => x.id === a.id)
      // only an answer in flight can fail: a late failure for a prompt that came back fresh after a reconnect is ignored
      if (i < 0 || !q.items[i].sending) return q
      return replaceAt(q, i, { ...q.items[i], sending: false, failure: a.error })
    }
    case 'answered':
      return q.items.some((x) => x.id === a.id) ? { items: q.items.filter((x) => x.id !== a.id) } : q
    case 'reset':
      return q.items.length ? emptyQueue : q
  }
}

/** Whether the prompt takes an answer now: not while one is on its way. */
export const canSend = (p: QueuedPrompt) => !p.sending

/**
 * What an error from delivering an answer means. The engine answers 404 (and the shell says the
 * key prompt is gone) for a prompt that was answered elsewhere or ended: nothing is left to
 * deliver. Any other error is shown with a retry. The message never contains the answer.
 */
export function answerOutcome(e: unknown): { closed: true } | { closed: false; error: string } {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  if ((e as { status?: number } | null)?.status === 404 || /prompt is gone/i.test(msg)) return { closed: true }
  return { closed: false, error: msg.trim() || 'The answer could not be delivered.' }
}

/** What the answer buttons send for each kind (hostkey and confirm are yes/no questions). */
export function isYesNo(kind: PromptEvent['kind']): boolean {
  return kind === 'hostkey' || kind === 'confirm'
}

/** Whether the typed answer is shown: never for passwords, passphrases and API keys; otp as the engine says. */
export function shows(p: PromptEvent): boolean {
  if (p.kind === 'password' || p.kind === 'passphrase' || p.kind === 'apikey') return false
  return p.echo
}

/** The last prompt the user answered (not cancelled): what `isRetry` compares the next one with. */
export interface Answered {
  connection: string
  kind: PromptEvent['kind']
  /** epoch ms */
  at: number
}

const RETRY_KINDS: PromptEvent['kind'][] = ['password', 'passphrase', 'otp', 'apikey']
const RETRY_WITHIN_MS = 60_000

/** A secret asked again for the same connection soon after it was answered: the engine did not accept it. */
export function isRetry(last: Answered | null, p: PromptEvent, now: number): boolean {
  if (!last || !RETRY_KINDS.includes(p.kind)) return false
  const age = now - last.at
  return last.connection === p.connection && last.kind === p.kind && age >= 0 && age <= RETRY_WITHIN_MS
}

/** The question without the host-key boilerplate that the fingerprint line already shows. */
export function promptTitle(p: PromptEvent): string {
  switch (p.kind) {
    case 'password':
      return 'Password'
    case 'passphrase':
      return 'Key passphrase'
    case 'otp':
      return 'One-time code'
    case 'hostkey':
      return 'Unknown host key'
    case 'confirm':
      return 'Confirm'
    case 'apikey':
      return 'API key'
  }
}
