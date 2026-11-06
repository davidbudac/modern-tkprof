// ---- the chrome above the rows: toolbar, breadcrumb, the "where the time went" bar, the statement chips; the strip and status bar ---
// o.chrome = { hl: sqlid, sel: line, wrap: bool, ... }; NOW draws the app's, PROPOSED (o.p10) section 10's.

const TOP8 = ['52nzchs09dgn1', '4w3wvjbkvq24v', 'c7ry5gr75qv4b', '7r10y07tqpg98', 'dcxgz5g2j9ts2', 'dk21j71dpu26c', 'f9xbak7zf0a4a', '64y0jakbjfvm9']
// where each statement ran, as fractions of the file's time span (the track is the calls' spans; the slivers are the small statements)
const TRACK = [
  ['c7ry5gr75qv4b', 0.0001, 0.0988], ['4w3wvjbkvq24v', 0.0997, 0.4643], ['64y0jakbjfvm9', 0.4643, 0.4669], ['dk21j71dpu26c', 0.4669, 0.4694],
  ['f9xbak7zf0a4a', 0.4694, 0.4732], ['52nzchs09dgn1', 0.4732, 0.9073], ['7r10y07tqpg98', 0.9073, 1.0],
]
const T_FIRST = 10804499034
const fracOfTim = (tim) => (tim - T_FIRST) / SPAN_US
const fracOfT = (t) => fracOfTim(TIM0 + (t - T0))
const pctOf = (sid) => Math.round((100 * (DATA.extra.stmtE[sid]?.e || 0)) / SPAN_US)
const eOf = (sid) => DATA.extra.stmtE[sid].e

const PANEL_ICON = '<svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true" class="tb-ico"><rect x="0.5" y="0.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/><line x1="8.5" y1="1" x2="8.5" y2="11" stroke="currentColor"/></svg>'
const RAW_ICON = '<svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><path d="M1 2h12M1 6h9M1 10h11" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>'
const FMT_ICON = '<svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><path d="M1 1v10" stroke="currentColor" stroke-width="2.2"/><path d="M4.5 2h3M9.5 2h3.5M4.5 6h3M9.5 6h2M4.5 10h3M9.5 10h3" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>'
const cue = '<span class="cue" aria-hidden="true">▾</span>'

function toolbarNow(c) {
  const hl = c.hl, s = c.stats
  return `<div class="lines-bar"><div class="lines-row${c.wrap ? ' wrap' : ' nowrap'}">
    <span class="lines-mode"><button class="mode">${RAW_ICON}Raw</button><button class="mode on">${FMT_ICON}Formatted</button><kbd>v</kbd></span>
    <span class="lines-rd"><button class="quiet">Fold repeats</button><button class="quiet pressed">Δ</button><button class="quiet">Hot spot ↓<small> 6</small></button></span>
    <span class="lines-hl" style="--hl:${laneColor(hl)}"><i></i>Highlighting <a class="link mono">${hl}</a><small>${s.callsNow} calls · ${s.wnow} waits</small><button class="quiet">×</button></span>
    <span class="lines-search"><input value="" placeholder="Search the trace text" aria-label="Search"><button class="quiet">Options ${cue}</button></span>
    <button class="quiet">Step ${cue}</button>
    <button class="quiet tb-cmd"><span class="tb-label">Go to or run a command</span><kbd>⌘K</kbd></button>
    <button class="quiet">View ${cue}</button>
    ${c.wrap ? '<span class="wrap-break"></span>' : ''}<button class="quiet tb-panel">${PANEL_ICON}</button>
  </div></div>`
}

function toolbarProposed(c) {
  return `<div class="lines-bar"><div class="lines-row nowrap">
    <span class="lines-mode"><button class="mode">${RAW_ICON}Raw</button><button class="mode on">${FMT_ICON}Formatted</button></span>
    <span class="lines-rd"><button class="quiet">Fold repeats</button><button class="quiet pressed">Δ</button><button class="quiet">Hot spot ↓<small> 6</small></button></span>
    <span class="lines-search"><input value="" placeholder="Search the trace text" aria-label="Search"><button class="quiet">Options ${cue}</button></span>
    <button class="quiet">Step ${cue}</button>
    <button class="quiet tb-cmd"><kbd>⌘K</kbd></button>
    <button class="quiet">View ${cue}</button>
    <button class="quiet tb-panel">${PANEL_ICON}</button>
  </div></div>`
}

function breadcrumb(c) {
  const sid = c.hl
  const text = { c7ry5gr75qv4b: 'select /*+ full(o) mtk_full_scan_orders */ cou…', '52nzchs09dgn1': 'select /*+ mtk_sort_spill */ o.id, o.cust_id, …' }[sid]
  const fact = { c7ry5gr75qv4b: '1 exec · 638 ms', '52nzchs09dgn1': '1 exec · 2.486 s' }[sid]
  const ev = { 118: 'direct path read', 10378: 'direct path read temp' }[c.sel]
  return `<div class="lines-at"><div class="lines-crumbs">
    <a class="link">51.14688</a><span class="crumb-sep">›</span><a class="link mono">${sid}</a><span class="lines-sql">${esc(text)}</span>
    <span class="crumb-fact">${fact}</span><span class="crumb-sep">›</span><span>exec 1</span><span class="crumb-sep">›</span><span class="lines-kind-t">WAIT</span><span>line ${fmtInt(c.sel)}</span><a class="link">${ev}</a></div>
    <button class="quiet">Actions ${cue}</button></div>`
}

function trackSvg(c, h) {
  let rects = TRACK.map(([sid, a, b]) => `<rect x="${(a * 1000).toFixed(2)}" y="0" width="${Math.max(0.6, (b - a) * 1000).toFixed(2)}" height="10" style="fill:${laneColor(sid)}"/>`).join('')
  const at = c.selT !== undefined ? fracOfT(c.selT) : null
  if (at !== null) rects += `<rect class="rd-track-at" x="${(at * 1000 - 0.75).toFixed(2)}" y="0" width="1.5" height="10"/>`
  return rects
}

function chipsNow(c) {
  return `<div class="rd-chips">` + TOP8.map((sid) => {
    const on = sid === c.hl
    return `<button class="quiet rd-chip-st${on ? ' pressed' : ''}" style="--chip:${laneColor(sid)}"><i style="background:${laneColor(sid)}"></i><span class="mono">${sid}</span><small>${pctOf(sid)}%</small></button>`
  }).join('') + `</div>`
}
function overviewNow(c) {
  return `<div class="rd-over"><svg class="rd-track" viewBox="0 0 1000 10" preserveAspectRatio="none">${trackSvg(c)}</svg>${chipsNow(c)}</div>`
}

/** PROPOSED: a labelled 12 px bar, a thin time axis, a viewport bracket; chips with their time; the small ones folded into one. */
function overviewProposed(c) {
  const t0 = clockToUs('11:35:29.191045') + CLOCK_FIX_US
  const axis = [30, 31, 32, 33, 34, 35].map((s) => { const us = ((11 * 60 + 35) * 60 + s) * 1e6; const f = (us - t0) / SPAN_US; return `<span class="ax" style="left:${(f * 100).toFixed(3)}%"><i></i>11:35:${s}</span>` }).join('')
  const vp = c.view ? `<span class="vbracket" style="left:${(c.view[0] * 100).toFixed(3)}%;width:max(6px, ${((c.view[1] - c.view[0]) * 100).toFixed(3)}%)"></span>` : ''
  const at = c.selT !== undefined ? `<span class="at" style="left:${(fracOfT(c.selT) * 100).toFixed(3)}%"></span>` : ''
  const segs = TRACK.map(([sid, a, b]) => `<span class="seg" style="left:${(a * 100).toFixed(3)}%;width:max(2px, ${((b - a) * 100).toFixed(3)}%);background:${laneColor(sid)}"></span>`).join('')
  const big = TOP8.filter((sid) => (100 * eOf(sid)) / SPAN_US >= 1)
  const small = TOP8.length - big.length
  const chips = big.map((sid) => {
    const on = sid === c.hl
    const extra = on ? `<small class="cnt">${c.stats.calls} calls · ${c.stats.waits} waits</small><span class="x" aria-label="Stop highlighting">×</span>` : ''
    return `<span class="chip chip-stmt${on ? ' on' : ''}" style="--chip:${laneColor(sid)}"><i style="background:${laneColor(sid)}"></i><span class="mono">${sid}</span><small>${fmtDur(eOf(sid))} · ${pctOf(sid)} %</small>${extra}</span>`
  }).join('') + `<span class="chip chip-fold"><small>+${small} under 1 %</small></span>`
  return `<div class="rd-over"><div class="time-bar"><span class="tb-label">Where the time went · ${(SPAN_US / 1e6).toFixed(2)} s</span><div class="tb-main"><div class="tb-track">${segs}${vp}${at}</div><div class="tb-axis">${axis}</div></div></div><div class="rd-chips">${chips}</div></div>`
}

function chromeHtml(o) {
  const c = o.chrome
  return (o.p10 ? toolbarProposed(c) : toolbarNow(c)) + breadcrumb(c) + (o.p10 ? overviewProposed(c) : overviewNow(c))
}

// ---- the density strip and the status bar ------------------------------------------------------------------------------------------
const FILE_LINES = 16428
function stripHtml(o) {
  const c = o.chrome || {}
  const spans = [['c7ry5gr75qv4b', 84, 254], ['4w3wvjbkvq24v', 255, 317], ['64y0jakbjfvm9', 448, 762], ['dk21j71dpu26c', 792, 3798], ['f9xbak7zf0a4a', 3799, 6810], ['52nzchs09dgn1', 6878, 10443], ['7r10y07tqpg98', 10444, 16423]]
  const hl = c.hl || o.hl
  const bars = spans.map(([sid, a, b]) => `<i style="top:${((a / FILE_LINES) * 100).toFixed(3)}%;height:max(2px, ${(((b - a) / FILE_LINES) * 100).toFixed(3)}%);background:${laneColor(sid)};opacity:${sid === hl ? 1 : 0.45};inset-inline:${sid === hl ? '1px 7px' : '7px 1px'}"></i>`).join('')
  const vr = o.viewLines || [o.sel || 1, (o.sel || 1) + 40]
  const vp = `<span class="vp" style="top:${((vr[0] / FILE_LINES) * 100).toFixed(3)}%;height:max(6px, ${(((vr[1] - vr[0]) / FILE_LINES) * 100).toFixed(3)}%)"></span>`
  return `<div class="strip">${bars}${vp}</div>`
}
function statusHtml(o) {
  return `<div class="lines-status-bar"><span class="mono">${fmtInt(o.sel)} / ${fmtInt(FILE_LINES)}</span><a class="link">← back to line ${o.back}</a></div>`
}
