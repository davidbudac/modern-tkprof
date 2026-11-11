// How one line of the trace is dressed in the formatted text: its row class, and the spans of text with a class (the `GBP:` prefix, `Best::`,
// glossary terms, `name = value` keys, SQL). The search marks are laid over the spans when they are drawn.
import type { OptSql } from './opt'
import type { DumpIndex } from './optindex'
import type { GlossTerm } from './optguide'
import { sqlSpans, type SqlSpan } from './optsql'

export interface Span { text: string; cls: string; /** a glossary term: its key */ t?: string }
export interface Dressed { cls: string; spans: Span[]; /** the UNPARSED header: the statement it opens */ act?: OptSql }

/** A separator line: only * = - characters. */
export const SEP_RE = /^\s*[*=-]{3,}\s*$/
const PFX_RE = /^(\s*)([A-Z][A-Za-z]{1,7}(?::\[V\d\])?:)/

/** What the glossary needs to find terms in a line. */
export interface GlossCtx { gloss: ReadonlyMap<string, GlossTerm>; re: RegExp | null }

/** Splits the spans that have no class at the matches of `re` (a `g` pattern), each match becoming the span `mk` makes. */
export function splitSpans(spans: Span[], re: RegExp, mk: (m: RegExpExecArray) => Span): Span[] {
  const out: Span[] = []
  for (const sp of spans) {
    if (sp.cls) { out.push(sp); continue }
    re.lastIndex = 0
    let p = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(sp.text))) {
      if (m[0] === '') { re.lastIndex++; continue }
      if (m.index > p) out.push({ text: sp.text.slice(p, m.index), cls: '' })
      out.push(mk(m))
      p = m.index + m[0].length
    }
    if (p < sp.text.length) out.push({ text: sp.text.slice(p), cls: '' })
  }
  return out
}

/** The glossary terms of a line, first the prefix's, in order of appearance, each once. */
export function termsOf(s: string, g: GlossCtx): GlossTerm[] {
  const out: GlossTerm[] = []
  if (!g.re) return out
  const seen = new Set<string>()
  g.re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = g.re.exec(s))) if (!seen.has(m[0])) { seen.add(m[0]); const t = g.gloss.get(m[0]); if (t) out.push(t) }
  const pm = PFX_RE.exec(s)
  if (pm) { const t = pm[2].replace(/:.*$/, ''); const gt = g.gloss.get(t); if (gt && !seen.has(t)) out.unshift(gt) }
  return out
}

/** Dresses line `i` (text `s`) of the open dump. */
export function dressLine(ix: DumpIndex, g: GlossCtx, i: number, s: string): Dressed {
  const d = ix.dump
  let m: RegExpExecArray | null
  if (SEP_RE.test(s)) return { cls: 'opt-rule', spans: [] }
  if ((m = /^(-{3,} )(.+?)( -{3,})\s*$/.exec(s))) return { cls: 'opt-h3', spans: [{ text: m[1], cls: 'opt-dash' }, { text: m[2], cls: '' }, { text: m[3], cls: 'opt-dash' }] }
  if (/^[A-Z][A-Z0-9 ()/,_-]{5,}$/.test(s.trim()) && s.trim().includes(' ')) return { cls: 'opt-h2', spans: [{ text: s.trim(), cls: '' }] }
  if (ix.sqlText.has(i)) return { cls: 'opt-stmt', spans: sqlSpans(s) as SqlSpan[] }
  const v = ix.sqlHeadAt.get(i)
  if (v) {
    const k = s.indexOf('*******')
    return { cls: 'opt-sqlhead', spans: [{ text: s.slice(0, k), cls: 'opt-pfx' }, { text: s.slice(k), cls: 'opt-dim' }], act: v }
  }
  if ((m = /^(\s*[_a-z][\w#$]*\s{2,}=)( .*)$/.exec(s))) return { cls: '', spans: [{ text: m[1], cls: 'opt-key' }, { text: m[2], cls: '' }] }
  if ((m = /^(\s+fix\s+\d+\s+=)(.*)$/.exec(s))) return { cls: '', spans: [{ text: m[1], cls: 'opt-key' }, { text: m[2], cls: '' }] }
  let spans: Span[] = [{ text: s, cls: '' }]
  // (`Best::` would read as a prefix of the kind `GBP:`; the mock-up's pattern took it so and never reached its own `Best::` rule)
  if (!/^\s*Best::/.test(s) && (m = PFX_RE.exec(s))) {
    const term = m[2].replace(/:.*$/, '').replace(/:$/, '')
    const known = g.gloss.has(term)
    spans = [{ text: m[1], cls: '' }, { text: m[2], cls: 'opt-pfx' + (known ? ' opt-gl' : ''), t: known ? term : '' }, { text: s.slice(m[0].length), cls: '' }].filter((x) => x.text)
  }
  spans = splitSpans(spans, /Best::/g, (mm) => ({ text: mm[0], cls: 'opt-best' }))
  if (g.re && i >= d.from) spans = splitSpans(spans, g.re, (mm) => ({ text: mm[0], cls: 'opt-gl', t: mm[0] }))
  return { cls: '', spans }
}

/** The matches of the search inside a line's text: [start, end, isCurrent], at most 200 of them. `cur`: the current hit sits on this line, its first match is the current one. */
export function matchRanges(re: RegExp | null, text: string, cur: boolean): [number, number, boolean][] {
  if (!re) return []
  const out: [number, number, boolean][] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  let first = true
  while ((m = re.exec(text))) {
    if (m[0] === '') { re.lastIndex++; continue }
    out.push([m.index, m.index + m[0].length, first && cur])
    first = false
    if (out.length >= 200) break
  }
  return out
}
