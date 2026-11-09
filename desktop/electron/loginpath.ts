// The engine's PATH on macOS and Linux, resolved once: the login shell's, then the app's own, then
// the folders the CLI agents usually live in. An app started from the Finder (or a desktop entry)
// gets launchd's bare PATH, where `claude` or `codex` are not found.

import { spawn } from 'node:child_process'
import { log } from './log'

/** Where the CLI agents usually live, added when missing (`~` is $HOME). */
const AGENT_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin']
const SHELL_TIMEOUT = 3_000
const MARK = '_MTKPROF_PATH_'

let resolved: Promise<string> | null = null

export function enginePath(): Promise<string> {
  resolved ??= shellPath().then((shell) => {
    if (shell === null) log.warn("no PATH from the login shell; the engine gets the app's PATH and the usual dirs")
    return joinPath([shell ?? '', process.env.PATH ?? ''], process.env.HOME ?? '')
  })
  return resolved
}

/**
 * `$SHELL -l -i -c` printing PATH between markers (the rc files may print too), or null after
 * `SHELL_TIMEOUT`. Interactive as well as login: nvm, for one, sets the PATH of npm's global
 * installs in `.zshrc` / `.bashrc` only.
 */
function shellPath(): Promise<string | null> {
  const shell = process.env.SHELL
  if (!shell?.startsWith('/')) return Promise.resolve(null)
  return new Promise((resolve) => {
    let got = ''
    let done = false
    const child = spawn(shell, ['-l', '-i', '-c', `printf '${MARK}%s${MARK}' "$PATH"`], { stdio: ['ignore', 'pipe', 'ignore'] })
    const finish = (v: string | null) => {
      if (done) return
      done = true
      clearTimeout(t)
      child.kill()
      resolve(v)
    }
    const t = setTimeout(() => finish(null), SHELL_TIMEOUT)
    // stops at the second marker: a process the rc files started may hold the pipe open
    child.stdout.on('data', (b: Buffer) => {
      got += b.toString('utf8')
      const parts = got.split(MARK)
      if (parts.length >= 3) finish(parts[1] || null)
    })
    child.on('error', () => finish(null))
    child.on('close', () => finish(null))
  })
}

/** The entries of `parts` (PATH strings) in order without repeats, then the missing `AGENT_DIRS`. */
export function joinPath(parts: string[], home: string): string {
  const agents = AGENT_DIRS.flatMap((d) => (d.startsWith('~') ? (home ? [home + d.slice(1)] : []) : [d]))
  const out: string[] = []
  for (const dir of [...parts.flatMap((p) => p.split(':')), ...agents]) {
    if (dir && !out.includes(dir)) out.push(dir)
  }
  return out.join(':')
}
