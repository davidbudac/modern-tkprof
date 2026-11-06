import { inTauri } from './platform'

/**
 * Saving and reading user files (reports, exports, imports): the save/open dialogs and the fs
 * plugin in the app (a path picked in a dialog is added to the fs scope for this run), a browser
 * download and a file input in the dev browser mode.
 */
export interface FileFilter {
  name: string
  extensions: string[]
}

export type FileData = string | Uint8Array | ReadableStream<Uint8Array>

/** Asks where to save `name` (the downloads folder first) and writes `data` there, streamed; the path, or null when cancelled. */
export async function saveAs(name: string, data: FileData | (() => Promise<FileData>), filters?: FileFilter[], title?: string): Promise<string | null> {
  if (!inTauri) {
    download(name, typeof data === 'function' ? await data() : data)
    return name
  }
  const { save } = await import('@tauri-apps/plugin-dialog')
  let defaultPath = name
  try {
    const { downloadDir, join } = await import('@tauri-apps/api/path')
    defaultPath = await join(await downloadDir(), name)
  } catch {
    // no downloads folder: the dialog's default
  }
  const path = await save({ defaultPath, filters, title })
  if (!path) {
    if (typeof data !== 'function' && data instanceof ReadableStream) void data.cancel()
    return null
  }
  await writeTo(path, typeof data === 'function' ? await data() : data)
  return path
}

async function writeTo(path: string, data: FileData) {
  const fs = await import('@tauri-apps/plugin-fs')
  if (typeof data === 'string') await fs.writeTextFile(path, data)
  else await fs.writeFile(path, data)
}

/** Writes `data` to `<app cache dir>/<dir>/<name>` (the app only); its path. */
export async function writeCached(dir: string, name: string, data: FileData): Promise<string> {
  const { appCacheDir, join } = await import('@tauri-apps/api/path')
  const { mkdir } = await import('@tauri-apps/plugin-fs')
  const folder = await join(await appCacheDir(), dir)
  await mkdir(folder, { recursive: true })
  const path = await join(folder, name)
  await writeTo(path, data)
  return path
}

/** Writes `data` to `<app cache dir>/<dir>/<name>` and opens it with the system's default app (dev browser: a new tab). */
export async function openCached(dir: string, name: string, data: FileData, type: string): Promise<string> {
  if (!inTauri) {
    const url = URL.createObjectURL(await blobOf(data, type))
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return url
  }
  const path = await writeCached(dir, name, data)
  const { openPath } = await import('@tauri-apps/plugin-opener')
  await openPath(path)
  return path
}

/** A text file the user picks (JSON imports); null when cancelled. */
export async function pickTextFile(filters: FileFilter[], title?: string): Promise<{ name: string; text: string } | null> {
  if (inTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const path = await open({ multiple: false, directory: false, filters, title })
    if (typeof path !== 'string') return null
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
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
