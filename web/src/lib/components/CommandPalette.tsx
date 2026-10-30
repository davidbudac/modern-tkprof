import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import '../styles/palette.css'

export interface Command {
  id: string
  label: string
  group: string
  /** the key(s) shown at the end, e.g. `]`, `Shift+F3`, `⌘K` */
  keys?: string
  hint?: string
  /** a toggle's state: shows a check mark */
  checked?: boolean
  disabled?: boolean
  run(): void
}

const RECENT_KEY = 'mtk.lines.palette.recent'
const RECENT_KEEP = 8
const MAX_ROWS = 200
const PAGE = 8

const BOUNDARY = /[\s\-_/.:,;()[\]{}<>|]/
const startsWord = (s: string, i: number) => i === 0 || BOUNDARY.test(s[i - 1])
const same = (a: string, b: string) => a.toLowerCase() === b

interface Hit { score: number; idx: number[] }

/** The best match of a query in a text: a contiguous run (a word start first) or else a subsequence; null when it does not match. */
function matchText(text: string, query: string): Hit | null {
  const q = query.trim().toLowerCase()
  if (!q) return { score: 0, idx: [] }
  const lower = text.toLowerCase()
  const len = Math.min(text.length, 200)
  // a contiguous run, the first one at a word start preferred
  if (lower.length === text.length) {
    let at = -1
    for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + 1)) {
      if (at < 0) at = i
      if (startsWord(text, i)) { at = i; break }
    }
    if (at >= 0) {
      const idx = Array.from({ length: q.length }, (_, k) => at + k)
      const score = at === 0 ? 1000 : startsWord(text, at) ? 800 : 600
      return { score: score - len * 0.5, idx }
    }
  }
  // a subsequence; spaces in the query do not need a match
  const chars = [...q.replace(/\s+/g, '')]
  const pick = (boundaryFirst: boolean): number[] | null => {
    const idx: number[] = []
    let pos = 0
    for (const c of chars) {
      let found = -1
      if (boundaryFirst) for (let i = pos; i < text.length; i++) if (same(text[i], c) && startsWord(text, i)) { found = i; break }
      if (found < 0) for (let i = pos; i < text.length; i++) if (same(text[i], c)) { found = i; break }
      if (found < 0) return null
      idx.push(found)
      pos = found + 1
    }
    return idx
  }
  const idx = pick(true) ?? pick(false)
  if (!idx) return null
  let score = 200
  for (let k = 0; k < idx.length; k++) {
    if (startsWord(text, idx[k])) score += 20
    if (k > 0 && idx[k] === idx[k - 1] + 1) score += 10
  }
  score -= idx[idx.length - 1] - idx[0]
  return { score: score - len * 0.5, idx }
}

/** The best hit of a command for a query: its label, or else the group and the label together (ranked lower). */
function hitOf(c: Command, query: string): Hit | null {
  const h = matchText(c.label, query)
  if (h) return h
  const both = matchText(`${c.group} ${c.label}`, query)
  return both ? { score: both.score * 0.5, idx: [] } : null
}

/** The character indexes of `label` that `query` matched, for highlighting (empty when the label alone does not match). */
export function matchIndexes(label: string, query: string): number[] {
  return matchText(label, query)?.idx ?? []
}

/**
 * Filter and rank commands by a query: a subsequence match on the label (or the group and the label);
 * a prefix or a word-start match ranks higher, a recently run command a little higher still.
 * An empty query returns everything, the recent ids first (most recent first).
 */
export function rankCommands(commands: Command[], query: string, recent: string[]): Command[] {
  if (!query.trim()) {
    const byId = new Map(commands.map((c) => [c.id, c]))
    const first: Command[] = []
    const seen = new Set<string>()
    for (const id of recent) {
      const c = byId.get(id)
      if (c && !seen.has(id)) { seen.add(id); first.push(c) }
    }
    return [...first, ...commands.filter((c) => !seen.has(c.id))]
  }
  const scored: { c: Command; s: number; i: number }[] = []
  commands.forEach((c, i) => {
    const h = hitOf(c, query)
    if (!h) return
    const r = recent.indexOf(c.id)
    scored.push({ c, s: h.score + (r >= 0 ? (RECENT_KEEP - r) * 2 : 0), i })
  })
  scored.sort((a, b) => b.s - a.s || a.i - b.i)
  return scored.map((x) => x.c)
}

export interface Section { head: string; items: Command[] }

/** The ranked list under group headings: the leading recent commands (empty query) under "Recent", the rest by group in order of first appearance. */
export function sectionsOf(list: Command[], recent: ReadonlySet<string> | null): Section[] {
  let n = 0
  if (recent) while (n < list.length && recent.has(list[n].id)) n++
  const out: Section[] = []
  if (n > 0) out.push({ head: 'Recent', items: list.slice(0, n) })
  const at = new Map<string, Section>()
  for (const c of list.slice(n)) {
    let s = at.get(c.group)
    if (!s) { s = { head: c.group, items: [] }; at.set(c.group, s); out.push(s) }
    s.items.push(c)
  }
  return out
}

/** The next enabled row from `from` in a direction; wraps around or stops at the ends (staying put when none is left). */
export function stepActive(list: Command[], from: number, dir: 1 | -1, wrap: boolean): number {
  const n = list.length
  for (let k = 1; k <= n; k++) {
    let i = from + dir * k
    if (wrap) i = ((i % n) + n) % n
    else if (i < 0 || i >= n) return from
    if (!list[i].disabled) return i
  }
  return from
}

function readRecent(key: string | null): string[] {
  if (key === null) return []
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_KEEP) : []
  } catch { return [] }
}

function writeRecent(key: string | null, ids: string[]): void {
  if (key === null) return
  try { localStorage.setItem(key, JSON.stringify(ids)) } catch { /* storage unavailable */ }
}

/** The label with the matched characters in `<mark>`. */
function Marked({ text, idx }: { text: string; idx: number[] }) {
  if (idx.length === 0) return <>{text}</>
  const on = new Set(idx)
  const parts: { s: string; m: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const m = on.has(i)
    const last = parts[parts.length - 1]
    if (last && last.m === m) last.s += text[i]; else parts.push({ s: text[i], m })
  }
  return <>{parts.map((p, i) => (p.m ? <mark key={i}>{p.s}</mark> : <Fragment key={i}>{p.s}</Fragment>))}</>
}

/**
 * A command palette, opened by its owner (Cmd/Ctrl+K): a dialog on `document.body` with a filter input over a grouped list of commands.
 * Up/Down (wrapping), PageUp/PageDown, Home/End move; Enter runs the active command and closes; Esc, a pointerdown outside and Cmd/Ctrl+K close;
 * Tab stays in the input. Hover selects, a click runs. Focus goes back to where it was before opening.
 * Running a command remembers its id (8 kept) under `recentKey`; the empty query lists those first.
 */
export function CommandPalette({ open, commands, onClose, placeholder, dynamic, recentKey = RECENT_KEY }: {
  open: boolean
  commands: Command[]
  onClose(): void
  placeholder?: string
  /** commands built from the typed text (e.g. "Go to line 1234"), listed first when non-empty */
  dynamic?(query: string): Command[]
  /** localStorage key for the recent command ids (default 'mtk.lines.palette.recent'); omit persistence with null */
  recentKey?: string | null
}) {
  if (!open) return null
  return <PaletteDialog commands={commands} onClose={onClose} placeholder={placeholder} dynamic={dynamic} recentKey={recentKey} />
}

function PaletteDialog({ commands, onClose, placeholder, dynamic, recentKey }: {
  commands: Command[]; onClose(): void; placeholder?: string; dynamic?(query: string): Command[]; recentKey: string | null
}) {
  const uid = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const viaMouse = useRef(false)
  const [query, setQuery] = useState('')
  const [pick, setPick] = useState<{ q: string; i: number }>({ q: '', i: -1 })
  const [recent, setRecent] = useState(() => readRecent(recentKey))

  const { list, sections, more } = useMemo(() => {
    const ranked = rankCommands(commands, query, recent)
    const dyn = query.trim() && dynamic ? dynamic(query) : []
    const all = [...dyn, ...ranked]
    const shown = all.slice(0, MAX_ROWS)
    return { list: shown, sections: sectionsOf(shown, query.trim() ? null : new Set(recent)), more: all.length - shown.length }
  }, [commands, query, recent, dynamic])

  // the active row: the pick for this query, else the first enabled row
  const active = pick.q === query && pick.i >= 0 && pick.i < list.length ? pick.i : stepActive(list, -1, 1, false)
  const setActive = (i: number, mouse = false) => { viaMouse.current = mouse; setPick({ q: query, i }) }

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    input.current?.focus({ preventScroll: true })
    const onDown = (e: PointerEvent) => { if (!dialog.current?.contains(e.target as Node)) closeRef.current() }
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeRef.current() } }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
      // back to where it was, unless the command that ran took the focus elsewhere
      const now = document.activeElement
      if (before && before.isConnected && (!now || now === document.body)) before.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    if (viaMouse.current) { viaMouse.current = false; return }
    body.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const run = (c: Command | undefined) => {
    if (!c || c.disabled) return
    if (commands.some((x) => x.id === c.id)) {
      const next = [c.id, ...recent.filter((id) => id !== c.id)].slice(0, RECENT_KEEP)
      setRecent(next)
      writeRecent(recentKey, next)
    }
    onClose()
    c.run()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    // nothing typed here reaches the owner's shortcuts
    e.stopPropagation()
    const go = (i: number) => { e.preventDefault(); setActive(i) }
    switch (e.key) {
      case 'ArrowDown': return go(stepActive(list, active, 1, true))
      case 'ArrowUp': return go(stepActive(list, active, -1, true))
      case 'PageDown': { let i = active; for (let k = 0; k < PAGE; k++) i = stepActive(list, i, 1, false); return go(i) }
      case 'PageUp': { let i = active; for (let k = 0; k < PAGE; k++) i = stepActive(list, i, -1, false); return go(i) }
      case 'Home': return go(stepActive(list, -1, 1, false))
      case 'End': return go(stepActive(list, list.length, -1, false))
      case 'Enter': e.preventDefault(); return run(list[active])
      case 'Tab': e.preventDefault(); return
      case 'k': case 'K':
        if (e.metaKey || e.ctrlKey) { e.preventDefault(); onClose() }
        return
    }
  }

  let row = 0
  const optId = (i: number) => `${uid}-o${i}`
  return createPortal(
    <>
      <div className="pal-backdrop" aria-hidden="true" />
      <div className="pal" ref={dialog} role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <input
          ref={input} className="pal-input" type="text" role="combobox" aria-expanded="true" aria-controls={`${uid}-list`} aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optId(active) : undefined} aria-label="Command"
          placeholder={placeholder ?? 'Type a command'} value={query} spellCheck={false} autoComplete="off" autoCapitalize="off"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="pal-body" ref={body}>
          <div id={`${uid}-list`} className="pal-list" role="listbox" aria-label="Commands" onMouseDown={(e) => e.preventDefault()}>
            {sections.map((s, si) => (
              <div key={`${s.head}:${si}`} className="pal-group" role="group" aria-labelledby={`${uid}-g${si}`}>
                <div className="pal-head" id={`${uid}-g${si}`}>{s.head}</div>
                {s.items.map((c) => {
                  const i = row++
                  const idx = matchIndexes(c.label, query)
                  return (
                    <div
                      key={c.id} id={optId(i)} data-i={i} className="pal-opt" role="option" aria-selected={i === active}
                      aria-disabled={c.disabled || undefined} aria-checked={c.checked}
                      onMouseMove={() => { if (i !== active && !c.disabled) setActive(i, true) }}
                      onClick={() => run(c)}
                    >
                      <span className="pal-check" aria-hidden="true">{c.checked ? '✓' : ''}</span>
                      <span className="pal-label"><Marked text={c.label} idx={idx} /></span>
                      {c.hint && <span className="pal-hint">{c.hint}</span>}
                      {c.keys && <span className="pal-keys">{c.keys.split(/\s+/).filter(Boolean).map((k, ki) => <kbd key={ki}>{k}</kbd>)}</span>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          {more > 0 && <div className="pal-more">{more.toLocaleString()} more…</div>}
          {list.length === 0 && <div className="pal-empty" role="status">No matching commands</div>}
        </div>
      </div>
    </>,
    document.body,
  )
}
