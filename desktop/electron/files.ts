// The page's file access, scoped as the Tauri capability was: it reads the files picked in an open
// dialog this run, the team connections file (`allow_team_file`) and anything under the app's
// data and cache dirs; it writes only files picked in a save dialog this run and files of a
// folder of the cache dir (reports, cuts); it opens with the system's app only reports.
// Writes are streamed: begin, chunks, end.

import { shell } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { cacheDir, dataDir, inside, isUnder } from './paths'

const readable = new Set<string>()
const writable = new Set<string>()

const norm = (p: string) => path.resolve(p)

export function allowRead(p: string) {
  readable.add(norm(p))
}

export function allowWrite(p: string) {
  writable.add(norm(p))
}

async function canRead(p: string): Promise<boolean> {
  const real = await fsp.realpath(p).catch(() => p)
  return [p, real].some((q) => readable.has(q) || isUnder(q, dataDir()) || isUnder(q, cacheDir()))
}

export async function readText(p: unknown): Promise<string> {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`not an absolute path: ${p}`)
  const abs = norm(p)
  if (!(await canRead(abs))) throw new Error(`not allowed to read ${abs}: pick it in a dialog first`)
  return fsp.readFile(abs, 'utf8')
}

/**
 * Allows the page to read the team connections file at `p`: a `.json` file only, the path as given
 * and with its symbolic links resolved.
 */
export async function allowTeamFile(p: unknown): Promise<void> {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.extname(p).toLowerCase() !== '.json') {
    throw new Error(`team file must be an absolute path to a .json file: ${p}`)
  }
  allowRead(p)
  const real = await fsp.realpath(p).catch(() => null)
  if (real) allowRead(real)
}

/** A folder of the cache dir, by name (`reports`, `cuts`). */
function cacheFolder(dir: unknown): string {
  const f = typeof dir === 'string' && /^[\w-]+$/.test(dir) ? inside(cacheDir(), dir) : null
  if (!f) throw new Error(`not a cache folder: ${dir}`)
  return f
}

function cacheFile(dir: unknown, name: unknown): string {
  const f = typeof name === 'string' ? inside(cacheFolder(dir), name) : null
  if (!f) throw new Error(`not a file name: ${name}`)
  return f
}

export const cacheFolderPath = (dir: unknown) => cacheFolder(dir)

export async function cacheExists(dir: unknown, name: unknown): Promise<boolean> {
  return fsp.access(cacheFile(dir, name)).then(() => true, () => false)
}

/** The files of a cache folder with their modification times; empty when it does not exist. */
export async function cacheList(dir: unknown): Promise<{ name: string; mtime: number | null }[]> {
  const folder = cacheFolder(dir)
  const entries = await fsp.readdir(folder, { withFileTypes: true }).catch(() => [])
  const out: { name: string; mtime: number | null }[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const st = await fsp.stat(path.join(folder, e.name)).catch(() => null)
    out.push({ name: e.name, mtime: st ? st.mtimeMs : null })
  }
  return out
}

export async function cacheRemove(dir: unknown, name: unknown): Promise<void> {
  await fsp.rm(cacheFile(dir, name), { force: true })
}

/** Opens a report written to the cache dir with the system's default app. */
export async function openReport(p: unknown): Promise<void> {
  if (typeof p !== 'string' || !isUnder(norm(p), path.join(cacheDir(), 'reports'))) throw new Error(`not a report: ${p}`)
  const err = await shell.openPath(norm(p))
  if (err) throw new Error(err)
}

// ---- streamed writes ----

interface Writing {
  stream: fs.WriteStream
  /** the file written to; `final` when written in place */
  temp: string
  final: string
}

const writes = new Map<number, Writing>()
let nextId = 1

export type WriteTarget = { path: string } | { cache: { dir: string; name: string } }

/**
 * Starts a write: to a file picked in a save dialog (in place, as the dialog asked), or to a file
 * of a cache folder (to `<name>.part`, renamed into place by `writeEnd`, so a write that fails
 * leaves no truncated file under the name and does not touch a file that had it). The id and the path.
 */
export async function writeBegin(t: WriteTarget): Promise<{ id: number; path: string }> {
  let final: string
  let temp: string
  if ('path' in t && typeof t.path === 'string') {
    final = norm(t.path)
    if (!writable.has(final)) throw new Error(`not allowed to write ${final}: pick it in a save dialog first`)
    temp = final
  } else if ('cache' in t && t.cache) {
    final = cacheFile(t.cache.dir, t.cache.name)
    temp = `${final}.part`
    await fsp.mkdir(path.dirname(final), { recursive: true })
  } else {
    throw new Error('write: no target')
  }
  const stream = fs.createWriteStream(temp)
  await new Promise<void>((resolve, reject) => {
    stream.once('open', () => resolve())
    stream.once('error', reject)
  })
  const id = nextId++
  writes.set(id, { stream, temp, final })
  return { id, path: final }
}

function writing(id: unknown): Writing {
  const w = typeof id === 'number' ? writes.get(id) : undefined
  if (!w) throw new Error(`no write ${id}`)
  return w
}

export async function writeChunk(id: unknown, chunk: unknown): Promise<void> {
  const w = writing(id)
  const data = typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? chunk : null
  if (data === null) throw new Error('write: not text or bytes')
  await new Promise<void>((resolve, reject) => w.stream.write(data, (e) => (e ? reject(e) : resolve())))
}

/** Finishes a write: `ok` keeps it (a cache file is renamed into place), else the partial file goes. */
export async function writeEnd(id: unknown, ok: unknown): Promise<void> {
  const w = writing(id)
  writes.delete(id as number)
  await new Promise<void>((resolve) => w.stream.end(() => resolve()))
  if (ok === true) {
    if (w.temp !== w.final) await fsp.rename(w.temp, w.final)
    return
  }
  if (w.temp !== w.final) await fsp.rm(w.temp, { force: true })
}
