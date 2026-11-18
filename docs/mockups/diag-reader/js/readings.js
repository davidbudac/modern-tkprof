// The readings (level 2): each function takes the reading's data from the model and returns HTML. Every number comes from the parser.
const lnk = (ln, text) => (isLoaded(ln)
  ? `<button type="button" class="lnk" data-go="${ln}" title="Go to line ${fmtN(ln)} in the text">${text ?? 'line ' + fmtN(ln)}</button>`
  : `<span class="lnk off" title="Line ${fmtN(ln)} is not loaded in this mock-up">${text ?? 'line ' + fmtN(ln)}</span>`)
const dash = '<span class="x-dim">-</span>'

function bar(share, cls = '') { return `<span class="bar ${cls}"><i style="inline-size:${Math.max(0, Math.min(100, share * 100)).toFixed(2)}%"></i></span>` }
function pct(x) { return x >= 0.1 ? (x * 100).toFixed(1) + '%' : x >= 0.001 ? (x * 100).toFixed(2) + '%' : x > 0 ? '<0.1%' : '0%' }
function kvRow(k, v) { return v === undefined || v === null || v === '' ? '' : `<dt>${k}</dt><dd>${v}</dd>` }

// ---- reading: the call stack -----------------------------------------------------------------------------------------------------------------
function readCallstack() {
  const R = M.readings.callstack
  const own = R.frames.filter((f) => f.own)
  const rest = R.frames.filter((f) => !f.own)
  const withOwn = S.incOwn
  const one = (withOwn ? R.frames : rest).map((f) => `${f.fn}()+${f.off}`).join('<-')
  const nOwn = own.length
  const ownLabel = own.length ? `${own[0].fn} … ${own[own.length - 1].fn}` : ''
  let frames = ''
  const row = (f) => `<tr class="${f.own ? 'own' : ''}"><td class="num dim">${f.n}</td><td class="mono fn">${esc(f.fn)}<span class="x-dim">()</span></td><td class="num dim mono">+${fmtN(f.off)}</td><td class="num">${lnk(f.line, fmtN(f.line))}</td></tr>`
  if (own.length) {
    frames += `<tr class="own-fold"><td></td><td colspan="3"><button type="button" class="foldrow" data-own-toggle="1" aria-expanded="${S.ownOpen}"><span class="tw">${S.ownOpen ? '▾' : '▸'}</span> <b>${nOwn}</b> frames of the dump itself <span class="x-dim mono">${esc(ownLabel)}</span></button></td></tr>`
    if (S.ownOpen) frames += own.map(row).join('')
  }
  frames += rest.map(row).join('')
  const plsql = (R.plsql || []).map((p, k) => `<tr><td class="num dim">${k + 1}</td><td class="mono">${esc(p.obj)}</td><td class="num">${p.line}</td><td class="mono dim">${esc(p.handle)}</td><td class="num">${lnk(p.at, fmtN(p.at))}</td></tr>`).join('')
  const err = R.ora && R.ora.length ? R.ora.map((o) => `<div class="mono">${esc(o.text)} ${lnk(o.line)}</div>`).join('') : `<span class="dim">No ORA- error in this dump: it was taken on request (level ${R.dumpLevel}), not on an error.</span>`
  return `<div class="rd">
    <header class="rd-head"><h3>Call stack</h3><span class="rd-meta">diagnostic dump level ${R.dumpLevel} · ${lnk(R.dumpLine, 'line ' + fmtN(R.dumpLine))} · ${R.frames.length} frames</span></header>
    <section class="rd-sec"><div class="rd-k">Error</div><div class="rd-p">${err}</div><div class="rd-p dim mono" title="the Error Stack Dump section's own line">${esc(R.barrier || '')} ${R.barrierLine ? lnk(R.barrierLine) : ''}</div></section>
    <section class="rd-sec"><div class="rd-k">Statement <span class="x-dim">(Current SQL Statement for this session)</span></div>
      <div class="rd-p"><span class="mono strong">${esc(R.sql.id)}</span> ${lnk(R.sql.line - 1, 'line ' + fmtN(R.sql.line - 1))}</div>
      <pre class="code">${esc(R.sql.text)}</pre></section>
    <section class="rd-sec"><div class="rd-k">PL/SQL call stack <span class="x-dim">(innermost first)</span></div>
      <table class="tbl plsql"><thead><tr><th class="num">#</th><th>Object</th><th class="num">Line</th><th>Handle</th><th class="num">At</th></tr></thead><tbody>${plsql}</tbody></table></section>
    <section class="rd-sec"><div class="rd-k">The stack as one line <span class="x-dim">(the form oradebug short_stack prints)</span></div>
      <div class="oneline"><code id="oneline" class="mono">${esc(one).replace(/&lt;-/g, '&lt;-<wbr>')}</code></div>
      <div class="rd-actions"><button type="button" class="quiet" data-copy="oneline">Copy</button>
        <label class="chk-l"><input type="checkbox" data-own="1" ${withOwn ? 'checked' : ''}> include the dump's own frames</label>
        <span class="dim">${(withOwn ? R.frames : rest).length} frames</span></div></section>
    <section class="rd-sec"><div class="rd-k">Frames <span class="x-dim">(innermost first, from the binary stack dump's frame headers)</span></div>
      <table class="tbl frames"><thead><tr><th class="num">#</th><th>Function</th><th class="num">Offset</th><th class="num">Line</th></tr></thead><tbody>${frames}</tbody></table></section>
  </div>`
}

// ---- reading: a process / session ------------------------------------------------------------------------------------------------------------
function readProcess(key) {
  const P = M.readings[key]
  if (!P) return noReading('No reading for this process in this mock-up.')
  const w = P.wait
  let wait = '<span class="dim">no current wait recorded</span>'
  if (w && w.none) wait = `<b>Not in wait</b> <span class="dim">· last wait ended ${fmtS(w.ago)} ago</span> ${lnk(w.line)}`
  else if (w && w.event) wait = `<b>Waiting for</b> <span class="mono">'${esc(w.event)}'</span> <span class="dim">· ${fmtS(w.total)} so far</span> ${lnk(w.line)}${w.params.length ? `<div class="params mono dim">${w.params.map(esc).join('<br>')}</div>` : ''}`
  let blockers = ''
  if (P.directBlocker) blockers += `<div>Blocked by <span class="mono strong">${P.directBlocker.sid}.${P.directBlocker.ser}</span> ${lnk(P.directBlocker.line)}${P.finalBlocker && (P.finalBlocker.sid !== P.directBlocker.sid) ? `, final blocker <span class="mono strong">${P.finalBlocker.sid}.${P.finalBlocker.ser}</span>` : P.finalBlocker ? ' (also the final blocker)' : ''}</div>`
  if (P.blocks) blockers += `<div>Blocks <b>${P.blocks}</b> session${P.blocks === 1 ? '' : 's'} ${lnk(P.blocksLine)}${P.waiter ? `: <span class="mono">${P.waiter.sid}.${P.waiter.ser}</span> waits for '${esc(P.waiter.event)}'${P.waiter.obj ? `, row ${P.waiter.obj.row} of block ${fmtN(P.waiter.obj.block)} in file ${P.waiter.obj.file}` : ''}${P.waiter.blockedSecs !== null ? `, ${P.waiter.blockedSecs} s` : ''}` : ''}</div>`
  const hist = (P.history || []).slice(0, 10).map((h) => `<li><span class="num dim">${h.n}</span><span class="mono ev">${esc(h.event)}</span><span class="num">${fmtS(h.total)}</span></li>`).join('')
  const holds = Object.values(P.holds || {}).filter((h) => h.type !== 'process' && h.type !== 'session').sort((a, b) => b.count - a.count)
  const holdRows = holds.map((h) => {
    const modes = Object.keys(h.modes).length ? Object.entries(h.modes).sort((a, b) => b[1] - a[1]).map(([m, n]) => `mode ${m} × ${n}`).join(', ') : ''
    let detail = modes
    if (h.type === 'enqueue') detail = (h.names || []).map(esc).join('<br>')
    else if (h.type === 'LIBRARY OBJECT PIN') detail = (h.names || []).map((n) => esc(n)).join(', ') + (modes ? `<span class="dim"> · ${modes}</span>` : '')
    else if (h.type === 'LIBRARY OBJECT LOCK') detail = `${modes}`
    return `<tr><td class="mono">${esc(h.type)} <span class="dim">(${h.no})</span></td><td class="num">${fmtN(h.count)}</td><td>${detail}</td></tr>`
  }).join('')
  const who = [
    kvRow('Session', `<span class="mono strong">${P.sid}.${P.ser}</span> ${P.user ? esc(P.user) : ''}${P.pdb ? ` <span class="dim">in ${esc(P.pdb)}</span>` : ''}`),
    kvRow('Program', esc(P.program || '') + (P.machine ? ` <span class="dim">on ${esc(P.machine)}</span>` : '')),
    kvRow('Module / action', P.module || P.action ? `${esc(P.module || '')} <span class="dim">/</span> ${esc(P.action || '')}` : ''),
    kvRow('Process', `Oracle pid ${P.pid ?? ''}${P.pser !== undefined ? ', ser ' + P.pser : ''} · server ospid ${P.ospid ?? ''}${P.clientOspid ? ` · client ospid ${P.clientOspid}` : ''}${P.service ? ` · service ${esc(P.service)}` : ''}`),
  ].join('')
  const cs = key === 'proc:p0' ? M.readings.callstack : null
  let runs = ''
  if (P.sql) runs += `<div class="rd-p"><span class="dim">Top-level call</span> ${P.sqlId ? `<span class="mono strong">${esc(P.sqlId)}</span>` : ''}${P.sqlLine ? ' ' + lnk(P.sqlLine) : ''}</div><pre class="code">${esc(P.sql)}</pre>`
  if (cs && cs.sql && cs.sql.text !== P.sql) runs += `<div class="rd-p"><span class="dim">Executing now (the dump's Current SQL Statement)</span> <span class="mono strong">${esc(cs.sql.id)}</span> ${lnk(cs.sql.line - 1)}</div><pre class="code">${esc(cs.sql.text)}</pre>`
  if (!runs) runs = '<div class="rd-p dim">No statement found for this session in the loaded text.</div>'
  return `<div class="rd">
    <header class="rd-head"><h3>Process <span class="mono">${P.pid ?? ''}</span> · session <span class="mono">${P.sid}.${P.ser}</span></h3><span class="rd-meta">${P.soTotal !== undefined ? fmtN(P.soTotal) + ' state objects · ' : ''}lines ${lnk(P.lines[0], fmtN(P.lines[0]))}–${fmtN(P.lines[1])}, session at ${lnk(P.sessLine, fmtN(P.sessLine))}</span></header>
    <section class="rd-sec"><div class="rd-k">Who</div><dl class="kv">${who}</dl></section>
    <section class="rd-sec"><div class="rd-k">Runs</div>${runs}</section>
    <section class="rd-sec"><div class="rd-k">Waits</div><div class="rd-p">${wait}</div>${blockers ? `<div class="rd-p">${blockers}</div>` : ''}</section>
    <section class="rd-sec"><div class="rd-k">Holds <span class="x-dim">(state objects under the process, by type)</span></div>
      <table class="tbl holds"><thead><tr><th>Type</th><th class="num">Count</th><th>Detail</th></tr></thead><tbody>${holdRows}</tbody></table></section>
    ${hist ? `<section class="rd-sec"><div class="rd-k">Wait history <span class="x-dim">(latest first; waited, from the dump's Session Wait History${P.historyElapsed !== undefined ? `, ${fmtS(P.historyElapsed)} since the last wait` : ''})</span></div><ol class="wh">${hist}</ol></section>` : ''}
  </div>`
}

function noReading(msg) { return `<div class="rd"><div class="rd-empty">${esc(msg || 'No reading for this kind of section.')}</div></div>` }

// ---- reading: a heap ---------------------------------------------------------------------------------------------------------------------------
function heapById(id) { return M.readings.heaps.find((h) => h.id === id) }
function heapCheck(h) {
  const c = h.check
  if (!c.chunks) return `<div class="chk none"><div>Nothing to check: this heap header prints no totals${h.headerOnly ? ' (a header without extents)' : ''}.</div></div>`
  const one = (x, what, total, line) => {
    if (!x) return `<div>No ${total} line printed, so ${what} is not checked.</div>`
    if (x.ok) return `<div>${what} sum to <b>${fmtN(x.sum)}</b> bytes: matches the dump's ${total}. ${lnk(line, fmtN(line))}</div>`
    const d = x.sum - x.total
    return `<div class="bad-l">${what} sum to <b>${fmtN(x.sum)}</b> bytes: the dump's ${total} says ${fmtN(x.total)}, a difference of ${d > 0 ? '+' : ''}${fmtN(d)}. ${lnk(line, fmtN(line))}</div>`
  }
  const all = [c.chunks, c.free, c.perm].every((x) => !x || x.ok)
  return `<div class="chk ${all ? 'ok' : 'bad'}">
    ${one(c.chunks, 'Chunks', 'Total heap size', h.lines.totalHeap)}
    ${one(c.free, 'Free-list chunks', 'Total free space', h.lines.totalFree)}
    ${one(c.perm, 'Permanent chunks', 'Permanent space', h.lines.permSpace)}
  </div>`
}
function heapTree(h) {
  const hs = M.readings.heaps.filter((x) => x.run === h.run)
  const kids = new Map()
  for (const x of hs) { const p = x.parent || ''; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(x) }
  const out = []
  const top = Math.max(1, ...hs.map((x) => x.total || 0))
  const go = (x, d) => {
    out.push(`<li><button type="button" class="tn${x.id === h.id ? ' on' : ''}" data-heap="${x.id}" style="--d:${d}" title="${esc(x.name)} · desc 0x${x.desc} · lines ${fmtN(x.from)}-${fmtN(x.to)}"><span class="tn-name mono">${esc(x.name)}</span><span class="tn-n">${x.total !== null ? fmtN(x.total) : ''}</span></button></li>`)
    for (const c of kids.get(x.id) || []) go(c, d + 1)
  }
  const roots = hs.filter((x) => !x.parent)
  for (const r of roots) go(r, 0)
  const run = M.readings.runs[h.run]
  return `<ul class="tree">${out.join('')}</ul>`
}
function sortRows(rows, st) {
  const { col, dir } = st
  return rows.slice().sort((a, b) => {
    const x = a[col], y = b[col]
    if (typeof x === 'string' || typeof y === 'string') return dir * String(x ?? '').localeCompare(String(y ?? ''))
    return dir * ((x ?? -1) - (y ?? -1)) || String(a.key).localeCompare(String(b.key))
  })
}
function th(label, col, st, cls = '') {
  const on = st.col === col
  return `<th class="${cls} sortable" aria-sort="${on ? (st.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${col}">${label}<span class="sx">${on ? (st.dir > 0 ? '▲' : '▼') : ''}</span></button></th>`
}
function readHeap(id) {
  const h = heapById(id)
  if (!h) return noReading()
  const tab = S.heapTab
  const tot = h.total ?? h.byComment.reduce((s, c) => s + c.bytes, 0)
  const ch = S.chunk && S.chunk.heap === h.id ? S.chunk : null
  let table = ''
  if (tab === 'comment') {
    const st = S.sort.comment
    const rows = sortRows(h.byComment.map((c) => ({ key: c.c, c: c.c, chunks: c.chunks, bytes: c.bytes, share: c.bytes / tot, types: c.types })), st)
    const maxShare = Math.max(0.0001, ...rows.map((r) => r.share))
    const body = rows.map((r) => {
      const ty = Object.entries(r.types).sort((a, b) => b[1] - a[1])
      const tyS = ty.length === 1 ? ty[0][0] : `${ty[0][0]} +${ty.length - 1}`
      return `<tr class="sel-row${ch && ch.key === 'c:' + r.key ? ' on' : ''}" data-hrow="c:${esc(r.key)}" title="${esc(ty.map(([t, n]) => t + ' ' + n).join(', '))}"><td class="mono cm">${r.c ? esc(r.c) : '<span class="x-dim">(no comment)</span>'}</td><td class="dim ty">${esc(tyS)}</td><td class="num">${fmtN(r.chunks)}</td><td class="num">${fmtN(r.bytes)}</td><td class="num">${pct(r.share)}</td><td class="bc">${bar(r.share / maxShare)}</td></tr>`
    }).join('')
    table = `<table class="tbl heaptbl"><thead><tr>${th('Comment', 'c', st)}<th class="ty">Type</th>${th('Chunks', 'chunks', st, 'num')}${th('Bytes', 'bytes', st, 'num')}${th('Share', 'share', st, 'num')}<th class="bc"></th></tr></thead><tbody>${body}</tbody>
      <tfoot><tr><td>${fmtN(h.byComment.length)} comments</td><td class="ty"></td><td class="num">${fmtN(h.chunks)}</td><td class="num">${fmtN(h.byComment.reduce((s, c) => s + c.bytes, 0))}</td><td class="num">100%</td><td></td></tr></tfoot></table>`
  } else if (tab === 'type') {
    const st = S.sort.type
    const rows = sortRows(h.byType.map((t) => ({ key: t.t, t: t.t, chunks: t.chunks, bytes: t.bytes, share: t.bytes / tot })), st)
    const maxShare = Math.max(0.0001, ...rows.map((r) => r.share))
    const body = rows.map((r) => `<tr class="sel-row${ch && ch.key === 't:' + r.key ? ' on' : ''}" data-hrow="t:${esc(r.key)}"><td class="mono cm">${esc(r.t)}</td><td class="num">${fmtN(r.chunks)}</td><td class="num">${fmtN(r.bytes)}</td><td class="num">${pct(r.share)}</td><td class="bc">${bar(r.share / maxShare)}</td></tr>`).join('')
    table = `<table class="tbl heaptbl"><thead><tr>${th('Type', 't', st)}${th('Chunks', 'chunks', st, 'num')}${th('Bytes', 'bytes', st, 'num')}${th('Share', 'share', st, 'num')}<th class="bc"></th></tr></thead><tbody>${body}</tbody>
      <tfoot><tr><td>${h.byType.length} types</td><td class="num">${fmtN(h.chunks)}</td><td class="num">${fmtN(h.byType.reduce((s, c) => s + c.bytes, 0))}</td><td class="num">100%</td><td></td></tr></tfoot></table>`
  } else {
    const st = S.sort.subs
    const rows = sortRows(h.subs.map((s) => ({ key: s.id, id: s.id, name: s.name, size: s.size, ext: s.ext, total: s.total, share: s.total !== null && tot ? s.total / tot : 0, desc: s.desc })), st)
    const maxShare = Math.max(0.0001, ...rows.map((r) => r.share))
    const body = rows.map((r) => `<tr class="sel-row" data-heap="${r.id}"><td class="mono cm">${esc(r.name)} <span class="x-dim">0x${esc(r.desc.slice(-8))}</span></td><td class="num">${fmtN(r.size)}</td><td class="num">${fmtN(r.ext)}</td><td class="num">${fmtN(r.total)}</td><td class="num">${pct(r.share)}</td><td class="bc">${bar(r.share / maxShare)}</td></tr>`).join('')
    table = h.subs.length ? `<table class="tbl heaptbl"><thead><tr>${th('Sub-heap', 'name', st)}${th('Size in parent', 'size', st, 'num')}${th('Extents', 'ext', st, 'num')}${th('Total heap size', 'total', st, 'num')}${th('Share', 'share', st, 'num')}<th class="bc"></th></tr></thead><tbody>${body}</tbody></table>
      <p class="rd-note">Size in parent and extents come from the <span class="mono">ds</span> line under the parent's chunk; the total is the sub-heap's own <span class="mono">Total heap size</span>.</p>` : '<p class="rd-note">This heap has no sub-heaps in the dump.</p>'
  }
  // chunk bar
  let chunkBar = ''
  if (ch) {
    chunkBar = `<div class="chunkbar"><span><b>${fmtN(ch.lines.length)}</b> chunk line${ch.lines.length === 1 ? '' : 's'} of <span class="mono">${esc(ch.label)}</span></span>
      <span class="grow"></span><span class="dim">${ch.i + 1} / ${fmtN(ch.lines.length)} · line ${fmtN(ch.lines[ch.i])}</span>
      <button type="button" class="quiet icon-btn" data-chunk="-1" aria-label="Previous chunk" title="Previous chunk">${chev('up')}</button><button type="button" class="quiet icon-btn" data-chunk="1" aria-label="Next chunk" title="Next chunk">${chev('down')}</button>
      <button type="button" class="quiet" data-chunk-show="1" title="Show the chunks in the text">In text</button></div>`
  }
  // free lists
  const bk = h.buckets
  let hist = ''
  if (bk.length) {
    const maxB = Math.max(1, ...bk.map((b) => b.bytes))
    const W = 18, H = 54
    const cols = bk.map((b, k) => {
      const bh = b.bytes ? Math.max(1.5, (b.bytes / maxB) * H) : 0
      const sz = b.size >= 1048576 ? Math.round(b.size / 1048576) + 'm' : b.size >= 1024 ? Math.round(b.size / 1024) + 'k' : b.size
      return `<g><title>bucket ${b.i}, size ${fmtN(b.size)}: ${b.chunks} chunk${b.chunks === 1 ? '' : 's'}, ${fmtN(b.bytes)} bytes</title>
        <rect x="${k * W + 3}" y="${H - bh}" width="${W - 6}" height="${bh}" class="hb"/><text x="${k * W + W / 2}" y="${H + 10}" class="ht" text-anchor="middle">${b.chunks}</text>
        ${k % 3 === 0 ? `<text x="${k * W + W / 2}" y="${H + 21}" class="hs" text-anchor="middle">${sz}</text>` : ''}</g>`
    }).join('')
    const nch = bk.reduce((s, b) => s + b.chunks, 0), nb = bk.reduce((s, b) => s + b.bytes, 0)
    hist = `<section class="rd-sec"><div class="rd-k">Free lists <span class="x-dim">(bar: bytes per bucket; number: chunks; bucket size below)</span></div>
      <svg class="hist" viewBox="0 0 ${bk.length * W} ${H + 25}" width="${Math.min(bk.length * W, 460)}" role="img" aria-label="Free list buckets">${cols}</svg>
      <div class="rd-note">${bk.length} buckets, ${fmtN(nch)} chunks, ${fmtN(nb)} bytes in ${lnk(h.lines.free, 'the free lists')}.</div></section>`
  }
  const parent = h.parent ? heapById(h.parent) : null
  const run = M.readings.runs[h.run]
  return `<div class="rd">
    <header class="rd-head"><h3 class="mono">${esc(h.name)}</h3><span class="rd-meta">desc <span class="mono">0x${esc(h.desc)}</span> · depth ${h.depth} · ${parent ? `in <button type="button" class="lnk" data-heap="${parent.id}">${esc(parent.name)}</button> · ` : ''}${fmtN(h.extents)} extents · ${fmtN(h.chunks)} chunks · lines ${lnk(h.from, fmtN(h.from))}–${fmtN(h.to)}</span></header>
    ${heapCheck(h)}
    <section class="rd-sec"><div class="rd-k">Heap tree <span class="x-dim">(${esc(run.label)}; bytes are each heap's Total heap size)</span></div>${heapTree(h)}</section>
    <section class="rd-sec"><div class="seg-row"><div class="x-seg" role="tablist" aria-label="Table">
        <button type="button" role="tab" data-tab="comment" aria-pressed="${tab === 'comment'}">By comment</button><button type="button" role="tab" data-tab="type" aria-pressed="${tab === 'type'}">By type</button><button type="button" role="tab" data-tab="subs" aria-pressed="${tab === 'subs'}">Sub-heaps <span class="x-dim">${h.subs.length}</span></button></div>
      <span class="dim">${tab === 'subs' ? '' : 'Click a row to see its chunks in the text.'}</span></div>
      ${chunkBar}${table}</section>
    ${hist}
  </div>`
}
function chev(d) { return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="${d === 'up' ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'}"/></svg>` }

// ---- the blocker tree, shared by the system state and the hang analysis -------------------------------------------------------------------------
/** nodes: [{key, parent, title, who, event, secs, sql, sqlId, blocks, line, tag}] ; the root is the final blocker. */
function blockerTree(nodes, opts = {}) {
  const kids = new Map()
  for (const n of nodes) { const p = n.parent || ''; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n) }
  const card = (n, isRoot) => {
    n.hasKids = (kids.get(n.key) || []).length > 0
    const sql = n.sql ? `<div class="bt-sql mono" title="${esc(n.sql)}">${esc(n.sql)}</div>` : n.cmd ? `<div class="bt-sql dim">${esc(n.cmd)}</div>` : ''
    return `<div class="bt-n"><div class="bt-h"><span class="mono strong">${esc(n.title)}</span>${n.who ? `<span class="dim">${esc(n.who)}</span>` : ''}${isRoot && n.hasKids ? '<span class="bt-tag">final blocker</span>' : ''}<span class="grow"></span>${n.proc ? `<button type="button" class="lnk" data-proc="${n.proc}" title="Open the process reading">process ${n.proc}</button>` : ''}${n.line ? lnk(n.line, 'line ' + fmtN(n.line)) : ''}</div>
      <div class="bt-w">${n.event ? `waiting for <span class="mono">'${esc(n.event)}'</span>${n.secs !== null && n.secs !== undefined ? ` <span class="dim">· ${fmtS(n.secs)}</span>` : ''}` : '<span class="dim">no wait recorded</span>'}${n.blocks ? ` <span class="dim">· blocks ${n.blocks} session${n.blocks === 1 ? '' : 's'}</span>` : ''}</div>${sql}</div>`
  }
  const go = (n, isRoot) => {
    const cs = kids.get(n.key) || []
    return `<li>${card(n, isRoot)}${cs.length ? `<ul>${cs.map((c) => go(c, false)).join('')}</ul>` : ''}</li>`
  }
  const roots = kids.get('') || []
  return `<ul class="bt">${roots.map((r) => go(r, true)).join('')}</ul>`
}

// ---- reading: system state -----------------------------------------------------------------------------------------------------------------------
function readSysstate() {
  const R = M.readings.sysstate
  const c = R.counts
  const nodes = R.tree.map((t) => ({ key: t.key, parent: t.blockedBy, title: `${t.sid}.${t.ser}`, who: [t.user, t.action].filter(Boolean).join(' · '), event: t.event, secs: t.waitSecs, sql: t.sql, cmd: t.cmd, blocks: t.blocks, line: t.line, proc: t.pid }))
  // roots: sessions that are nobody's blocked-by (the final blocker)
  const keys = new Set(nodes.map((n) => n.key))
  for (const n of nodes) if (!keys.has(n.parent)) n.parent = ''
  const rows = R.rows.filter((r) => !(S.hideIdle && r.idle))
  const st = S.sort.proc
  const dec = rows.map((r) => ({ ...r, key: r.pid, wait: r.event || '', secs: r.waitSecs ?? -1, ospidN: r.ospid ? parseInt(r.ospid, 10) : -1, sidser: r.sid ? r.sid * 100000 + r.ser : -1 }))
  const field = { pid: 'pid', name: 'name', ospid: 'ospidN', sidser: 'sidser', wait: 'wait', time: 'secs' }[st.col] || 'pid'
  const sorted = sortRows(dec, { col: field, dir: st.dir })
  const body = sorted.map((r) => {
    const chain = R.tree.some((t) => t.pid === r.pid)
    return `<tr class="sel-row${r.idle ? ' idle' : ''}${chain ? ' chain' : ''}${S.node === 'proc:' + r.pid ? ' on' : ''}" data-proc="${r.pid}"><td class="num">${r.pid}</td><td class="mono">${esc(r.name)}</td><td class="num dim mono">${esc(r.ospid || '')}</td><td class="num mono">${r.sid !== null ? r.sid + '.' + r.ser : ''}</td><td class="ev">${r.event ? esc(r.event) : r.cmd ? `<span class="dim">${esc(r.cmd)}</span>` : ''}</td><td class="num">${r.waitSecs !== undefined && r.waitSecs !== null ? fmtS(r.waitSecs) : ''}</td><td class="num mono">${r.blockedBy ? r.blockedBy.sid + '.' + r.blockedBy.ser : ''}</td></tr>`
  }).join('')
  const sh = (label, col, cls = '') => th(label, col, st, cls)
  const idleN = R.rows.filter((r) => r.idle).length
  return `<div class="rd">
    <header class="rd-head"><h3>System state</h3><span class="rd-meta">${esc(M.outline.children.find((n) => n.kind === 'sysstate').sub)} · ${lnk(R.sysLine, 'line ' + fmtN(R.sysLine))}</span></header>
    <section class="rd-sec"><div class="rd-k">Blocker tree <span class="x-dim">(as the dump names the sessions: Dumping 1 direct blocker(s), Dumping final blocker, sessions blocked by this session)</span></div>
      ${blockerTree(nodes)}
      <p class="rd-note">The final blocker is at the top; each session below it is blocked by the one above. The three sessions are the ones the summary marks with <span class="mono">Blocked by</span> and <span class="mono">Final Blocker</span>.</p></section>
    <section class="rd-sec"><div class="rd-k">Processes <span class="x-dim">(the dump's Process Summary, with the time in wait from each session's wait stack)</span></div>
      <div class="rd-actions"><span><b>${c.total}</b> processes: ${c.user} user, ${c.bg} background, ${c.pseudo} pseudo</span><span class="grow"></span>
        <label class="chk-l"><input type="checkbox" data-hide-idle="1" ${S.hideIdle ? 'checked' : ''}> hide idle background processes (${idleN})</label></div>
      <div class="tblwrap"><table class="tbl proctbl"><thead><tr>${sh('Pid', 'pid', 'num')}${sh('Name', 'name')}${sh('Ospid', 'ospid', 'num')}${sh('Sid.serial', 'sidser', 'num')}${sh('Waiting for', 'wait')}${sh('Time in wait', 'time', 'num')}<th class="num">Blocked by</th></tr></thead><tbody>${body}</tbody></table></div></section>
  </div>`
}

// ---- reading: hang analysis ------------------------------------------------------------------------------------------------------------------------
function readHang() {
  const R = M.readings.hang
  const chains = R.chains.map((ch) => {
    const ss = ch.sessions
    const nodes = ss.map((s, k) => ({ key: s.sid + '.' + s.ser, parent: k + 1 < ss.length ? ss[k + 1].sid + '.' + ss[k + 1].ser : '', title: `${s.sid}.${s.ser}`, who: [s.pdb, s.module && s.module.replace(/ \(TNS.*\)$/, '').replace(/-[\w.]*localdomain$/, '')].filter(Boolean).join(' · '), event: s.event, secs: s.waitSecs, sql: s.sql, blocks: s.blocks, line: s.line, proc: null }))
    // the chain lists the waiter first; the tree has the final blocker on top: reverse the parent direction
    // top = last session; each next is blocked by it: parent of nodes[k] is nodes[k+1]
    const treeNodes = nodes.map((n, k) => ({ ...n, parent: k + 1 < nodes.length ? nodes[k + 1].key : '' }))
    const sig = ch.signature
    return `<section class="rd-sec"><div class="rd-k">Chain ${ch.n} <span class="x-dim">${ss.length} session${ss.length === 1 ? '' : 's'} · ${lnk(ch.from, 'lines ' + fmtN(ch.from) + '-' + fmtN(ch.to))}</span></div>
      <div class="rd-p mono sig">${esc(sig || '')}</div>${blockerTree(treeNodes)}
      ${ss.length > 1 ? `<p class="rd-note">In the dump's order the waiter comes first: ${ss.map((s) => `<span class="mono">${s.sid}.${s.ser}</span>`).join(', blocked by ')}.</p>` : ''}</section>`
  }).join('')
  const nodesT = R.nodes.map((n) => `<tr><td class="num">${n.node}</td><td class="num mono">${n.sid}.${n.ser}</td><td class="num dim mono">${n.ospid}</td><td class="mono">${esc(n.state)}</td><td class="mono dim">${esc(n.adj)}</td></tr>`).join('')
  return `<div class="rd">
    <header class="rd-head"><h3>Hang analysis</h3><span class="rd-meta">level ${esc(R.level)} · ${R.chains.length} chains · ${R.chains.reduce((s, c) => s + c.sessions.length, 0)} sessions</span></header>
    ${chains}
    <section class="rd-sec"><div class="rd-k">State of ALL nodes</div><table class="tbl"><thead><tr><th class="num">Node</th><th class="num">Sid.serial</th><th class="num">Ospid</th><th>State</th><th>Adjacent</th></tr></thead><tbody>${nodesT}</tbody></table>
      <p class="rd-note">The session ids here differ from those of the system state: they are two runs of the same three-session scenario, not one dump.</p></section>
  </div>`
}
