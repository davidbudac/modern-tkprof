// The update check: the newest GitHub release of the repository, compared with the app's version.
// The app does not install updates itself yet (the Tauri updater's signed in-place install has no
// replacement so far): an available update opens its release page, where the installers are.

import { app, net } from 'electron'

export const RELEASES_URL = 'https://github.com/davidbudac/modern-tkprof/releases'
const LATEST = 'https://api.github.com/repos/davidbudac/modern-tkprof/releases/latest'

export interface Available {
  version: string
  currentVersion: string
  date?: string
}

/** `a` is a newer `X.Y.Z` than `b`. */
export function newer(a: string, b: string): boolean {
  const p = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [p(a), p(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

export async function checkForUpdate(): Promise<Available | null> {
  const r = await net.fetch(LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mtkprof-desktop' }, signal: AbortSignal.timeout(30_000) })
  if (!r.ok) throw new Error(`GET ${LATEST}: HTTP ${r.status}`)
  const rel = (await r.json()) as { tag_name?: string; published_at?: string; draft?: boolean; prerelease?: boolean }
  const current = app.getVersion()
  if (!rel.tag_name || rel.draft || rel.prerelease || !newer(rel.tag_name, current)) return null
  return { version: rel.tag_name.replace(/^v/, ''), currentVersion: current, date: rel.published_at }
}
