import type { TraceDoc } from '../data/doc'
import { LINE_KINDS, type PageCache } from '../data/linecache'
import type { AtObjects } from '../data/lines'
import type { Fold } from '../data/folds'
import { decodeLine, type DecodeContext } from '../data/linefields'
import { bindCell, decodeAsText } from '../data/inspecttext'
import { copyText } from '../data/clipboard'
import { fmtInt } from '../data/format'
import { LinesAt } from './LinesAt'

interface Props {
  doc: TraceDoc
  file: number
  cache: PageCache
  /** the selected line */
  line: number
  /** what is at the line (`useLineAt`'s answer), null while unknown */
  at: { line: number; objs: AtObjects } | null
  decodeCtx: DecodeContext
  goTo: (line: number) => void
  note: (msg: string) => void
  block?: Fold | null
  onCopyRange?: (from: number, to: number) => void
  onClose: () => void
}

/**
 * The side view of the Lines view: the selected line translated (every field named, in a meaningful unit, with its raw token and meaning),
 * the bind set of a bind line, and what is at the line. It reads the cache while rendering: the view re-renders when a page arrives.
 */
export function LineInspector({ doc, file, cache, line, at, decodeCtx, goTo, note, block, onCopyRange, onClose }: Props) {
  const cached = cache.line(line)
  const text = cached?.text
  const kind = cached ? LINE_KINDS[cached.kind] : undefined
  const d = cached && kind ? decodeLine(cached.text, kind, decodeCtx, { verbose: true, line }) : null
  const ba = cached ? decodeCtx.bindAt?.(line) : undefined

  const copy = async () => {
    if (!d) return
    note((await copyText(decodeAsText(d, line))) ? 'Copied the translated line' : 'Could not copy the translated line')
  }

  return (
    <aside className="lines-inspect" aria-label="Line inspector">
      <div className="lines-inspect-head">
        <span className="mono">Line {fmtInt(line)}</span>
        {d?.kindLabel && <span className="lines-kind">{d.kindLabel}</span>}
        <span className="lines-inspect-acts">
          <button type="button" className="quiet" onClick={() => void copy()} disabled={!d} title="copy the translated line as label: value (raw) lines">Copy</button>
          <button type="button" className="quiet" onClick={onClose} aria-label="Close the inspector" title="close the inspector (i)">×</button>
        </span>
      </div>
      {text === undefined && !at && <p className="muted">Click a line to inspect it.</p>}
      {text === undefined && at && <p className="muted">loading…</p>}
      {text !== undefined && <pre className="lines-inspect-raw">{text}</pre>}

      {d && (
        <>
          <h3>Translated</h3>
          {d.fields.length > 0 && (
            <table className="lines-inspect-fields">
              <tbody>
                {d.fields.map((f, i) => {
                  const sub = [f.raw, f.desc].filter(Boolean).join(' · ')
                  return (
                    <tr key={i} title={f.hint}>
                      <th scope="row">{f.label}</th>
                      <td>
                        <div>{f.value}</div>
                        {sub && <div className="sub">{f.raw && <span className="mono">{f.raw}</span>}{f.raw && f.desc ? ' · ' : ''}{f.desc}</div>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {d.note && <p className="muted lines-inspect-note">{d.note}</p>}
          {d.fields.length === 0 && !d.note && <p className="muted">Nothing to translate on this line.</p>}
        </>
      )}

      {ba && ba.binds.length > 0 && (
        <>
          <h3>Binds</h3>
          <p className="lines-inspect-sub">Bind set #{ba.set} · {ba.binds.length} {ba.binds.length === 1 ? 'bind' : 'binds'}</p>
          <table className="lines-inspect-binds">
            <tbody>
              {ba.binds.map((b) => {
                const v = bindCell(b)
                return (
                  <tr key={b.pos} className={b.pos === ba.pos ? 'on' : undefined}>
                    <th scope="row">:{b.pos}</th>
                    <td className="ty">{b.type}</td>
                    <td className={'val' + (b.isNull || b.noDef ? ' muted' : '')} title={b.typed ? `${v}\n${b.typed}` : v}>{v}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      {(text !== undefined || at) && (
        <>
          <h3>At this line</h3>
          <LinesAt stack doc={doc} file={file} at={at} text={text ?? ''} goTo={goTo} note={note} block={block} onCopyRange={onCopyRange} />
        </>
      )}
    </aside>
  )
}
