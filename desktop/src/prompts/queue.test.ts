import { describe, expect, it } from 'vitest'
import type { PromptEvent } from '../engine'
import { emptyQueue, isRetry, promptReducer, promptTitle, shows, type Answered, type PromptAction, type PromptQueue } from './queue'

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
