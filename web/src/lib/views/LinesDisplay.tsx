import { useState, type CSSProperties, type ReactNode } from 'react'
import { DELTA_MODES, SHOW_TOGGLES } from '../data/display'
import type { DeltaMode } from '../state/linesPrefs'
import { BanIcon, BarsIcon, ClockIcon, FunnelIcon, HighlighterIcon, LightbulbIcon, LineMapIcon, LinkIcon, PanelLeftIcon, RepeatIcon, TableIcon, TriangleIcon, UnfoldIcon, VariableIcon, WrapTextIcon } from '../components/icons'
import { fmtDur, fmtInt } from '../data/format'
import { LANE_COLORS } from '../data/lanecolor'
import type { LineKind } from '../data/lines'
import { lineToneToken } from '../components/colors'
import type { LinesPrefs } from '../state/linesPrefs'

/** The line colours of the key: a row per colour (a kind it stands for, for the swatch), with a tick when its lines can be dimmed. */
const COLOUR_ROWS: { label: string; kind: LineKind; mute?: string; title?: string }[] = [
  { label: 'calls', kind: 'call' },
  { label: 'waits', kind: 'wait', mute: 'waits' },
  { label: 'PARSING IN CURSOR, END OF STMT', kind: 'parsing-in-cursor' },
  { label: 'binds', kind: 'binds', mute: 'binds' },
  { label: 'STAT / commit', kind: 'stat', mute: 'stat', title: 'the tick dims the STAT lines (the commits stay)' },
  { label: 'errors', kind: 'error' },
  { label: 'LOB / RPC', kind: 'lob' },
  { label: 'session markers (***)', kind: 'marker', mute: 'markers' },
  { label: 'framing (header, blank, ====)', kind: 'header', mute: 'framing' },
]

/** The Δ filter's state as the panel's note says it. */
export interface DeltaState { loading: boolean; count?: number; truncated?: boolean; error?: string; what: string }

/** A section of the pane: a small heading over its controls. */
function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="ld-sec">
      <h4>{title}{note && <span className="h4-note"> · {note}</span>}</h4>
      {children}
    </section>
  )
}

/** The icon of each Show toggle and of each Δ filter mode. */
const SHOW_ICONS: Record<(typeof SHOW_TOGGLES)[number]['key'], () => React.JSX.Element> = {
  wrap: WrapTextIcon, heat: BarsIcon, strip: LineMapIcon, links: LinkIcon, hints: LightbulbIcon, clock: ClockIcon, delta: TriangleIcon,
}
const MODE_ICONS: Record<DeltaMode, () => React.JSX.Element> = { off: BanIcon, highlight: HighlighterIcon, filter: FunnelIcon }

/** One icon toggle: pressed or not, its name, what it does and its key in the tooltip (and the caption under the grid), the name as the accessible label. */
interface Tog { id: string; name: string; title: string; keys?: string; icon: () => React.JSX.Element; on: boolean; onClick(): void; busy?: boolean }

/** A grid of icon toggle buttons; the one under the pointer or focused is named in a caption under the grid (the tooltip says what it does). */
function TogGrid({ label, togs }: { label: string; togs: Tog[] }) {
  const [cap, setCap] = useState<string | null>(null)
  const shown = togs.find((t) => t.id === cap)
  return (
    <>
      <div className="ld-togs" role="group" aria-label={label}>
        {togs.map((t) => {
          const Icon = t.icon
          return (
            <button key={t.id} type="button" className={'ld-tog' + (t.busy ? ' busy-src' : '')} aria-pressed={t.on} aria-label={t.name} title={`${t.name}${t.keys ? ` (${t.keys})` : ''}: ${t.title}`}
              onClick={t.onClick} onMouseEnter={() => setCap(t.id)} onMouseLeave={() => setCap(null)} onFocus={() => setCap(t.id)} onBlur={() => setCap(null)}>
              <Icon />
            </button>
          )
        })}
      </div>
      <p className="ld-cap" aria-hidden="true">{shown ? <><b>{shown.name}</b>{shown.keys && <kbd>{shown.keys}</kbd>}</> : null}</p>
    </>
  )
}

/**
 * The side panel's Display tab: the settings that are set once and left, moved off the toolbar. The formatted view's (colour the lanes by, Fold repeats, the
 * Δ column, the key to what its colours and bars mean) come first and are not offered in the raw view; then the Δ filter, what the rows show, the line colours
 * (tick to dim), and the bulk folds. The on / off settings are a grid of icon toggle buttons (pressed state; the name, description and key in the tooltip, the name and key in a caption
 * under the grid), the Δ filter's modes an icon segmented control, the folds icon buttons; the lane colours and the line colours stay labelled lists. Each setting keeps its key and its palette command.
 */
export function LinesDisplay({ readable, prefs, setPrefs, laneKey, onFoldRepeats, repeatsBusy, delta, mute, onMute, onFoldAll, onUnfoldAll, canUnfold, hotUs, spanUs }: {
  readable: boolean
  prefs: LinesPrefs
  setPrefs(patch: Partial<LinesPrefs>): void
  /** what the lane colours mean in the chosen mode (null: nothing fixed, the statements are named by the overview) */
  laneKey: { color: string; label: string }[] | null
  onFoldRepeats(): void
  repeatsBusy: boolean
  delta: DeltaState
  /** the groups of lines that are dimmed */
  mute: ReadonlySet<string>
  onMute(name: string): void
  onFoldAll(what: 'binds' | 'stat'): void
  onUnfoldAll(): void
  canUnfold: boolean
  /** a hot spot's threshold (1 % of the traced time) and the traced time, µs */
  hotUs: number
  spanUs: number
}) {
  const mode = prefs.deltaMode
  return (
    <div className="ld">
      {readable && (
        <>
          <Section title="Colour the lanes by">
            <div className="ld-radios" role="radiogroup" aria-label="Colour the lanes by">
              {LANE_COLORS.map((c) => (
                <label key={c.id} className="ld-row" title={c.title}>
                  <input type="radio" name="lane-colour" checked={prefs.laneColor === c.id} onChange={() => setPrefs({ laneColor: c.id })} />
                  <span className="ld-lbl">{c.label}</span>
                </label>
              ))}
            </div>
            {laneKey && laneKey.length > 0 && (
              <ul className="ld-key" aria-label="What the lane colours mean">
                {laneKey.map((k) => <li key={k.label}><i className="lines-swatch" style={{ '--tone': k.color } as CSSProperties} />{k.label}</li>)}
              </ul>
            )}
            {prefs.laneColor === 'stmt' && <p className="ld-note">The statements and their colours are named by the picker above the rows.</p>}
          </Section>
          <Section title="Rows">
            <TogGrid label="What the rows show" togs={[
              { id: 'repeats', name: 'Fold repeats', keys: 'r', icon: RepeatIcon, on: prefs.foldRepeats, onClick: onFoldRepeats, busy: repeatsBusy,
                title: 'runs of 3 or more identical waits, wait blocks still long after that, and loops of 6 or more small fetches each fold into one line; click a fold\'s ▸ to open it' },
              { id: 'rddelta', name: 'Δ column', icon: PanelLeftIcon, on: prefs.rdDelta, onClick: () => setPrefs({ rdDelta: !prefs.rdDelta }),
                title: "the Δ column, first in the row: each line's time from the pinned line (a pins one), else the gap nothing explains after the line with a time before" },
            ]} />
          </Section>
        </>
      )}

      <Section title="Δ filter" note="rows whose Δ is at or above a threshold">
        <label className="ld-inline" title="Δ: the time from the timed line before (a call, wait, cursor parse or commit), whatever the pin says">
          <span>Δ ≥</span>
          <input type="number" min={0} step={1} value={prefs.deltaMs} aria-label="Δ threshold in milliseconds" onChange={(e) => setPrefs({ deltaMs: Math.max(0, Number(e.target.value) || 0) })}
            onKeyDown={(e) => { if (e.key === 'Enter' && mode === 'off') setPrefs({ deltaMode: 'highlight' }) }} />
          <span>ms</span>
        </label>
        <div className="ld-modes" role="radiogroup" aria-label="What to do with the rows">
          {DELTA_MODES.map((m) => {
            const Icon = MODE_ICONS[m.mode]
            return (
              <button key={m.mode} type="button" role="radio" className="ld-mode" aria-checked={mode === m.mode} aria-label={m.label} title={`${m.label}: ${m.title}`} onClick={() => setPrefs({ deltaMode: m.mode })}><Icon /></button>
            )
          })}
        </div>
        <p className="ld-note" aria-live="polite">
          {mode === 'off' ? "Δ is the time from the line with a time before: the line's own time plus any idle time before it."
            : delta.loading ? 'Finding the rows…'
            : delta.error ? <span className="lines-error">{delta.error}</span>
            : `${DELTA_MODES.find((m) => m.mode === mode)?.label}: ${fmtInt(delta.count ?? 0)} ${delta.count === 1 ? 'row' : 'rows'} with ${delta.what}${delta.truncated ? ' (the largest; more qualify)' : ''}`}
        </p>
      </Section>

      <Section title="Show">
        <TogGrid label="Show" togs={SHOW_TOGGLES.map((t) => ({ id: t.key, name: t.label, title: t.title, keys: t.keys, icon: SHOW_ICONS[t.key], on: prefs[t.key], onClick: () => setPrefs({ [t.key]: !prefs[t.key] }) }))} />
        <label className="ld-inline" title="a tick in the gutter and a hint for an idle gap of at least this many ms before a line; 0 turns them off (t / T step through them)">
          <span>Gap ticks from</span>
          <input type="number" min={0} step={10} value={prefs.gapMs} aria-label="Gap ticks from this many milliseconds, 0 for none" onChange={(e) => setPrefs({ gapMs: Math.max(0, Number(e.target.value) || 0) })} />
          <span>ms</span>
        </label>
      </Section>

      <Section title="Line colours" note="tick to dim">
        {COLOUR_ROWS.map((c) => {
          const swatch = <><i className="lines-swatch" style={{ '--tone': `var(${lineToneToken(c.kind)})` } as CSSProperties} />{c.label}</>
          return c.mute
            ? (
              <label key={c.label} className="ld-row" title={c.title ?? 'dim these rows (line counts and scrolling stay)'}>
                <input type="checkbox" checked={mute.has(c.mute)} onChange={() => onMute(c.mute!)} />
                <span className="ld-lbl">{swatch}</span>
              </label>
            )
            : <div key={c.label} className="ld-row ld-keyrow"><span /><span className="ld-lbl">{swatch}</span></div>
        })}
      </Section>

      <Section title="Folds">
        <div className="ld-folds" role="group" aria-label="Folds">
          <button type="button" className="quiet icon-btn" onClick={() => onFoldAll('binds')} aria-label="Fold all BINDS blocks" title="fold every BINDS block of the file"><VariableIcon /></button>
          <button type="button" className="quiet icon-btn" onClick={() => onFoldAll('stat')} aria-label="Fold all STAT dumps" title="fold every STAT dump of the file (the plans)"><TableIcon /></button>
          <button type="button" className="quiet icon-btn" onClick={onUnfoldAll} disabled={!canUnfold} aria-label="Unfold all" title="show the lines of every folded block (Z)"><UnfoldIcon /></button>
        </div>
      </Section>

      {readable && (
        <Section title="Key" note="what the formatted rows' colours and bars mean">
          <ul className="ld-legend">
            <li>
              <i className="ld-hot" aria-hidden="true" />
              <span><b>Red</b> row: a call or wait of {fmtDur(hotUs)} (1 % of the traced time) or more, a hot spot; idle waits never. <kbd>j</kbd> <kbd>J</kbd> step through them.</span>
            </li>
            <li>
              <span className="ld-bar" aria-hidden="true"><i /></span>
              <span><b>Duration bar</b>: the share of the traced time ({fmtDur(spanUs)}), log scale from 0.01 % to 100 %. The tick is 1 %: a bar past it is a hot spot.</span>
            </li>
            <li>
              <i className="ld-amber" aria-hidden="true">Δ</i>
              <span><b>Amber</b> Δ: a gap nothing explains of 1 ms or more, and at least twice the line before.</span>
            </li>
            <li>
              <i className="ld-lane" aria-hidden="true" />
              <span><b>Highlighted statement</b>: every line of its cursors tinted in its colour, the lane band stronger, and a bar at the start of its calls and waits. A statement that is not highlighted is grey.</span>
            </li>
          </ul>
        </Section>
      )}
    </div>
  )
}
