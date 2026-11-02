// A small Markdown renderer for assistant answers: paragraphs, headings, lists, block quotes, code, tables, emphasis,
// inline code and links. It builds React nodes from text and has no HTML path at all, so markup in an answer
// (`<img onerror=…>`, `<script>`) shows as the text it is. Only `mtkprof:` and `https:` links become links (links.ts).
import { memo, useMemo, type ReactNode } from 'react'
import { linkOf } from './links'

export type Inline =
  | string
  | { t: 'br' }
  | { t: 'code'; text: string }
  | { t: 'strong' | 'em' | 'del'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[]; source: string }

export type Align = 'left' | 'center' | 'right' | null

export type Block =
  | { t: 'p'; children: Inline[] }
  | { t: 'h'; level: number; children: Inline[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'quote'; children: Block[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' }

// ---- blocks ----------------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?/
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

const blank = (l: string) => l.trim() === ''
const indentOf = (l: string) => l.length - l.trimStart().length
const isTableStart = (lines: string[], i: number) => lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')
const startsBlock = (l: string) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l)

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/^\t+/, (t) => '    '.repeat(t.length)))
  return parseBlocks(lines)
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (blank(line)) { i++; continue }
    let m: RegExpExecArray | null
    if ((m = FENCE.exec(line))) {
      const close = new RegExp(`^ {0,3}${m[1][0] === '`' ? '`' : '~'}{${m[1].length},}[ \\t]*$`)
      const body: string[] = []
      i++
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++])
      i++ // the closing fence (an answer still streaming may not have it yet)
      out.push({ t: 'code', lang: m[2], text: body.join('\n') })
      continue
    }
    if ((m = HEADING.exec(line))) {
      out.push({ t: 'h', level: m[1].length, children: parseInline(m[2] ?? '') })
      i++
      continue
    }
    if (isTableStart(lines, i)) {
      const head = cells(line)
      const align = cells(lines[i + 1]).map((c): Align => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null))
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) {
        const r = cells(lines[i++])
        rows.push(head.map((_, k) => parseInline(r[k] ?? '')))
      }
      out.push({ t: 'table', align: head.map((_, k) => align[k] ?? null), head: head.map((h) => parseInline(h)), rows })
      continue
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''))
      out.push({ t: 'quote', children: parseBlocks(body) })
      continue
    }
    if (ITEM.test(line)) {
      i = parseList(lines, i, out)
      continue
    }
    const para: string[] = []
    while (i < lines.length && !blank(lines[i]) && !(para.length && (startsBlock(lines[i]) || ITEM.test(lines[i]) || isTableStart(lines, i)))) para.push(lines[i++].trim())
    out.push({ t: 'p', children: parseInline(para.join('\n')) })
  }
  return out
}

/** One list from `lines[i]`; the items' lines, dedented, are blocks of their own (nested lists, paragraphs). */
function parseList(lines: string[], i: number, out: Block[]): number {
  const first = ITEM.exec(lines[i])!
  const ordered = /\d/.test(first[2])
  const items: Block[][] = []
  while (i < lines.length) {
    const m = ITEM.exec(lines[i])
    if (!m || /\d/.test(m[2]) !== ordered) break
    const gap = m[3].length > 4 || m[4] === '' ? 1 : m[3].length
    const content = m[1].length + m[2].length + gap
    const body = [m[4]]
    i++
    while (i < lines.length) {
      const l = lines[i]
      if (blank(l)) {
        let j = i
        while (j < lines.length && blank(lines[j])) j++
        if (j < lines.length && indentOf(lines[j]) >= content) {
          body.push('')
          i++
          continue
        }
        break
      }
      if (indentOf(l) >= content) body.push(l.slice(content))
      else if (ITEM.test(l) || startsBlock(l)) break
      else body.push(l.trim()) // a lazy continuation of the item's paragraph
      i++
    }
    items.push(parseBlocks(body))
    let j = i
    while (j < lines.length && blank(lines[j])) j++
    const next = j < lines.length ? ITEM.exec(lines[j]) : null
    if (!next || /\d/.test(next[2]) !== ordered) break
    i = j
  }
  out.push({ t: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items })
  return i
}

/** The cells of a table row: split at `|` outside code spans, without the outer pipes. */
function cells(row: string): string[] {
  const out: string[] = []
  let cur = ''
  let code = false
  const s = row.trim().replace(/^\|/, '')
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (c === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue }
    if (c === '`') code = !code
    if (c === '|' && !code) { out.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim() !== '' || !s.endsWith('|')) out.push(cur.trim())
  return out
}

// ---- inlines ---------------------------------------------------------------------------------

const PUNCT = /[!-/:-@[-`{-~]/
const SPACE = /\s/
const WORD = /[\p{L}\p{N}]/u

export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = () => {
    if (buf) out.push(buf)
    buf = ''
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      buf += s[i + 1]
      i += 2
      continue
    }
    if (c === '\n') {
      buf = buf.replace(/[ \t]+$/, '')
      flush()
      out.push({ t: 'br' })
      i++
      continue
    }
    if (c === '`') {
      const run = runOf(s, i, '`')
      const end = closingRun(s, i + run, '`', run)
      if (end < 0) {
        buf += s.slice(i, i + run)
        i += run
        continue
      }
      let text = s.slice(i + run, end).replace(/\n/g, ' ')
      if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ')) text = text.slice(1, -1)
      flush()
      out.push({ t: 'code', text })
      i = end + run
      continue
    }
    if (c === '<') {
      const m = /^<((?:https|mtkprof):[^\s<>]*)>/i.exec(s.slice(i))
      if (m) {
        flush()
        out.push({ t: 'link', href: m[1], children: [m[1]], source: m[0] })
        i += m[0].length
        continue
      }
    }
    if (c === '[') {
      const l = linkAt(s, i)
      if (l) {
        flush()
        out.push({ t: 'link', href: l.href, children: parseInline(l.label), source: s.slice(i, l.end) })
        i = l.end
        continue
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      const e = emphasisAt(s, i)
      if (e) {
        flush()
        out.push(e.node)
        i = e.end
        continue
      }
      const run = runOf(s, i, c)
      buf += s.slice(i, i + run)
      i += run
      continue
    }
    buf += c
    i++
  }
  flush()
  return out
}

function runOf(s: string, i: number, c: string): number {
  let n = 0
  while (s[i + n] === c) n++
  return n
}

/** The start of the next run of exactly `n` `c` after `from`, or -1. */
function closingRun(s: string, from: number, c: string, n: number): number {
  for (let j = s.indexOf(c, from); j >= 0; j = s.indexOf(c, j + 1)) {
    const run = runOf(s, j, c)
    if (run === n) return j
    j += run - 1
  }
  return -1
}

/** `[label](href)` at `i`: brackets and parentheses may nest; a `"title"` after the href is dropped. */
function linkAt(s: string, i: number): { label: string; href: string; end: number } | null {
  let depth = 0
  let k = i
  for (; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue }
    if (s[k] === '[') depth++
    else if (s[k] === ']' && --depth === 0) break
    else if (s[k] === '\n' && s[k + 1] === '\n') return null
  }
  if (depth !== 0 || s[k + 1] !== '(') return null
  const label = s.slice(i + 1, k)
  let p = k + 2
  let paren = 1
  let j = p
  for (; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue }
    if (s[j] === '\n') return null
    if (s[j] === '(') paren++
    else if (s[j] === ')' && --paren === 0) break
  }
  if (paren !== 0) return null
  let target = s.slice(p, j).trim()
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*')$/.exec(target)
  if (titled) target = titled[1]
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
  return { label, href: target, end: j + 1 }
}

/** `**strong**`, `*em*`, `_em_` (not inside a word: `sql_id` stays as it is), `~~del~~`, `***both***` at `i`. */
function emphasisAt(s: string, i: number): { node: Inline; end: number } | null {
  const c = s[i]
  const run = runOf(s, i, c)
  const after = s[i + run]
  if (after === undefined || SPACE.test(after)) return null
  if (c === '_' && i > 0 && WORD.test(s[i - 1])) return null
  if (c === '~' && run !== 2) return null
  for (const n of c === '~' ? [2] : run >= 2 ? [2, 1] : [1]) {
    const d = c.repeat(n)
    for (let j = s.indexOf(d, i + n + 1); j >= 0; j = s.indexOf(d, j + 1)) {
      const end = j + runOf(s, j, c) - n // the closer is the end of its run: `***x***`
      if (SPACE.test(s[end - 1]) || s.slice(i + n, end).includes('\n\n')) continue
      if (c === '_' && end + n < s.length && WORD.test(s[end + n])) continue
      const inner = parseInline(s.slice(i + n, end))
      return { node: { t: c === '~' ? 'del' : n === 2 ? 'strong' : 'em', children: inner }, end: end + n }
    }
  }
  return null
}

// ---- links -----------------------------------------------------------------------------------

/** An `mtkprof:` link of a text: as written (`[label](mtkprof:#…)`), its label as plain text, and its hash. */
export interface CitedLink { source: string; label: string; hash: string }

const plain = (nodes: Inline[]): string =>
  nodes.map((n) => (typeof n === 'string' ? n : n.t === 'br' ? ' ' : n.t === 'code' ? n.text : plain(n.children))).join('')

/** The `mtkprof:` links of a Markdown text in the order they are written (code is not a link). */
export function mtkprofLinks(text: string): CitedLink[] {
  const out: CitedLink[] = []
  const inline = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (typeof n === 'string' || n.t === 'br' || n.t === 'code') continue
      const to = n.t === 'link' ? linkOf(n.href) : null
      if (to?.kind === 'mtkprof') out.push({ source: (n as { source: string }).source, label: plain(n.children), hash: to.hash })
      else inline(n.children)
    }
  }
  const block = (list: Block[]) => {
    for (const b of list) {
      switch (b.t) {
        case 'p': case 'h': inline(b.children); break
        case 'quote': block(b.children); break
        case 'list': b.items.forEach(block); break
        case 'table': b.head.forEach(inline); b.rows.forEach((r) => r.forEach(inline)); break
      }
    }
  }
  block(parseMarkdown(text))
  return out
}

// ---- rendering -------------------------------------------------------------------------------

/** How an `mtkprof:` link shows: the chat panel resolves it against the trace (a chip). */
export type ChipRenderer = (hash: string, label: ReactNode, key: number) => ReactNode

function inlines(nodes: Inline[], chip: ChipRenderer): ReactNode[] {
  return nodes.map((n, k) => {
    if (typeof n === 'string') return n
    switch (n.t) {
      case 'br': return <br key={k} />
      case 'code': return <code key={k}>{n.text}</code>
      case 'strong': return <strong key={k}>{inlines(n.children, chip)}</strong>
      case 'em': return <em key={k}>{inlines(n.children, chip)}</em>
      case 'del': return <del key={k}>{inlines(n.children, chip)}</del>
      case 'link': {
        const to = linkOf(n.href)
        if (!to) return <span key={k} className="md-nolink" title="Not a link: only https and mtkprof links open">{n.source}</span>
        const label = inlines(n.children, chip)
        if (to.kind === 'mtkprof') return chip(to.hash, label, k)
        return <a key={k} href={to.href} target="_blank" rel="noopener noreferrer" title={to.href}>{label}</a>
      }
    }
  })
}

function blocks(list: Block[], chip: ChipRenderer): ReactNode[] {
  return list.map((b, k) => {
    switch (b.t) {
      case 'p': return <p key={k}>{inlines(b.children, chip)}</p>
      case 'h': {
        const H = b.level <= 2 ? 'h3' : b.level === 3 ? 'h4' : 'h5'
        return <H key={k}>{inlines(b.children, chip)}</H>
      }
      case 'code': return <pre key={k} className="md-code" data-lang={b.lang || undefined}><code>{b.text}</code></pre>
      case 'hr': return <hr key={k} />
      case 'quote': return <blockquote key={k}>{blocks(b.children, chip)}</blockquote>
      case 'list': {
        const items = b.items.map((item, j) => (
          // a tight item (one paragraph) shows its text without a paragraph around it
          <li key={j}>{item.length === 1 && item[0].t === 'p' ? inlines(item[0].children, chip) : blocks(item, chip)}</li>
        ))
        return b.ordered ? <ol key={k} start={b.start === 1 ? undefined : b.start}>{items}</ol> : <ul key={k}>{items}</ul>
      }
      case 'table':
        return (
          <div key={k} className="md-table">
            <table>
              <thead>
                <tr>{b.head.map((h, j) => <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>{inlines(h, chip)}</th>)}</tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>{r.map((c, x) => <td key={x} style={b.align[x] ? { textAlign: b.align[x]! } : undefined}>{inlines(c, chip)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    }
  })
}

/** The answer `text` as React nodes; `chip` shows each `mtkprof:` link. */
export const Markdown = memo(function Markdown({ text, chip }: { text: string; chip: ChipRenderer }) {
  const parsed = useMemo(() => parseMarkdown(text), [text])
  return <div className="md">{blocks(parsed, chip)}</div>
})
