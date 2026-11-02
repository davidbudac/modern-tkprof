import type { PromptEvent } from '../engine'

/**
 * The open engine prompts, oldest first; the modal shows the head. `prompt` events with
 * `state: open` add (or update) one, `closed` removes it (answered elsewhere, cancelled, timed
 * out); answering removes it at once. The engine replays every open prompt when the event
 * stream (re)connects, so a reconnect starts from an empty queue.
 */
export interface PromptQueue {
  items: QueuedPrompt[]
}

/** A prompt as the modal shows it; an `apikey` one knows whether there is a keychain to remember the key in (Tauri). */
export type QueuedPrompt = PromptEvent & { keychain?: boolean }

export type PromptAction =
  | { type: 'event'; prompt: QueuedPrompt }
  | { type: 'answered'; id: string }
  | { type: 'reset' }

export const emptyQueue: PromptQueue = { items: [] }

export function promptReducer(q: PromptQueue, a: PromptAction): PromptQueue {
  switch (a.type) {
    case 'event': {
      const p = a.prompt
      const i = q.items.findIndex((x) => x.id === p.id)
      if (p.state === 'closed') return i < 0 ? q : { items: q.items.filter((x) => x.id !== p.id) }
      if (i < 0) return { items: [...q.items, p] }
      const items = q.items.slice()
      items[i] = p
      return { items }
    }
    case 'answered':
      return q.items.some((x) => x.id === a.id) ? { items: q.items.filter((x) => x.id !== a.id) } : q
    case 'reset':
      return q.items.length ? emptyQueue : q
  }
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
