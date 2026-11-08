// Saving and opening a text file from a lib view (the names script of the Import names dialog, its saved output). A browser
// saves through a download and opens through a file input; the desktop registers its native dialogs (`setFileHost`).

export interface FileHost {
  /** Saves `text` as a file named `name` (the user may pick another place or name); false when cancelled. */
  save(name: string, text: string, title?: string): Promise<boolean>
  /** A text file the user picks (`exts` without the dot, e.g. `['txt', 'log']`); null when cancelled. */
  open(exts: string[], title?: string): Promise<{ name: string; text: string } | null>
}

export const browserFiles: FileHost = {
  async save(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return true
  },
  open(exts) {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = exts.map((e) => `.${e}`).join(',')
      input.onchange = () => {
        const f = input.files?.[0]
        if (!f) return resolve(null)
        void f.text().then((text) => resolve({ name: f.name, text }), () => resolve(null))
      }
      input.oncancel = () => resolve(null)
      input.click()
    })
  },
}

let host: FileHost = browserFiles

/** The desktop's save and open dialogs instead of the browser's download and file input. */
export function setFileHost(h: FileHost): void { host = h }

export const fileHost = (): FileHost => host
