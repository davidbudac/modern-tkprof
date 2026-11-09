// Trace files handed to the app from outside: the command line (`mtkprof a.trc b.trc`,
// `mtkprof open`), a second launch (`second-instance` carries its argv and cwd), and on macOS the
// Finder / Dock / `open -a mtkprof` (`open-file`). Each request is one trace set (one tab).
// Requests wait in a queue until the UI takes them (`take_open_requests`) once its engine is
// ready; `app://open` tells it that one arrived.

import path from 'node:path'

type PlatformPath = typeof path.posix

export const EVENT = 'app://open'

/**
 * The paths among `args` (argv without the program, and in a dev run without the main script),
 * made absolute against `cwd`. Flags (`-psn_…` of old macOS launches, Chromium switches, anything
 * with a leading dash) are skipped.
 */
export function pathsOfArgs(args: readonly string[], cwd: string, p: PlatformPath = path): string[] {
  return args.filter((a) => a && !a.startsWith('-')).map((a) => (p.isAbsolute(a) ? a : p.join(cwd, a)))
}

export class OpenQueue {
  private queue: string[][] = []

  /** Queues one trace set; false when it was empty. */
  push(paths: string[]): boolean {
    if (!paths.length) return false
    this.queue.push(paths)
    return true
  }

  /** The trace sets asked for since the last call (the UI opens each as a tab). */
  take(): string[][] {
    const q = this.queue
    this.queue = []
    return q
  }
}
