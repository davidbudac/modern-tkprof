import { describe, expect, it } from 'vitest'
import type { PromptEvent } from '../engine'
import { answerOutcome, canSend, emptyQueue, isRetry, promptReducer, promptTitle, shows, type Answered, type PromptAction, type PromptQueue } from './queue'

const p = (id: string, over: Partial<PromptEvent> = {}): PromptEvent => ({
  id, connection: 'lab', kind: 'password', text: 'db@host password: ', echo: false, state: 'open', ...over,
})
const run = (actions: PromptAction[], q: PromptQueue = emptyQueue) => actions.reduce(promptReducer, q)
const ids = (q: PromptQueue) => q.items.map((x) => x.id)

describe('promptReducer', () => {
  it('queues in arrival order and shows the oldest first', () => {
    expect(ids(run([{ type: 'event', prompt: p('a') }, { type: 'event', prompt: p('b') }]))).toEqual(['a', 'b'])
  })
  it('updates a repeated open event in place', () => {
    const q = run([
      { type: 'event', prompt: p('a') },
      { type: 'event', prompt: p('b') },
      { type: 'event', prompt: p('a', { text: 'again' }) },
    ])
    expect(ids(q)).toEqual(['a', 'b'])
    expect(q.items[0].text).toBe('again')
  })
  it('removes on closed and on answered', () => {
    const q = run([
      { type: 'event', prompt: p('a') },
      { type: 'event', prompt: p('b') },
      { type: 'event', prompt: p('c') },
      { type: 'event', prompt: p('a', { state: 'closed' }) },
      { type: 'answered', id: 'c' },
    ])
    expect(ids(q)).toEqual(['b'])
  })
  it('ignores closed and answered for unknown ids without a new state', () => {
    const q = run([{ type: 'event', prompt: p('a') }])
    expect(promptReducer(q, { type: 'event', prompt: p('zz', { state: 'closed' }) })).toBe(q)
    expect(promptReducer(q, { type: 'answered', id: 'zz' })).toBe(q)
  })
  it('a closed event before the open one never shows the prompt', () => {
    expect(ids(run([{ type: 'event', prompt: p('a', { state: 'closed' }) }]))).toEqual([])
  })
  it('reset (stream reconnect) empties the queue; the replay fills it again', () => {
    const q = run([{ type: 'event', prompt: p('a') }, { type: 'event', prompt: p('b') }, { type: 'reset' }])
    expect(ids(q)).toEqual([])
    expect(ids(run([{ type: 'event', prompt: p('b') }], q))).toEqual(['b'])
    expect(promptReducer(emptyQueue, { type: 'reset' })).toBe(emptyQueue)
  })
})

describe('answers in flight (F08)', () => {
  const sendingQueue = () => run([{ type: 'event', prompt: p('a') }, { type: 'event', prompt: p('b') }, { type: 'sending', id: 'a' }])

  it('sending keeps the prompt in the queue, marked', () => {
    const q = sendingQueue()
    expect(ids(q)).toEqual(['a', 'b'])
    expect(q.items[0].sending).toBe(true)
    expect(q.items[1].sending).toBeUndefined()
  })
  it('a second submit while sending changes nothing (double-submit guard)', () => {
    const q = sendingQueue()
    expect(canSend(q.items[0])).toBe(false)
    expect(canSend(q.items[1])).toBe(true)
    expect(promptReducer(q, { type: 'sending', id: 'a' })).toBe(q)
    expect(promptReducer(q, { type: 'sending', id: 'zz' })).toBe(q)
  })
  it('failed leaves the prompt with the error, ready to send again', () => {
    const q = run([{ type: 'failed', id: 'a', error: 'HTTP 500' }], sendingQueue())
    expect(ids(q)).toEqual(['a', 'b'])
    expect(q.items[0]).toMatchObject({ sending: false, failure: 'HTTP 500' })
    expect(canSend(q.items[0])).toBe(true)
    // retry: sending again clears the error
    const again = promptReducer(q, { type: 'sending', id: 'a' })
    expect(again.items[0]).toMatchObject({ sending: true, failure: undefined })
  })
  it('failed is ignored unless an answer is in flight', () => {
    const q = run([{ type: 'event', prompt: p('a') }])
    expect(promptReducer(q, { type: 'failed', id: 'a', error: 'x' })).toBe(q)
    expect(promptReducer(q, { type: 'failed', id: 'zz', error: 'x' })).toBe(q)
  })
  it('answered removes a prompt that was sending, exactly once', () => {
    const q = run([{ type: 'answered', id: 'a' }], sendingQueue())
    expect(ids(q)).toEqual(['b'])
    expect(promptReducer(q, { type: 'answered', id: 'a' })).toBe(q)
  })
  it('a closed event removes a prompt that was sending or had failed', () => {
    expect(ids(run([{ type: 'event', prompt: p('a', { state: 'closed' }) }], sendingQueue()))).toEqual(['b'])
    const failed = run([{ type: 'failed', id: 'a', error: 'x' }], sendingQueue())
    expect(ids(run([{ type: 'event', prompt: p('a', { state: 'closed' }) }], failed))).toEqual(['b'])
  })
  it('an update of the prompt keeps its sending and failure state', () => {
    const q = run([{ type: 'event', prompt: p('a', { text: 'newer' }) }], sendingQueue())
    expect(q.items[0]).toMatchObject({ text: 'newer', sending: true })
    const failed = run([{ type: 'failed', id: 'a', error: 'x' }, { type: 'event', prompt: p('a', { text: 'newest' }) }], sendingQueue())
    expect(failed.items[0]).toMatchObject({ text: 'newest', sending: false, failure: 'x' })
  })
  it('a reconnect resets a sending prompt; a late failure for it is ignored and the replay starts fresh', () => {
    const q = run([{ type: 'reset' }], sendingQueue())
    expect(ids(q)).toEqual([])
    const replay = run([{ type: 'event', prompt: p('a') }, { type: 'failed', id: 'a', error: 'late' }], q)
    expect(replay.items[0].sending).toBeUndefined()
    expect(replay.items[0].failure).toBeUndefined()
  })
  it('the sending and failed actions carry no answer', () => {
    const q = run([{ type: 'failed', id: 'a', error: 'HTTP 500' }], sendingQueue())
    expect(Object.keys(q.items[0])).not.toContain('answer')
  })
})

describe('answerOutcome', () => {
  it('treats a 404 from the engine as the prompt being closed', () => {
    expect(answerOutcome(Object.assign(new Error('not_found: no open prompt'), { status: 404 }))).toEqual({ closed: true })
  })
  it('treats the shell saying the prompt is gone as closed', () => {
    expect(answerOutcome('the key prompt is gone (its turn ended)')).toEqual({ closed: true })
  })
  it('keeps the message of any other failure', () => {
    expect(answerOutcome(Object.assign(new Error('internal: boom'), { status: 500 }))).toEqual({ closed: false, error: 'internal: boom' })
    expect(answerOutcome('answer the key prompt: HTTP 502')).toEqual({ closed: false, error: 'answer the key prompt: HTTP 502' })
    expect(answerOutcome(new TypeError('Failed to fetch'))).toEqual({ closed: false, error: 'Failed to fetch' })
  })
  it('has a message for an error without one', () => {
    expect(answerOutcome(undefined)).toEqual({ closed: false, error: 'The answer could not be delivered.' })
  })
})

describe('prompt display', () => {
  it('never echoes passwords and passphrases, echoes otp as told', () => {
    expect(shows(p('a', { echo: true }))).toBe(false)
    expect(shows(p('a', { kind: 'passphrase', echo: true }))).toBe(false)
    expect(shows(p('a', { kind: 'otp', echo: true }))).toBe(true)
    expect(shows(p('a', { kind: 'otp', echo: false }))).toBe(false)
    expect(shows(p('a', { kind: 'apikey', echo: true }))).toBe(false)
  })
  it('titles', () => {
    expect(promptTitle(p('a', { kind: 'hostkey' }))).toBe('Unknown host key')
    expect(promptTitle(p('a', { kind: 'apikey' }))).toBe('API key')
  })
})

describe('isRetry', () => {
  const at = 1_000_000
  const last: Answered = { connection: 'lab', kind: 'password', at }
  it('is a retry when the same secret is asked again for the same connection soon after the answer', () => {
    expect(isRetry(last, p('b'), at + 3_000)).toBe(true)
    expect(isRetry({ ...last, kind: 'passphrase' }, p('b', { kind: 'passphrase' }), at + 3_000)).toBe(true)
    expect(isRetry({ ...last, kind: 'otp' }, p('b', { kind: 'otp', echo: true }), at + 3_000)).toBe(true)
    expect(isRetry({ ...last, kind: 'apikey' }, p('b', { kind: 'apikey' }), at + 3_000)).toBe(true)
  })
  it('is not a retry without an earlier answer', () => {
    expect(isRetry(null, p('b'), at)).toBe(false)
  })
  it('is not a retry for another connection or another kind', () => {
    expect(isRetry(last, p('b', { connection: 'prod' }), at + 1_000)).toBe(false)
    expect(isRetry(last, p('b', { kind: 'passphrase' }), at + 1_000)).toBe(false)
    expect(isRetry(last, p('b', { kind: 'otp' }), at + 1_000)).toBe(false)
  })
  it('is never a retry for the yes/no questions', () => {
    expect(isRetry({ ...last, kind: 'hostkey' }, p('b', { kind: 'hostkey' }), at + 1_000)).toBe(false)
    expect(isRetry({ ...last, kind: 'confirm' }, p('b', { kind: 'confirm' }), at + 1_000)).toBe(false)
  })
  it('counts 60 s, not more', () => {
    expect(isRetry(last, p('b'), at + 60_000)).toBe(true)
    expect(isRetry(last, p('b'), at + 60_001)).toBe(false)
  })
  it('ignores an answer from the future (clock set back)', () => {
    expect(isRetry(last, p('b'), at - 1)).toBe(false)
  })
})
