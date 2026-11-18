import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { TraceDoc } from '../data/doc'
import type { Execution } from '../data/derive'
import type { ExecTrace } from '../data/exectrace'
import { CallKind, type ID } from '../data/types'
import { sourceOf, useSourceQuery } from '../data/source'
import { fmtDur, fmtInt } from '../data/format'
import { replayOf, type Replay as ReplayData } from '../data/replay'
import { useStore } from '../state/session'
import { usePersisted } from '../state/persist'
import { Shimmer, prefersReducedMotion } from '../components/motion'
import { FIT_SECONDS, OBJECT_TOKENS, ReplayScene, TEMP_READ, TEMP_WRITE, describeSeg, readPalette } from './replayDraw'
import '../styles/loom.css' // --ev-* tokens
import '../styles/replay.css'

// The Plan replay (docs/PLAN-REPLAY.md, ARCHITECTURE § Plan replay): one picked execution played back on its STAT plan.
// data/replay.ts is the model and the layout, views/replayDraw.ts the canvas; this is the controls and the captions.

/** One picked execution of the statement inspector played back on its plan (over `executions/trace`, like the Dialogue). */
export function Replay({ doc, stmt, exec }: { doc: TraceDoc; stmt: ID; exec: Execution }) {
  const source = sourceOf(doc)
  // the Loom's key: one execution trace answer for the Loom, the Dialogue and the replay
  const q = useSourceQuery(source, `loom:${stmt}:${exec.cursor}:${exec.execNo}`, (signal) => source.executionTrace(stmt, exec, signal))
  if (q.error) return <p className="callout">Replay: {q.error}</p>
  if (q.data === undefined) return <p className="small muted"><Shimmer>Replay: loading…</Shimmer></p>
  if (q.data === null) {
    return (
      <p className="small muted rpl-na" role="status">
        {source.remote
          ? 'The replay needs the engine route api/executions/trace, which this engine does not serve: update mtkprof.'
          : 'The replay needs the calls and waits of the trace, which this report does not carry (written with -aggregate, or exported without facts).'}
      </p>
    )
  }
  if (!q.data.calls.some((c) => c.kind === CallKind.exec)) return <p className="small muted rpl-na" role="status">No calls of this execution in the trace.</p>
  return <ReplayView doc={doc} stmt={stmt} trace={q.data} />
}

const SPEEDS = [0.25, 1, 4] as const
const speedLabel = (v: number) => (v === 0.25 ? '¼×' : `${v}×`)

function ReplayView({ doc, stmt, trace }: { doc: TraceDoc; stmt: ID; trace: ExecTrace }) {
  const r = useMemo(() => replayOf(doc, stmt, trace), [doc, stmt, trace])
  const theme = useStore((s) => s.theme)
  const [scheme, setScheme] = useState(0)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const f = () => setScheme((n) => n + 1)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  const motion = useMemo(() => !prefersReducedMotion(), [])
  const [speed, setSpeed] = usePersisted<number>('mtkprof.replay.speed', 1)
  const [playing, setPlaying] = useState(motion)
  const [ended, setEnded] = useState(false)
  const [width, setWidth] = useState(0)

  const box = useRef<HTMLDivElement>(null)
  const stageCv = useRef<HTMLCanvasElement>(null)
  const lanesCv = useRef<HTMLCanvasElement>(null)
  const clockEl = useRef<HTMLSpanElement>(null)
  const chapNoEl = useRef<HTMLSpanElement>(null)
  const chapEl = useRef<HTMLSpanElement>(null)
  const nowEl = useRef<HTMLSpanElement>(null)
  const scene = useRef<ReplayScene | null>(null)
  // what the frame loop reads between renders; `stopped`: when playing stopped (flights and dots finish their way)
  const live = useRef({ playing, speed, visible: true, raf: 0, last: 0, chapter: -1, stopped: 0 })
  live.current.playing = playing
  live.current.speed = speed

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)))
    ro.observe(el)
    setWidth(Math.floor(el.clientWidth))
    const io = new IntersectionObserver(([e]) => { live.current.visible = e.isIntersecting; if (e.isIntersecting) kick() })
    io.observe(el)
    const vis = () => { live.current.visible = document.visibilityState === 'visible'; kick() }
    document.addEventListener('visibilitychange', vis)
    return () => { ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', vis); cancelAnimationFrame(live.current.raf); live.current.raf = 0 }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // another execution starts from the beginning and plays (unless motion is reduced)
  useEffect(() => { setPlaying(motion); setEnded(false); live.current.chapter = -1 }, [r, motion])

  // the scene: anew for another execution, width or theme; the clock stays when only the look changes
  useEffect(() => {
    if (!width || !stageCv.current || !lanesCv.current) return
    const keep = scene.current && scene.current.r === r ? scene.current.T : 0
    const dpr = window.devicePixelRatio || 1
    const s = new ReplayScene(r, readPalette(), motion, dpr)
    s.T = keep
    s.setWidth(width)
    scene.current = s
    for (const [cv, h] of [[stageCv.current, s.lay.height], [lanesCv.current, s.lanes.height]] as const) {
      cv.width = Math.round(width * dpr); cv.height = Math.round(h * dpr); cv.style.height = `${h}px`
    }
    live.current.chapter = -1
    kick()
  }, [r, width, theme, scheme, motion]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!playing) live.current.stopped = performance.now(); kick() }, [playing]) // eslint-disable-line react-hooks/exhaustive-deps

  function kick() {
    if (!live.current.raf) { live.current.last = 0; live.current.raf = requestAnimationFrame(frame) }
  }
  function frame(now: number) {
    live.current.raf = 0
    const s = scene.current, sc = stageCv.current?.getContext('2d'), lc = lanesCv.current?.getContext('2d')
    if (!s || !sc || !lc) return
    const L = live.current
    const dt = L.last ? Math.min(0.1, (now - L.last) / 1000) : 0
    L.last = now
    const run = L.playing && L.visible
    if (run && s.T < s.r.D) {
      s.advance(s.T + dt * (s.r.D / FIT_SECONDS) * L.speed, now)
      if (s.T >= s.r.D) { setPlaying(false); setEnded(true) }
    }
    s.drawStage(sc, now, run)
    s.drawLanes(lc)
    captions(s)
    // keep going while playing, and a little after (flights and dots still on their way)
    if (run || (motion && now - L.stopped < 1200)) L.raf = requestAnimationFrame(frame)
  }

  function captions(s: ReplayScene) {
    if (clockEl.current) clockEl.current.textContent = `${fmtDur(s.T)} / ${fmtDur(s.r.D)}`
    const ch = s.r.chapterAt(s.T)
    if (ch.i !== live.current.chapter) {
      live.current.chapter = ch.i
      if (chapNoEl.current) chapNoEl.current.textContent = `chapter ${ch.i + 1} of ${s.r.chapters.length}`
      if (chapEl.current) chapEl.current.textContent = `${fmtDur(ch.a)} – ${fmtDur(ch.b)} · ${ch.label}`
    }
    if (nowEl.current) nowEl.current.textContent = describeSeg(s.r, s.r.segAt(s.T), s.T)
  }

  const seek = (t: number) => {
    const s = scene.current
    if (!s) return
    s.seek(t)
    setEnded(s.T >= s.r.D)
    kick()
  }
  const togglePlay = () => {
    const s = scene.current
    if (s && (ended || s.T >= s.r.D)) { s.seek(0); setEnded(false); setPlaying(true); return }
    setPlaying((p) => !p)
  }
  const prevChapter = () => {
    const s = scene.current
    if (!s) return
    const ch = s.r.chapterAt(s.T)
    seek(s.T - ch.a > s.r.D * 0.02 || ch.i === 0 ? ch.a : s.r.chapters[ch.i - 1].a)
  }
  const nextChapter = () => {
    const s = scene.current
    if (!s) return
    const ch = s.r.chapterAt(s.T)
    if (ch.i < s.r.chapters.length - 1) seek(s.r.chapters[ch.i + 1].a)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === ' ') { e.preventDefault(); togglePlay() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevChapter() }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nextChapter() }
  }
  const dragging = useRef(false)
  const laneSeek = (e: PointerEvent<HTMLCanvasElement>) => {
    const s = scene.current
    if (!s) return
    seek(s.timeAtX(e.clientX - e.currentTarget.getBoundingClientRect().left))
  }

  const legend = useMemo(() => legendOf(r), [r])
  const label = `Plan replay: ${r.lines.length} plan lines, ${fmtDur(r.D)} from the EXEC to the last FETCH, ${r.chapters.length} chapter${r.chapters.length === 1 ? '' : 's'}`

  return (
    <div className="rpl" ref={box}>
      <div className="rpl-bar">
        <button type="button" className="quiet" onClick={prevChapter} title="previous chapter (←)" aria-label="Previous chapter">⏮</button>
        <button type="button" className="quiet rpl-play" onClick={togglePlay} title="play / pause (space)" aria-label={playing ? 'Pause' : ended ? 'Play again' : 'Play'}>{playing ? '❚❚' : ended ? '↺' : '▶'}</button>
        <button type="button" className="quiet" onClick={nextChapter} title="next chapter (→)" aria-label="Next chapter">⏭</button>
        <span className="seg" role="group" aria-label="Speed">
          {SPEEDS.map((v) => <button key={v} type="button" aria-pressed={speed === v} onClick={() => setSpeed(v)} title={`the execution in ${Math.round(FIT_SECONDS / v)} s`}>{speedLabel(v)}</button>)}
        </span>
        <span className="rpl-clock mono" ref={clockEl} />
        {r.parseUs > 0 && <span className="small muted">PARSE before it: {fmtDur(r.parseUs)}</span>}
      </div>
      <div className="rpl-stage" tabIndex={0} onKeyDown={onKey} role="img" aria-label={label}>
        <canvas ref={stageCv} />
      </div>
      <div className="rpl-cap">
        <span className="rpl-k" ref={chapNoEl} /><span className="rpl-v rpl-chap" ref={chapEl} />
        <span className="rpl-k">now</span><span className="rpl-v rpl-now" ref={nowEl} />
      </div>
      <canvas ref={lanesCv} className="rpl-lanes" aria-label="Lanes: CPU, the waits of each plan line, the client; click or drag to move the playhead"
        onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); laneSeek(e) }}
        onPointerMove={(e) => { if (dragging.current) laneSeek(e) }}
        onPointerUp={() => { dragging.current = false }} />
      <div className="rpl-legend">
        {legend.map(([token, text]) => <span key={text}><i className="rpl-key" style={{ background: `var(${token})` }} />{text}</span>)}
      </div>
      {!r.root && <p className="small muted rpl-na">No row source statistics (STAT lines) for this execution's plan in the trace: the lanes only.</p>}
      {r.root && !r.match.exact && (
        <p className="small muted rpl-na">The STAT lines are from {r.match.fromExecNo ? `execution #${r.match.fromExecNo}` : 'another execution'} of this plan (with plan_stat=first_execution, the default, they are written once per cursor): the plan's rows are not shown, the waits are this execution's.</p>
      )}
      {r.px && <p className="small muted rpl-na">A PX coordinator: its slaves' work is in other sessions of the trace set and is not replayed here.</p>}
      {r.truncated && <p className="small muted rpl-na">The execution trace was cut at its limit: the replay ends where its rows end.</p>}
      <p className="small muted rpl-note">
        <b>From the trace:</b> the waits (event, time, obj#, file, block), the calls, the rows of each fetch, the STAT totals.{' '}
        <b>Inferred</b> (≈): the plan line of a wait (its obj#; TEMP I/O goes to the line that wrote to TEMP), the rows of a line
        before its end (in step with the blocks it read, or after its input for a sort), and the lines on CPU between two waits
        (the lines between them; in a call without waits, the lines by their share of STAT self time).
      </p>
    </div>
  )
}

/** The legend: the objects that were read, TEMP, CPU, the client and the network, other waits; only what occurs. */
function legendOf(r: ReplayData): [string, string][] {
  const out: [string, string][] = []
  const read = new Set(r.waits.filter((w) => w.kind === 'read' && w.line).map((w) => w.line!.objSlot))
  r.objects.forEach((o, i) => { if (read.has(i)) out.push([OBJECT_TOKENS[i % OBJECT_TOKENS.length], `${o.name} blocks`]) })
  if (r.waits.some((w) => w.kind === 'twrite')) out.push([TEMP_WRITE, 'TEMP write'])
  if (r.waits.some((w) => w.kind === 'tread')) out.push([TEMP_READ, 'TEMP read'])
  out.push(['--c-cpu', 'CPU (in a call, not waiting)'])
  if (r.waits.some((w) => w.kind === 'client')) out.push(['--c-idle', 'client time (SQL*Net message from client)'])
  out.push(['--ink', `fetches${r.fetchRows ? ` (${fmtInt(r.fetchRows)} row${r.fetchRows === 1 ? '' : 's'})` : ''}`])
  if (r.waits.some((w) => w.kind === 'other' || w.kind === 'pxwait' || (w.kind === 'read' && !w.line)) || r.segs.some((s) => s.type === 'recursive')) out.push(['--c-other', 'other waits, recursive SQL'])
  return out
}
