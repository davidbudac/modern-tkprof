/** Raw trace lines come from `mtkprof serve` (GET /api/lines); the standalone HTML has no server to ask. */

export const LINES_PAGE = 81 // ±40 around the target

/** One probe at load: does this origin answer /api/lines with plain text? (A dev server's SPA fallback answers text/html.) */
export async function probeLines(): Promise<boolean> {
  if (location.protocol === 'file:') return false
  try {
    const res = await fetch('/api/lines?from=1&n=1')
    return res.ok && (res.headers.get('content-type') ?? '').startsWith('text/plain')
  } catch { return false }
}

export interface LinePage { from: number; lines: string[]; total: number }

/** `side` picks the trace of a comparison served by `mtkprof serve a b -compare`; `file` the input file of a multi-file trace. */
export async function fetchLines(from: number, n: number, signal?: AbortSignal, side?: 'a' | 'b', file = 0): Promise<LinePage> {
  const res = await fetch(`/api/lines?from=${from}&n=${n}${side ? `&side=${side}` : ''}${file ? `&file=${file}` : ''}`, { signal })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const text = await res.text()
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split('\n').map((l) => l.replace(/\r$/, ''))
  return { from, lines, total: Number(res.headers.get('x-total-lines')) || 0 }
}
