// The key-value stores of the UI (`settings.json`, `workspace.json`, `annotations.json`, …): one
// JSON object per file in the data dir, the format tauri-plugin-store wrote, so the files carry
// over. The page keeps its own copy and sends every change; a store is written 300 ms after its
// last change (written whole to `<name>.tmp`, flushed to disk, then renamed), and every pending one
// on quit. A file that is not a JSON object is renamed to `<name>.corrupt-<time>` and the store
// starts empty; a file that cannot be read is left alone and not saved in that run.

import fs from 'node:fs'
import path from 'node:path'
import { dataDir, inside } from './paths'
import { log } from './log'

const SAVE_DELAY = 300

interface Store {
  file: string
  data: Record<string, unknown>
  timer: NodeJS.Timeout | null
  /** The file is there but could not be read: it is never written over (the changes of this run are not saved). */
  unread: boolean
}

const stores = new Map<string, Store>()

/**
 * The UI's stores, and nothing else of the data dir: not the remembered keys (`secrets.json`), the
 * team file record or Electron's own files. Exact names (a case variant is the same file on macOS
 * and Windows).
 */
const NAMES = new Set(['settings.json', 'workspace.json', 'annotations.json', 'connections.json', 'library.json', 'assist.json', 'investigation-backup.json'])
const MAX_VALUE = 32 << 20

function fileOf(name: string): string {
  const f = NAMES.has(name) ? inside(dataDir(), name) : null
  if (!f) throw new Error(`not a store name: ${name}`)
  return f
}

function read(name: string, file: string): { data: Record<string, unknown>; unread: boolean } {
  // no prototype: a key `__proto__` is a key like any other
  const data: Record<string, unknown> = Object.create(null)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { data, unread: false }
    log.error(`store ${name}: ${e}; not read, and not saved in this run`)
    return { data, unread: true }
  }
  let reason = ''
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { data: Object.assign(data, parsed), unread: false }
    reason = 'not an object'
  } catch (e) {
    reason = String(e)
  }
  // keep the user's bytes: the next save would replace them
  const aside = `${file}.corrupt-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`
  try {
    fs.renameSync(file, aside)
  } catch (e) {
    log.error(`store ${name}: not a JSON object (${reason}); could not be moved aside (${e}), and not saved in this run`)
    return { data, unread: true }
  }
  log.error(`store ${name}: not a JSON object (${reason}); kept as ${path.basename(aside)}, starting empty`)
  return { data, unread: false }
}

function get(name: string): Store {
  let s = stores.get(name)
  if (s) return s
  const file = fileOf(name)
  s = { file, ...read(name, file), timer: null }
  stores.set(name, s)
  return s
}

function save(s: Store) {
  if (s.timer) clearTimeout(s.timer)
  s.timer = null
  if (s.unread) return
  try {
    fs.mkdirSync(path.dirname(s.file), { recursive: true })
    const tmp = `${s.file}.tmp`
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, JSON.stringify(s.data, null, 2))
      fs.fsyncSync(fd) // on disk before it takes the store's name: a power loss leaves the old file or the new one, never a partial one
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, s.file)
  } catch (e) {
    log.error(`store ${path.basename(s.file)}: ${e}`)
  }
}

function later(s: Store) {
  if (s.timer) clearTimeout(s.timer)
  s.timer = setTimeout(() => save(s), SAVE_DELAY)
}

export const storeLoad = (name: string) => get(name).data

export function storeSet(name: string, key: string, value: unknown) {
  const s = get(name)
  if (value !== undefined && (JSON.stringify(value)?.length ?? 0) > MAX_VALUE) throw new Error(`store ${name}: value of ${key} too large`)
  if (value === undefined) delete s.data[key]
  else s.data[key] = value
  later(s)
}

export function storeDelete(name: string, key: string) {
  const s = get(name)
  delete s.data[key]
  later(s)
}

/** Writes the stores with pending changes now (quit). */
export function storeFlush() {
  for (const s of stores.values()) if (s.timer) save(s)
}
