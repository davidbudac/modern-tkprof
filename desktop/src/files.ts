import { inApp, openDialog, readTextFile, saveDialog } from './platform'
import { invoke } from './shell'

/**
 * Saving and reading user files (reports, exports, imports): the shell's save/open dialogs and its
 * scoped writes in the app (a path picked in a dialog may be read or written for this run), a
 * browser download and a file input in the dev browser mode.
 */
export interface FileFilter {
  name: string
  extensions: string[]
}

export type FileData = string | Uint8Array | ReadableStream<Uint8Array>

/** Asks where to save `name` (the downloads folder first) and writes `data` there, streamed; the path, or null when cancelled. */
export async function saveAs(name: string, data: FileData | (() => Promise<FileData>), filters?: FileFilter[], title?: string): Promise<string | null> {
  if (!inApp) {
    download(name, typeof data === 'function' ? await data() : data)
    return name
  }
  const path = await saveDialog({ defaultName: name, filters, title })
  if (!path) {
    if (typeof data !== 'function' && data instanceof ReadableStream) void data.cancel()
    return null
  }
  await writeTo({ path }, typeof data === 'function' ? await data() : data)
  return path
}

type WriteTarget = { path: string } | { cache: { dir: string; name: string } }

/** Bytes per IPC message of a streamed write. */
const CHUNK = 4 << 20

/** Streams `data` to the shell (`write_begin`, `write_chunk`…, `write_end`); a failed write keeps nothing of a cache file. The path. */
async function writeTo(target: WriteTarget, data: FileData): Promise<string> {
  const { id, path } = await invoke<{ id: number; path: string }>('write_begin', { target })
  const chunk = (c: string | Uint8Array) => invoke('write_chunk', { id, chunk: c })
  let ok = false
  try {
    if (typeof data === 'string') await chunk(data)
    else if (data instanceof Uint8Array) {
      for (let i = 0; i < data.length; i += CHUNK) await chunk(data.subarray(i, i + CHUNK))
    } else {
      const r = data.getReader()
      for (;;) {
        const { done, value } = await r.read()
        if (done) break
        if (value?.length) await chunk(value)
      }
    }
    ok = true
  } finally {
    await invoke('write_end', { id, ok })
  }
  return path
}

/**
 * Writes `data` to `<app cache dir>/<dir>/<name>` (the app only); its path. The data goes to `<name>.part` first and is
 * renamed into place once written whole, so a write that fails (a broken stream, a full disk) leaves no truncated file
 * under the name and does not touch a file that had it.
 */
/** Writes `text` to a file picked in a save dialog. */
export async function writeText(path: string, text: string): Promise<void> {
  await writeTo({ path }, text)
}

export function writeCached(dir: string, name: string, data: FileData): Promise<string> {
  return writeTo({ cache: { dir, name } }, data)
}

/** Writes `data` to `<app cache dir>/<dir>/<name>` and opens it with the system's default app (dev browser: a new tab). */
export async function openCached(dir: string, name: string, data: FileData, type: string): Promise<string> {
  if (!inApp) {
    const url = URL.createObjectURL(await blobOf(data, type))
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return url
  }
  const path = await writeCached(dir, name, data)
  await invoke('open_report', { path })
  return path
}

/** A text file the user picks (JSON imports); null when cancelled. */
export async function pickTextFile(filters: FileFilter[], title?: string): Promise<{ name: string; text: string } | null> {
  if (inApp) {
    const path = (await openDialog({ multiple: false, directory: false, filters, title }))?.[0]
    if (!path) return null
    return { name: path.split(/[\\/]/).pop() || path, text: await readTextFile(path) }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = filters.flatMap((f) => f.extensions.filter((e) => e !== '*').map((e) => `.${e}`)).join(',')
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return resolve(null)
      void f.text().then((text) => resolve({ name: f.name, text }), () => resolve(null))
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

async function blobOf(data: FileData, type: string): Promise<Blob> {
  if (data instanceof ReadableStream) return new Blob([await new Response(data).arrayBuffer()], { type })
  return new Blob([data as BlobPart], { type })
}

function download(name: string, data: FileData) {
  void blobOf(data, 'application/octet-stream').then((blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  })
}

/** `name.ext` with the characters Windows does not allow in file names replaced. */
export const safeFileName = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').trim() || 'mtkprof'
