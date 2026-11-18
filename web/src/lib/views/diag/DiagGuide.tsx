import { Fragment, memo, type ReactNode } from 'react'
import type { DiagNode } from '../../data/diag'
import { GUIDE_SOURCE, KIND_NAME, guideFor } from '../../data/diagguide'
import { fmtBytes, fmtInt } from '../../data/format'
import { readingView } from './readings'

/** The guide's text: `code` between backticks, **bold** between double stars. */
export function md(s: string): ReactNode[] {
  return s.split(/(`[^`]*`|\*\*[^*]+\*\*)/).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <b key={i}>{part.slice(2, -2)}</b>
    return <Fragment key={i}>{part}</Fragment>
  })
}

interface Props {
  /** the node the panel is about: the selected one, else the one the text shows */
  node: DiagNode | null
  /** the node is the selection (else it is only the one at the top of the text) */
  selected: boolean
  /** search hits inside the node; null when there is no search */
  hits: number | null
  q: string
  /** the lines of the node that are in the text, when the source has no text (the standalone report) */
  digest: boolean
  onGo(line: number): void
}

/**
 * The right panel: the selected node's facts (its lines, kind, children, whether it has a reading) and a sourced text of its kind. "Sourced or silent":
 * every entry cites a section of docs/trace-format-diag.md, and a kind without an entry says so.
 */
export const DiagGuide = memo(function DiagGuide({ node, selected, hits, q, digest, onGo }: Props) {
  if (!node) return <p className="opt-side-note">Select a part in the outline, or a line in the text.</p>
  const entries = guideFor(node)
  const rk = node.reading
  const has = rk ? !!readingView(rk) : false
  return (
    <div className="opt-guide dg-guide">
      <section className="opt-g-sec">
        <span className="opt-g-k"><b>{selected ? 'Selected' : 'At the top of the text'}</b></span>
        <span className="opt-g-t">{node.title}</span>
        {node.sub && <p className="opt-g-p dg-dim">{node.sub}</p>}
        <dl className="dg-kv">
          <dt>Lines</dt>
          <dd>{digest ? fmtInt(node.from) : <button type="button" className="link dg-go" onClick={() => onGo(node.from)} title={`Go to line ${fmtInt(node.from)}`}>{fmtInt(node.from)}</button>} – {fmtInt(node.to)} <span className="dg-dim">({fmtInt(node.lines)})</span></dd>
          <dt>Kind</dt>
          <dd><span className="dg-mono">{node.kind}</span> <span className="dg-dim">{KIND_NAME[node.kind] ?? ''}</span></dd>
          <dt>Children</dt>
          <dd>{node.hasChildren ? 'has parts, listed in the outline' : 'none'}</dd>
          {node.name !== undefined && node.kind === 'heap' && (<><dt>Heap</dt><dd><span className="dg-mono">{node.name}</span>{node.depth !== undefined && <span className="dg-dim"> · depth {node.depth}</span>}{node.size ? <span className="dg-dim"> · {fmtBytes(node.size)}</span> : null}</dd></>)}
          {node.cut && (<><dt>End</dt><dd>no end line: the file ended, or a line of another format came, first</dd></>)}
          {q && hits !== null && (<><dt>Hits</dt><dd>{fmtInt(hits)} for <span className="dg-mono">{q}</span></dd></>)}
          <dt>Reading</dt>
          <dd>{rk ? <><b>{rk}</b> <span className="dg-dim">{has ? '(centre, Reading)' : '(this version has no view for it)'}</span></> : <span className="dg-dim">none for this kind of section</span>}</dd>
        </dl>
      </section>
      {entries.length === 0 && (
        <section className="opt-g-sec"><p className="opt-g-none">No guide text for this kind of section.</p></section>
      )}
      {entries.map((g) => (
        <section className="opt-g-sec" key={g.title}>
          <span className="opt-g-t">{g.title}</span>
          <p className="opt-g-p">{md(g.text)}</p>
          {g.note && <p className="opt-g-p dg-note">{md(g.note)}</p>}
          <span className="opt-g-k">Source: <b>{GUIDE_SOURCE}</b>, § {g.src}</span>
        </section>
      ))}
    </div>
  )
})
