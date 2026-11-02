import { invoke } from '@tauri-apps/api/core'
import { inTauri, openKV } from '../platform'
import type { Connection } from './model'
import { FILE_NAME } from './model'

/**
 * Where connections live: the store `connections.json` (`openKV`: the store plugin in the app
 * data dir; localStorage in the dev browser mode). Files: the dialog plugin picks them and the fs
 * plugin reads and writes them (a picked path is in the fs scope for the run; the team file's
 * path is allowed by the `allow_team_file` command). Nothing here ever holds a secret.
 */

export interface ConnStatus {
  state: 'unknown' | 'ok' | 'error'
  /** ISO time of the last test */
  at?: string
  message?: string
  server?: string
  transport?: string
}

export interface Saved {
  connections: Connection[]
  teamPath: string | null
  status: Record<string, ConnStatus>
}

const STORE_FILE = 'connections.json'
const store = () => openKV(STORE_FILE)

export async function loadSaved(): Promise<Saved> {
  const s = await store()
  return {
    connections: (await s.get<Connection[]>('connections')) ?? [],
    teamPath: (await s.get<string | null>('teamPath')) ?? null,
    status: (await s.get<Record<string, ConnStatus>>('status')) ?? {},
  }
}

export const saveConnections = async (c: Connection[]) => (await store()).set('connections', c)
export const saveTeamPath = async (p: string | null) => (await store()).set('teamPath', p)
export const saveStatus = async (s: Record<string, ConnStatus>) => (await store()).set('status', s)

const allowed = new Set<string>()

/**
 * The team file's text. Dev mode (no Tauri) reads it through the Vite server (`/@fs/<path>`,
 * files under the project only).
 */
export async function readTeamFile(path: string): Promise<string> {
  if (!inTauri) {
    const r = await fetch('/@fs' + (path.startsWith('/') ? '' : '/') + path, { cache: 'no-store' })
    if (!r.ok) throw new Error(`cannot read ${path}: HTTP ${r.status}`)
    return r.text()
  }
  if (!allowed.has(path)) {
    await invoke('allow_team_file', { path })
    allowed.add(path)
  }
  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  return readTextFile(path)
}

const JSON_FILTER = [{ name: 'Connections', extensions: ['json'] }]

/** Picks a JSON file (team file, import); null when the dialog was cancelled. */
export async function pickJsonFile(title: string): Promise<string | null> {
  if (!inTauri) return window.prompt(`${title} (path of a .json file under the project, dev mode)`)
  const { open } = await import('@tauri-apps/plugin-dialog')
  const p = await open({ title, multiple: false, directory: false, filters: JSON_FILTER })
  return typeof p === 'string' ? p : null
}

/** Picks a directory (reference bundle); null when cancelled. */
export async function pickDirectory(title: string): Promise<string | null> {
  if (!inTauri) return window.prompt(`${title} (directory path on the engine's machine)`)
  const { open } = await import('@tauri-apps/plugin-dialog')
  const p = await open({ title, multiple: false, directory: true })
  return typeof p === 'string' ? p : null
}

/** Reads a picked file; dev mode reads it through the Vite server. */
export async function readPicked(path: string): Promise<string> {
  if (!inTauri) return readTeamFile(path)
  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  return readTextFile(path)
}

/** Asks where to save and writes `text`; answers the path, or null when cancelled. Dev mode downloads it. */
export async function saveFile(text: string): Promise<string | null> {
  if (!inTauri) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    a.download = FILE_NAME
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    return FILE_NAME
  }
  const { save } = await import('@tauri-apps/plugin-dialog')
  const p = await save({ title: 'Export connections', defaultPath: FILE_NAME, filters: JSON_FILTER })
  if (!p) return null
  const { writeTextFile } = await import('@tauri-apps/plugin-fs')
  await writeTextFile(p, text)
  return p
}
