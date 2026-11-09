// The app log: stdout and `<log dir>/mtkprof.log` (rotated to mtkprof.old.log at 1 MiB), at Info.
// The CI smoke step waits on lines of it ("ready on 127.0.0.1", "session ready", "simulated crash").

import fs from 'node:fs'
import path from 'node:path'
import { logDir } from './paths'

type Level = 'INFO' | 'WARN' | 'ERROR'

const MAX = 1 << 20
/** a message is cut here, so one call cannot fill the log */
const MAX_MESSAGE = 8 << 10
let file: string | null = null
let size = 0

function open(): string | null {
  if (file) return file
  try {
    const dir = logDir()
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, 'mtkprof.log')
    size = fs.existsSync(file) ? fs.statSync(file).size : 0
  } catch {
    file = null
  }
  return file
}

/** One line: control characters (newlines, escape sequences) escaped, so a message cannot forge lines of its own. */
export function oneLine(m: string): string {
  const cut = m.length > MAX_MESSAGE ? `${m.slice(0, MAX_MESSAGE)}… (${m.length} chars)` : m
  return cut.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? ' ' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))
}

function write(level: Level, target: string, message: string) {
  const now = new Date()
  const line = `[${now.toISOString().slice(0, 10)}][${now.toTimeString().slice(0, 8)}][${target}][${level}] ${oneLine(message)}\n`
  try {
    process.stdout.write(line)
  } catch {
    // no stdout (a GUI launch on Windows)
  }
  const f = open()
  if (!f) return
  try {
    if (size + Buffer.byteLength(line) > MAX) {
      fs.renameSync(f, path.join(path.dirname(f), 'mtkprof.old.log'))
      size = 0
    }
    fs.appendFileSync(f, line)
    size += Buffer.byteLength(line)
  } catch {
    // a log that cannot be written must not take the app down
  }
}

export const log = {
  info: (m: string, target = 'mtkprof') => write('INFO', target, m),
  warn: (m: string, target = 'mtkprof') => write('WARN', target, m),
  error: (m: string, target = 'mtkprof') => write('ERROR', target, m),
}
