import { describe, expect, it } from 'vitest'
import type { JobInfo } from '../engine'
import { emptyJobs, fraction, jobsReducer, toAutoOpen, type JobsAction } from './jobs'

const j = (id: string, over: Partial<JobInfo> = {}): JobInfo => ({
  id, kind: 'fetch', state: 'running', phase: 'fetch', done: 0, total: 100, unit: 'bytes', message: '', connection: 'lab', ...over,
})
const run = (a: JobsAction[]) => a.reduce(jobsReducer, emptyJobs)

describe('jobsReducer', () => {
  it('tracks panel kinds only, newest first', () => {
    const s = run([{ type: 'event', job: j('1') }, { type: 'event', job: j('2', { kind: 'open' }) }, { type: 'event', job: j('3', { kind: 'ref' }) }])
    expect(s.list.map((t) => t.job.id)).toEqual(['3', '1'])
  })
  it('updates progress and keeps the label and auto-open', () => {
    const s = run([
      { type: 'track', job: j('1'), label: 'fetch a.trc', autoOpen: true },
      { type: 'event', job: j('1', { done: 50 }) },
    ])
    expect(s.list[0]).toMatchObject({ label: 'fetch a.trc', autoOpen: true, job: { done: 50 } })
  })
  it('never goes back from a finished state (event before the POST answer)', () => {
    const s = run([
      { type: 'event', job: j('1', { state: 'done', done: 100, localPaths: ['/c/a.trc'] }) },
      { type: 'track', job: j('1'), label: 'x', autoOpen: true },
    ])
    expect(s.list[0].job.state).toBe('done')
    expect(toAutoOpen(s).map((t) => t.job.id)).toEqual(['1'])
  })
  it('auto-opens once', () => {
    const s = run([
      { type: 'track', job: j('1'), label: 'x', autoOpen: true },
      { type: 'event', job: j('1', { state: 'done', localPaths: ['/c/a.trc'] }) },
      { type: 'opened', id: '1' },
    ])
    expect(toAutoOpen(s)).toEqual([])
  })
  it('sync adds running jobs from GET /engine/jobs', () => {
    const s = run([{ type: 'sync', jobs: [j('1'), j('2', { kind: 'follow', total: 0 })] }])
    expect(s.list).toHaveLength(2)
  })
  it('lost fails running jobs only; clearFinished and dismiss', () => {
    let s = run([{ type: 'event', job: j('1') }, { type: 'event', job: j('2', { state: 'done' }) }, { type: 'lost' }])
    expect(s.list.map((t) => t.job.state)).toEqual(['done', 'failed'])
    s = jobsReducer(jobsReducer(s, { type: 'event', job: j('3') }), { type: 'clearFinished' })
    expect(s.list.map((t) => t.job.id)).toEqual(['3'])
    expect(jobsReducer(s, { type: 'dismiss', id: '3' }).list).toEqual([])
  })
})

describe('fraction', () => {
  it('is null when the total is unknown', () => {
    expect(fraction(j('1', { done: 5, total: 0 }))).toBeNull()
    expect(fraction(j('1', { done: 25 }))).toBe(0.25)
    expect(fraction(j('1', { state: 'done', total: 0 }))).toBe(1)
  })
})
