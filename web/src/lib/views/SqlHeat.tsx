import { Fragment, useMemo, useState, type CSSProperties } from 'react'
import type { TraceDoc } from '../data/doc'
import { fmtInt, fmtDur, preview } from '../data/format'
import { heatTint, HEAT_MIN_SHARE, type HeatCallout, type HeatGroup, type HeatOk, type HeatPart } from '../data/sqlheat'
import { StmtLink } from '../components/StmtLink'
import '../styles/sqlheat.css'

/** "94.6 %"; a share above 0 that rounds to nothing reads "< 0.1 %". */
function pct(share: number): string {
  const p = share * 100
  return p > 0 && p < 0.05 ? '< 0.1 %' : `${p.toFixed(1)} %`
}

/** "line 3" or "lines 1 and 2" or "lines 1, 2 and 5" */
function lineWord(ids: number[]): string {
  if (ids.length === 1) return `line ${ids[0]}`
  return `lines ${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`
}

/** the operations of plan lines, with their self gets where they have any */
function partsText(parts: HeatPart[]): string {
  return parts.map((p) => `${p.op}${p.selfCr > 0 ? ` (${fmtInt(p.selfCr)} gets)` : ''}`).join(', ')
}

/**
 * The margin: a bar and the share on the first line of each tinted group (the next free line of its fragments when
 * another group has that one), and a tinted rule beside every line a tinted group's fragments touch (the hotter wins).
 */
function marginOf(heat: HeatOk): { entry: number[]; rule: number[] } {
  const n = heat.lines.length
  const entry = new Array<number>(n).fill(-1), rule = new Array<number>(n).fill(-1)
  heat.groups.forEach((g, gi) => {
    if (g.share < HEAT_MIN_SHARE) return
    for (let l = g.firstLine; l <= g.lastLine; l++) if (rule[l] < 0) rule[l] = gi
    for (let l = g.firstLine; l <= g.lastLine; l++) if (entry[l] < 0) { entry[l] = gi; break }
  })
  return { entry, rule }
}

/**
 * SQL heat (data/sqlheat.ts): the statement's text, formatted, each fragment tinted by the share of the plan's self time
 * of the plan lines that belong to it; a margin with the share of each tinted fragment; under it the plan lines of each
 * fragment and the ones the text has no place for. ≈ marks a match by inference. Hovering a fragment or its line below
 * lights up the other.
 */
export function SqlHeat({ doc, heat }: { doc: TraceDoc; heat: HeatOk }) {
  const [hot, setHot] = useState(-1)
  const margin = useMemo(() => marginOf(heat), [heat])
  const callouts = useMemo(() => {
    const m = new Map<number, HeatCallout[]>()
    for (const c of heat.callouts) { const l = m.get(c.line); if (l) l.push(c); else m.set(c.line, [c]) }
    return m
  }, [heat])
  const tip = (g: HeatGroup) =>
    `${g.what}: ${pct(g.share)} of the plan's self time (${fmtInt(g.selfUs)} of ${fmtInt(heat.totalUs)} µs) · ${lineWord(g.parts.map((p) => p.id))} ${partsText(g.parts)}` +
    (g.approx.length ? `\n≈ ${g.approx.join('; ')}` : '')
  const hover = (gi: number) => ({ onPointerEnter: () => setHot(gi), onPointerLeave: () => setHot((h) => (h === gi ? -1 : h)) })
  const hotGroups = heat.groups.filter((g) => g.share >= HEAT_MIN_SHARE)
  const cool = heat.groups.filter((g) => g.share < HEAT_MIN_SHARE)
  const coolUs = cool.reduce((a, g) => a + g.selfUs, 0)
  const why = [...new Set(heat.groups.flatMap((g) => g.approx))]
  const top = heat.groups[0]
  return (
    <div className={'sh' + (hot >= 0 ? ' has-hot' : '')}>
      <figure className="sh-fig" aria-label={`SQL heat: ${top ? `${pct(top.share)} of the plan's self time in ${top.what}` : 'no plan line placed in the text'}`}>
        <div className="sh-code">
          <div className="sh-lines">
            {heat.lines.map((segs, i) => (
              <Fragment key={i}>
                <div className="sh-row">
                  {segs.length === 0 ? ' ' : segs.map((s, k) => {
                    if (s.group < 0) return <Fragment key={k}>{s.text}</Fragment>
                    const g = heat.groups[s.group]
                    const h = heatTint(g.share)
                    return (
                      <span key={k} className={'sh-frag' + (h > 0 ? '' : ' cool') + (hot === s.group ? ' on' : '')} style={{ '--h': `${h.toFixed(1)}%` } as CSSProperties}
                        title={tip(g)} {...hover(s.group)}>{s.text}</span>
                    )
                  })}
                </div>
                {callouts.get(i)?.map((c, k) => <Callout key={k} doc={doc} c={c} />)}
              </Fragment>
            ))}
          </div>
        </div>
        <div className="sh-margin">
          {heat.lines.map((_, i) => {
            const gi = margin.entry[i], ri = margin.rule[i]
            const g = gi >= 0 ? heat.groups[gi] : null
            const rg = ri >= 0 ? heat.groups[ri] : null
            return (
              <Fragment key={i}>
                <div className={'sh-mg' + (rg ? ' br' : '') + (g && hot === gi ? ' on' : '')} style={rg ? ({ '--h': `${heatTint(rg.share).toFixed(1)}%` } as CSSProperties) : undefined}
                  {...(g ? { ...hover(gi), title: tip(g) } : {})}>
                  {g && <>
                    <i className="sh-bar" aria-hidden="true"><b style={{ inlineSize: `${(g.share * 100).toFixed(1)}%` }} /></i>
                    <span className="sh-pct">{g.approx.length ? '≈ ' : ''}{pct(g.share)}</span>
                  </>}
                </div>
                {callouts.get(i)?.map((_c, k) => <div key={k} className="sh-mg co" />)}
              </Fragment>
            )
          })}
        </div>
      </figure>
      <div className="sh-maps">
        {hotGroups.map((g) => {
          const gi = heat.groups.indexOf(g)
          return (
            <p key={gi} className={hot === gi ? 'on' : undefined} {...hover(gi)} title={g.approx.length ? `≈ ${g.approx.join('; ')}` : undefined}>
              {g.approx.length ? '≈ ' : ''}{lineWord(g.parts.map((p) => p.id))} {partsText(g.parts)} · <span className="mono">{fmtInt(g.selfUs)}</span> µs self
            </p>
          )
        })}
        {cool.length > 0 && (
          <p>
            {lineWord(cool.flatMap((g) => g.parts.map((p) => p.id)).sort((a, b) => a - b))} {partsText(cool.flatMap((g) => g.parts).sort((a, b) => a.id - b.id))} · <span className="mono">{fmtInt(coolUs)}</span> µs self{cool.length > 1 ? ' together, under 1 % each' : ', under 1 %'}, not tinted
          </p>
        )}
        {heat.unplaced.parts.length > 0 && (
          <p className="sh-rest">
            not placed: {lineWord(heat.unplaced.parts.map((p) => p.id))} {partsText(heat.unplaced.parts)} · <span className="mono">{pct(heat.unplaced.share)}</span>
          </p>
        )}
      </div>
      <p className="sh-legend">
        tint = share of the plan's self time (
        {[0.05, 0.25, 0.5, 0.95].map((s, k) => (
          <Fragment key={s}>{k > 0 && ' '}<i className="sh-sw" style={{ '--h': `${heatTint(s).toFixed(1)}%` } as CSSProperties} aria-hidden="true" />{Math.round(s * 100)} %</Fragment>
        ))}
        ) · ≈ = attributed by inference{why.length > 0 && <>: {why.slice(0, 3).join('; ')}{why.length > 3 ? ` and ${why.length - 3} more` : ''}</>}
      </p>
      {heat.notes.length > 0 && <div className="callout sh-notes">{heat.notes.map((n) => <p key={n}>{n}</p>)}</div>}
    </div>
  )
}

/** "≈ runs statement N … K times per execution: E executions, X", under the function call, on a thin leader. */
function Callout({ doc, c }: { doc: TraceDoc; c: HeatCallout }) {
  const st = doc.statements[c.child.statement]
  const per = c.perExec >= 10 ? fmtInt(c.perExec) : String(Math.round(c.perExec * 10) / 10)
  return (
    <div className="sh-callout">
      <span className="sh-pad" aria-hidden="true">{' '.repeat(c.col)}</span>
      <span className="sh-ct" title={`inferred: ${c.fn} is the only function in the text that is not an Oracle built-in. The time of the statement it runs is in the plan lines already; this is not a share of its own.`}>
        <i className="sh-lead" aria-hidden="true" />
        <b>≈</b> runs statement <StmtLink doc={doc} id={c.child.statement} />
        {c.perExec > 0 && <> {c.child.exact ? '' : 'about '}<span className="mono">{per}</span> time{c.perExec === 1 ? '' : 's'} per execution:</>}
        {' '}<span className="mono">{fmtInt(c.child.executions)}</span> execution{c.child.executions === 1 ? '' : 's'}, <span className="mono">{fmtDur(c.child.elapsedUs)}</span>
        {c.others > 0 && <>, and {c.others} other recursive statement{c.others === 1 ? '' : 's'}</>}
        {st && <span className="sh-child"> · {preview(st.text, 28)}</span>}
      </span>
    </div>
  )
}
