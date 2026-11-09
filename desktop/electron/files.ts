// The page's file access, least privilege (the page shows trace text and assistant replies, so it is
// trusted less than this process): it reads the files picked in an open dialog this run and the
// team connections file; it writes a file picked in a save dialog (once per pick) and files of two
// cache folders, `reports` (text, JSON, HTML, zip) and `cuts` (.trc); it opens with the system's
// app only reports this run wrote. Writes are streamed: begin, chunks, end.

import { shell } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { cacheDir, dataDir, inside } from './paths'

const readable = new Set<string>()
const writable = new Set<string>()

const norm = (p: string) => path.resolve(p)

export function allowRead(p: string) {
  readable.add(norm(p))
}

export function allowWrite(p: string) {
  writable.add(norm(p))
}

const absolute = (p: unknown): p is string => typeof p === 'string' && p.length < 4096 && !p.includes('\0') && path.isAbsolute(p)

export async function readText(p: unknown): Promise<string> {
  if (!absolute(p)) throw new Error(`not an absolute path: ${p}`)
  const abs = norm(p)
  if (!readable.has(abs)) throw new Error(`not allowed to read ${abs}: pick it in a dialog first`)
  return fsp.readFile(abs, 'utf8')
}

// ---- the team connections file ----
// Its path is the main process's (`<data>/team-file.json`, which no store command reaches): the
// page may only name the file the user picked, in a dialog this run or before. The first run
// takes it over from the store `connections.json` (`teamPath`, where the Tauri shell kept it).

const teamRecord = () => path.join(dataDir(), 'team-file.json')
let team: string | null | undefined

function rememberedTeam(): string | null {
  if (team !== undefined) return team
  team = null
  try {
    const p = JSON.parse(fs.readFileSync(teamRecord(), 'utf8'))?.path
    if (absolute(p)) team = norm(p)
  } catch {
    // none yet
  }
  return team
}

function rememberTeam(p: string) {
  team = p
  try {
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.writeFileSync(teamRecord(), JSON.stringify({ path: p }))
  } catch {
    // granted for this run anyway
  }
}

/** First run of this shell: the team file the store names (set by the Tauri shell) becomes the remembered one. */
export function adoptTeamFile(teamPath: unknown) {
  if (fs.existsSync(teamRecord())) return
  if (absolute(teamPath) && path.extname(teamPath).toLowerCase() === '.json') rememberTeam(norm(teamPath))
  else rememberTeam('')
}

/**
 * Allows the page to read the team connections file at `p`: a `.json` file picked in a dialog
 * (this run, or the remembered one), the path as given and with its symbolic links resolved.
 */
export async function allowTeamFile(p: unknown): Promise<void> {
  if (!absolute(p) || path.extname(p).toLowerCase() !== '.json') {
    throw new Error(`team file must be an absolute path to a .json file: ${p}`)
  }
  const abs = norm(p)
  if (!readable.has(abs) && abs !== rememberedTeam()) throw new Error(`pick the team file in a dialog first: ${abs}`)
  if (abs !== rememberedTeam()) rememberTeam(abs)
  allowRead(abs)
  const real = await fsp.realpath(abs).catch(() => null)
  if (real) allowRead(real)
}

// ---- the cache folders ----

/** The cache folders the page may write, and the file types in each. */
const CACHE_FOLDERS: Record<string, string[]> = {
  reports: ['.txt', '.json', '.html', '.zip'],
  cuts: ['.trc'],
}

function cacheFolder(dir: unknown): string {
  const f = typeof dir === 'string' && Object.hasOwn(CACHE_FOLDERS, dir) ? inside(cacheDir(), dir) : null
  if (!f) throw new Error(`not a cache folder: ${dir}`)
  return f
}

/** A plain file name: no separators or reserved characters, no leading dot, no Windows device name. */
export function plainName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false
  if (/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) || /^[.\s]|[.\s]$/.test(name)) return false
  return !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)
}

function cacheFile(dir: unknown, name: unknown): string {
  const folder = cacheFolder(dir)
  const ok = plainName(name) && CACHE_FOLDERS[dir as string].some((ext) => name.toLowerCase().endsWith(ext))
  const f = ok ? inside(folder, name as string) : null
  if (!f) throw new Error(`not a ${dir} file name: ${name}`)
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
    if (!e.isFile() || e.name.startsWith('.')) continue
    const st = await fsp.stat(path.join(folder, e.name)).catch(() => null)
    out.push({ name: e.name, mtime: st ? st.mtimeMs : null })
  }
  return out
}

export async function cacheRemove(dir: unknown, name: unknown): Promise<void> {
  await fsp.rm(cacheFile(dir, name), { force: true })
}

/** the reports written this run: the only files `openReport` hands to the system */
const reports = new Set<string>()

/** Opens a report this run wrote to the cache dir with the system's default app. */
export async function openReport(p: unknown): Promise<void> {
  if (typeof p !== 'string' || !reports.has(norm(p))) throw new Error(`not a report of this run: ${p}`)
  const err = await shell.openPath(norm(p))
  if (err) throw new Error(err)
}

// ---- streamed writes ----

interface Writing {
  stream: fs.WriteStream
  /** the file written to; `final` when written in place */
  temp: string
  final: string
  report: boolean
}

const writes = new Map<number, Writing>()
let nextId = 1
const MAX_WRITES = 16
const MAX_CHUNK = 16 << 20

export type WriteTarget = { path: string } | { cache: { dir: string; name: string } }

/**
 * Starts a write: to a file picked in a save dialog (in place, as the dialog asked; the pick is
 * used up), or to a file of a cache folder (to a hidden temp file next to it, renamed into place
 * by `writeEnd`, so a write that fails leaves no truncated file under the name and does not touch
 * a file that had it). The id and the path.
 */
export async function writeBegin(t: WriteTarget): Promise<{ id: number; path: string }> {
  if (writes.size >= MAX_WRITES) throw new Error('write: too many writes open')
  let final: string
  let temp: string
  let report = false
  if (t && 'path' in t && typeof t.path === 'string') {
    final = norm(t.path)
    if (!writable.delete(final)) throw new Error(`not allowed to write ${final}: pick it in a save dialog first`)
    temp = final
  } else if (t && 'cache' in t && t.cache) {
    final = cacheFile(t.cache.dir, t.cache.name)
    report = t.cache.dir === 'reports'
    temp = path.join(path.dirname(final), `.${path.basename(final)}.${randomBytes(6).toString('hex')}.part`)
    await fsp.mkdir(path.dirname(final), { recursive: true })
  } else {
    throw new Error('write: no target')
  }
  const stream = fs.createWriteStream(temp, { flags: temp === final ? 'w' : 'wx' })
  await new Promise<void>((resolve, reject) => {
    stream.once('open', () => resolve())
    stream.once('error', reject)
  })
  const id = nextId++
  writes.set(id, { stream, temp, final, report })
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
  if (data.length > MAX_CHUNK) throw new Error('write: chunk too large')
  await new Promise<void>((resolve, reject) => w.stream.write(data, (e) => (e ? reject(e) : resolve())))
}

/** Finishes a write: `ok` keeps it (a cache file is renamed into place), else the partial file goes. */
export async function writeEnd(id: unknown, ok: unknown): Promise<void> {
  const w = writing(id)
  writes.delete(id as number)
  await new Promise<void>((resolve) => w.stream.end(() => resolve()))
  if (ok === true) {
    if (w.temp !== w.final) await fsp.rename(w.temp, w.final)
    if (w.report) reports.add(w.final)
    return
  }
  if (w.temp !== w.final) await fsp.rm(w.temp, { force: true })
}

/** The page went away (reload, crash): its open writes end, their partial cache files go. */
export function abortWrites() {
  for (const [id, w] of writes) {
    writes.delete(id)
    w.stream.destroy()
    if (w.temp !== w.final) void fsp.rm(w.temp, { force: true })
  }
}
