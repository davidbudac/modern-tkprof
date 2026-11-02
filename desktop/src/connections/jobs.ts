import type { JobInfo } from '../engine'

/**
 * The jobs panel's list: the engine's fetch, follow and ref jobs (open jobs belong to the
 * workspace's progress panel), newest first, fed by the job's POST answer, `job` events and a
 * `GET /engine/jobs` after every (re)connect of the event stream.
 */
export const PANEL_KINDS: ReadonlySet<JobInfo['kind']> = new Set(['fetch', 'follow', 'ref'])

export interface TrackedJob {
  job: JobInfo
  /** what the user started ("fetch 2 files from lab") */
  label: string
  /** open the fetched files as a session when the job is done */
  autoOpen?: boolean
  /** the files were opened (by auto-open or the Open button) */
  opened?: boolean
}

export interface JobsState {
  list: TrackedJob[]
}

export type JobsAction =
  | { type: 'track'; job: JobInfo; label: string; autoOpen?: boolean }
  | { type: 'event'; job: JobInfo }
  | { type: 'sync'; jobs: JobInfo[] }
  | { type: 'opened'; id: string }
  | { type: 'dismiss'; id: string }
  | { type: 'clearFinished' }
  /** the engine restarted: its jobs are gone */
  | { type: 'lost' }

export const emptyJobs: JobsState = { list: [] }
export const MAX_JOBS = 50

export const finished = (j: JobInfo) => j.state !== 'running'

export function defaultLabel(j: JobInfo): string {
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p
  const files = j.localPaths?.map(base).join(', ')
  const conn = j.connection ? ` (${j.connection})` : ''
  switch (j.kind) {
    case 'fetch':
      return `fetch ${files || ''}${conn}`.replace('  ', ' ')
    case 'follow':
      return `follow ${files || ''}${conn}`.replace('  ', ' ')
    case 'ref':
      return `reference data${j.connection ? ` from ${j.connection}` : ''}`
    default:
      return j.kind
  }
}

function put(s: JobsState, job: JobInfo, extra?: Partial<TrackedJob>): JobsState {
  const i = s.list.findIndex((t) => t.job.id === job.id)
  if (i >= 0) {
    const list = s.list.slice()
    // events can overtake the POST answer: never go back from a finished state
    const keep = finished(list[i].job) && !finished(job) ? list[i].job : job
    list[i] = { ...list[i], ...extra, job: keep }
    return { list }
  }
  if (!PANEL_KINDS.has(job.kind)) return s
  const t: TrackedJob = { label: defaultLabel(job), ...extra, job }
  return { list: [t, ...s.list].slice(0, MAX_JOBS) }
}

export function jobsReducer(s: JobsState, a: JobsAction): JobsState {
  switch (a.type) {
    case 'track':
      return put(s, a.job, { label: a.label, autoOpen: a.autoOpen })
    case 'event':
      return put(s, a.job)
    case 'sync':
      return a.jobs.reduce((acc, j) => put(acc, j), s)
    case 'opened':
      return { list: s.list.map((t) => (t.job.id === a.id ? { ...t, opened: true } : t)) }
    case 'dismiss':
      return { list: s.list.filter((t) => t.job.id !== a.id) }
    case 'clearFinished':
      return { list: s.list.filter((t) => !finished(t.job)) }
    case 'lost':
      return {
        list: s.list.map((t) =>
          finished(t.job) ? t : { ...t, job: { ...t.job, state: 'failed', message: 'engine restarted; start it again' } },
        ),
      }
  }
}

/** Jobs that just finished as done and want their files opened. */
export function toAutoOpen(s: JobsState): TrackedJob[] {
  return s.list.filter((t) => t.autoOpen && !t.opened && t.job.state === 'done' && t.job.localPaths?.length)
}

/** 0..1, or null when the total is unknown. */
export function fraction(j: JobInfo): number | null {
  if (j.total > 0) return Math.min(1, j.done / j.total)
  if (j.state === 'done') return 1
  return null
}
