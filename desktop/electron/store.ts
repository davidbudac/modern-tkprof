// The key-value stores of the UI (`settings.json`, `workspace.json`, `annotations.json`, …): one
// JSON object per file in the data dir, the format tauri-plugin-store wrote, so the files carry
// over. The page keeps its own copy and sends every change; a store is written 300 ms after its
// last change (written whole to `<name>.tmp`, then renamed), and every pending one on quit.

import fs from 'node:fs'
import path from 'node:path'
import { dataDir, inside } from './paths'
import { log } from './log'

const SAVE_DELAY = 300

interface Store {
  file: string
  data: Record<string, unknown>
  timer: NodeJS.Timeout | null
}

const stores = new Map<string, Store>()

/** Store names are plain `.json` file names. */
function fileOf(name: string): string {
  const f = /^[\w.-]+\.json$/.test(name) ? inside(dataDir(), name) : null
  if (!f) throw new Error(`not a store name: ${name}`)
  return f
}

function get(name: string): Store {
  let s = stores.get(name)
  if (s) return s
  const file = fileOf(name)
  let data: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`store ${name}: ${e}; starting empty`)
  }
  s = { file, data, timer: null }
  stores.set(name, s)
  return s
}

function save(s: Store) {
  if (s.timer) clearTimeout(s.timer)
  s.timer = null
  try {
    fs.mkdirSync(path.dirname(s.file), { recursive: true })
    const tmp = `${s.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(s.data, null, 2))
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
