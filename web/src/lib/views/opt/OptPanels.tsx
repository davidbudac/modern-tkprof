import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { OptText } from '../../data/opt'
import { LM_KINDS, landmarkCounts, pathOf, type DumpIndex, type LmOn } from '../../data/optindex'
import { GUIDE_SECTIONS, KIND_NAME, guideLine } from '../../data/optguide'
import { termsOf, type GlossCtx } from '../../data/optdress'
import { diffLines, formatSqlMemo, sqlSpans } from '../../data/optsql'
import { fmtInt } from '../../data/format'
import { focusRow, listKey } from './listKeys'

/** Text with `code` spans for the backticks of the guide's entries. */
export function mdLite(s: string): ReactNode[] {
  return s.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>))
}

// ---- a list of fixed-height rows, only the ones in view in the page ------------------------------------------------------------------------------

function useFixedWindow(count: number, rowH: number, scrollTo: number): { box: React.RefObject<HTMLDivElement | null>; first: number; last: number } {
  const box = useRef<HTMLDivElement>(null)
  const [st, setSt] = useState({ top: 0, h: 600 })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const read = () => setSt((s) => (s.top === el.scrollTop && s.h === el.clientHeight ? s : { top: el.scrollTop, h: el.clientHeight }))
    read()
    el.addEventListener('scroll', read, { passive: true })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', read); ro.disconnect() }
  }, [])
  // a row to bring into view
  useEffect(() => {
    const el = box.current
    if (!el || scrollTo < 0) return
    const y = scrollTo * rowH
    if (y < el.scrollTop || y + rowH > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, y - el.clientHeight / 2)
  }, [scrollTo, rowH])
  const first = Math.max(0, Math.floor(st.top / rowH) - 6)
  const last = Math.min(count, Math.ceil((st.top + st.h) / rowH) + 6)
  return { box, first, last }
}

// ---- landmarks ----------------------------------------------------------------------------------------------------------------------------

const LM_ROW = 38
const LM_CTX_KINDS = new Set(['iteration', 'run', 'table', 'join-order', 'join-step', 'cbsec', 'qt', 'hints', 'hint-report', 'ap-search'])

type LmItem = { h: string } | { line: number; text: string }

export const LandmarkPanel = memo(function LandmarkPanel({ ix, lm, cur, onSwitch, onGo }: {
  ix: DumpIndex; lm: LmOn; cur: number; onSwitch(kind: string, on: boolean): void; onGo(line: number): void
}) {
  const d = ix.dump
  const counts = useMemo(() => landmarkCounts(d), [d])
  const items = useMemo<LmItem[]>(() => {
    const out: LmItem[] = []
    for (const k of LM_KINDS) {
      if (!lm[k.k] || !counts[k.k]) continue
      out.push({ h: k.k })
      for (const l of d.landmarks) if (l.kind === k.k) out.push({ line: l.line, text: l.text })
    }
    return out
  }, [d, lm, counts])
  const at = useMemo(() => items.findIndex((x) => 'line' in x && x.line === cur), [items, cur])
  const { box, first, last } = useFixedWindow(items.length, LM_ROW, at)
  // keyboard: one option is in the tab order (the current landmark, else the first); the arrow keys move focus to the neighbouring option, scrolling to it
  // when it is not rendered; Enter and Space go to the line
  const lineItems = useMemo(() => items.flatMap((x, k) => ('line' in x ? [k] : [])), [items])
  const tabK = at >= 0 ? at : (lineItems[0] ?? -1)
  const [want, setWant] = useState(-1)
  useEffect(() => {
    if (want < 0) return
    const el = box.current?.querySelector<HTMLElement>(`[data-k="${want}"]`)
    if (el) { el.focus(); setWant(-1) }
  }, [want, first, last, box])
  const moveLm = (from: number, step: 1 | -1 | 'first' | 'last') => {
    const i = lineItems.indexOf(from)
    const to = lineItems[step === 'first' ? 0 : step === 'last' ? lineItems.length - 1 : Math.min(lineItems.length - 1, Math.max(0, i + step))]
    if (to === undefined) return
    const el = box.current
    if (el && (to * LM_ROW < el.scrollTop || (to + 1) * LM_ROW > el.scrollTop + el.clientHeight)) el.scrollTop = Math.max(0, to * LM_ROW - el.clientHeight / 2)
    setWant(to)
  }
  const ctxOf = (line: number) => {
    const p = pathOf(ix, line)
    return p.slice(2).filter((n) => LM_CTX_KINDS.has(n.kind)).map((n) => n.crumb).join(' › ') || p.slice(1).map((n) => n.crumb).join(' › ')
  }
  return (
    <div className="opt-lm-panel">
      <div className="opt-lmk">
        {LM_KINDS.map((k) => (
          <label key={k.k} className="opt-lmk-row" title={k.label}>
            <input type="checkbox" checked={lm[k.k] === true} onChange={(e) => onSwitch(k.k, e.target.checked)} />
            <span className={'opt-lmk-sw ' + k.tone} /><span>{k.label}</span><small>{fmtInt(counts[k.k] ?? 0)}</small>
          </label>
        ))}
        <p className="opt-lmk-note">A kind that is off is not tinted in the text, not on the line map and not stepped through with [ and ].</p>
      </div>
      {items.length === 0
        ? <p className="opt-side-note">No landmark kind is on.</p>
        : (
          <div className="opt-lml" ref={box} role="listbox" aria-label="Landmarks">
            <div style={{ blockSize: items.length * LM_ROW, position: 'relative' }}>
              {items.slice(first, last).map((x, j) => {
                const k = first + j
                const style = { position: 'absolute', insetBlockStart: k * LM_ROW, insetInline: 0, blockSize: LM_ROW } as React.CSSProperties
                if ('h' in x) {
                  const kind = LM_KINDS.find((q) => q.k === x.h)!
                  return <div key={`h${x.h}`} className="opt-lml-h" style={style}><span className={'opt-lmk-sw ' + kind.tone} />{kind.short}<small>{fmtInt(counts[x.h])}</small></div>
                }
                return (
                  <div key={`l${x.line}`} className={'opt-lml-i' + (x.line === cur ? ' on' : '')} style={style} role="option" aria-selected={x.line === cur} data-k={k} tabIndex={k === tabK ? 0 : -1}
                    onClick={() => onGo(x.line)} onKeyDown={(e) => listKey(e, { activate: () => onGo(x.line), move: (step) => moveLm(k, step) })}>
                    <span className="ln">{x.line}</span><span className="tx"><code>{x.text}</code><span>{ctxOf(x.line)}</span></span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
    </div>
  )
})

// ---- bookmarks ---------------------------------------------------------------------------------------------------------------------------

export const BookmarkPanel = memo(function BookmarkPanel({ ix, text, bookmarks, onGo, onNote, onRemove, readOnly }: {
  ix: DumpIndex; text: OptText; bookmarks: ReadonlyMap<number, string>; onGo(line: number): void; onNote(line: number, note: string): void; onRemove(line: number): void; readOnly?: boolean
}) {
  const d = ix.dump
  const list = [...bookmarks.entries()].filter(([l]) => l >= d.viewFrom && l <= d.viewTo).sort((a, b) => a[0] - b[0])
  if (list.length === 0) return <p className="opt-side-note">No bookmarks in this dump. Select a line and press b, or use the bookmark button in the toolbar.</p>
  return (
    <ul className="opt-bms">
      {list.map(([l, note]) => (
        <li key={l}>
          <span className="ln">{l}</span>
          <span>
            <code className="opt-bm-go" role="button" tabIndex={0} title={`Go to line ${l}`} onClick={() => onGo(l)} onKeyDown={(e) => { listKey(e, { activate: () => onGo(l) }) }}>{(text.get(l) ?? '').trim() || '(blank)'}</code>
            <span className="opt-bm-crumb">{pathOf(ix, l).slice(1).map((n) => n.crumb).join(' › ')}</span>
            <input type="text" placeholder="Note" aria-label={`Note on line ${l}`} defaultValue={note} key={`${l}:${note}`} disabled={readOnly}
              onBlur={(e) => { if (e.target.value !== note) onNote(l, e.target.value) }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          </span>
          <button type="button" className="quiet icon-btn" onClick={() => onRemove(l)} title="Remove the bookmark" aria-label={`Remove the bookmark at line ${l}`}>×</button>
        </li>
      ))}
    </ul>
  )
})

// ---- the guide ---------------------------------------------------------------------------------------------------------------------------

export const GuidePanel = memo(function GuidePanel({ ix, text, gloss, line, selected }: { ix: DumpIndex; text: OptText; gloss: GlossCtx; line: number; selected: boolean }) {
  const node = pathOf(ix, line).at(-1)!
  const sec = GUIDE_SECTIONS[node.kind]
  const kind = KIND_NAME[node.kind] ?? node.kind
  const s = text.get(line)
  const gl = s === undefined ? null : guideLine(s)
  const terms = s !== undefined && line >= ix.dump.from && !ix.sqlText.has(line) ? termsOf(s, gloss) : []
  return (
    <div className="opt-guide">
      <div className="opt-g-sec">
        <span className="opt-g-k"><b>Section</b> · {kind !== 'Section' && <>{kind} · </>}lines {fmtInt(node.from)}-{fmtInt(node.to)}</span>
        <span className="opt-g-where" title={node.label}>{node.label}</span>
        {sec
          ? <><span className="opt-g-t">{sec.title}</span><p className="opt-g-p">{mdLite(sec.text)}</p></>
          : <p className="opt-g-none">No guide text for this kind of section.</p>}
      </div>
      <div className="opt-g-sec">
        <span className="opt-g-k"><b>Line {fmtInt(line)}</b> · {selected ? 'selected line' : 'top of the text'}</span>
        <span className="opt-g-where">{s === undefined ? '(not in this report)' : s.trim() || '(blank line)'}</span>
        {gl
          ? <><span className="opt-g-t">{gl.title}</span><p className="opt-g-p">{mdLite(gl.text)}</p></>
          : <p className="opt-g-none">{s === undefined ? 'This line is not in the report.' : 'No guide text for this kind of line.'}</p>}
      </div>
      {terms.length > 0 && (
        <div className="opt-g-sec">
          <span className="opt-g-k"><b>Terms on this line</b> · from the trace's legend and the format reference</span>
          <dl className="opt-g-terms">{terms.map((t) => <Fragment key={t.term}><dt>{t.term}</dt><dd>{t.text}</dd></Fragment>)}</dl>
        </div>
      )}
    </div>
  )
})

// ---- statement versions and their diff -------------------------------------------------------------------------------------------------------

export interface SqlUi { sel: number; against: number; diff: boolean }

export const SqlPanel = memo(function SqlPanel({ ix, line, ui, onUi, onShow }: { ix: DumpIndex; line: number; ui: SqlUi; onUi(p: Partial<SqlUi>): void; onShow(line: number): void }) {
  const d = ix.dump
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => { boxRef.current?.querySelector('.opt-sqlv-i.on')?.scrollIntoView({ block: 'nearest' }) })
  if (d.sql.length === 0) return <p className="opt-side-note">No UNPARSED QUERY IS statement in this dump.</p>
  const sel = ix.sqlAt.get(ui.sel) ?? [...d.sql].reverse().find((v) => v.line <= line) ?? d.sql[0]
  const cur = formatSqlMemo(sel.text)
  const against = ui.against && ui.against < sel.line && ix.sqlAt.has(ui.against) ? ui.against : sel.prev
  const showDiff = ui.diff && against > 0
  let body: ReactNode
  if (showDiff) {
    const prev = ix.sqlAt.get(against)!
    const df = diffLines(formatSqlMemo(prev.text), cur)
    const out = df.filter((x) => x.op === '-').length
    const inn = df.filter((x) => x.op === '+').length
    const prevSql = ix.sqlAt.get(sel.prev)
    const opts = d.sql.filter((v) => v.line < sel.line && !v.sameAs && v.line !== sel.prev)
    body = (
      <>
        <label className="opt-sqlv-against">Against{' '}
          <select value={against} onChange={(e) => onUi({ against: Number(e.target.value) })} aria-label="Diff against">
            {prevSql && <option value={sel.prev}>line {sel.prev} · {prevSql.label} (previous)</option>}
            {opts.map((v) => <option key={v.line} value={v.line}>line {v.line} · {v.label}</option>)}
          </select>
        </label>
        <p className="opt-sqlv-note">{out + inn > 0 ? `${out} ${out === 1 ? 'line' : 'lines'} out, ${inn} in, in the pretty-printed text.` : 'The same text.'}</p>
        <pre className="opt-sqlv-pre">{df.map((x, i) => <div key={i} className={x.op === '+' ? 'd-add' : x.op === '-' ? 'd-del' : undefined}><span className="d-op">{x.op === ' ' ? '' : x.op}</span>{sqlSpans(x.text).map((sp, j) => <span key={j} className={sp.cls || undefined}>{sp.text}</span>)}</div>)}</pre>
      </>
    )
  } else {
    body = <pre className="opt-sqlv-pre">{cur.map((x, i) => <div key={i}>{sqlSpans(x).map((sp, j) => <span key={j} className={sp.cls || undefined}>{sp.text}</span>)}</div>)}</pre>
  }
  return (
    <div className="opt-sqlv">
      <div className="opt-sqlv-list" ref={boxRef} role="listbox" aria-label="Statement versions">
        {d.sql.map((v) => (
          <div key={v.line} className={'opt-sqlv-i' + (v === sel ? ' on' : '')} role="option" aria-selected={v === sel} tabIndex={v === sel ? 0 : -1} title={`Line ${v.line}: ${v.label}`}
            onClick={() => onUi({ sel: v.line, against: 0 })} onKeyDown={(e) => listKey(e, { activate: () => onUi({ sel: v.line, against: 0 }), move: (step) => focusRow(boxRef.current, '.opt-sqlv-i', e.currentTarget, step) })}>
            <span className="ln">{v.line}</span><span className="lb">{v.label}</span><small>{v.sameAs ? `same as ${v.sameAs}` : `${fmtInt(v.text.length)} chars`}</small>
          </div>
        ))}
      </div>
      <div className="opt-sqlv-body">
        <div className="opt-sqlv-head">
          <b>Line {fmtInt(sel.line)}</b><span>{sel.label}</span><span className="sp" />
          <button type="button" className="quiet" onClick={() => onShow(sel.line)} title="Show this line in the text">Show in text</button>
          <button type="button" className="quiet" aria-pressed={showDiff} disabled={!sel.prev} onClick={() => onUi({ diff: !ui.diff })} title={sel.prev ? `Diff against the previous version, line ${sel.prev}` : 'The first version in this dump'}>Diff</button>
        </div>
        {body}
      </div>
    </div>
  )
})
