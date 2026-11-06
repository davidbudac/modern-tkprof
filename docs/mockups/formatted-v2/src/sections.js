// ---- the page: the composites (section 0), the ten sections, the bugs box ---------------------------------------------------------------
const ALL = { p1: 1, p2: 1, p3: 1, p4: 1, p5: 1, p6: 1, p7: 1, p8: 1, p9: 1, p10: 1 }
const tOfLine = (ln) => byLn.get(ln).t

const STATE_A = { hl: 'c7ry5gr75qv4b', sel: 118, stats: { callsNow: 5, wnow: '34', calls: 5, waits: '34' }, selT: tOfLine(118), view: [fracOfTim(10804502774), fracOfTim(10805142191)], wrap: false }
const STATE_B = { hl: '52nzchs09dgn1', sel: 10378, stats: { callsNow: 205, wnow: '1,000', calls: 205, waits: '3,293' }, selT: tOfLine(10378), view: [fracOfTim(10810351080), fracOfTim(10810359243)], wrap: true }
const STICKY_LOOP = { sqlid: 'dk21j71dpu26c', facts: '11.5 ms here · exec 221 of 300' }
const STICKY_SORT = { sqlid: '52nzchs09dgn1', facts: '2.486 s here · exec 1 of 1' }

const stateLine = (parts) => parts.filter(Boolean).map((p) => `<span>${p}</span>`).join('<span aria-hidden="true">·</span>')
const fmtRanges = (ranges) => 'rows ' + ranges.map(([a, b]) => `${fmtInt(a)}–${fmtInt(b)}`).join(', ')

/** One NOW or PROPOSED block: label, the pane in its frame, the caption. */
function block(kind, ranges, o, caption, state) {
  const proposed = kind === 'proposed'
  const pane = paneHtml(ranges, { ...o, proposed })
  return `<div class="blk"><div class="blk-head"><span class="tag ${proposed ? 'proposed' : ''}">${proposed ? 'Proposed' : 'Now'}</span><span class="state">${state}</span></div>`
    + `<div class="frame">${pane}</div><p class="cap">${caption}</p></div>`
}
/** A NOW / PROPOSED pair on the same rows. `base` is shared (highlight, selection, ranges); `flags` the proposal; the two captions. */
function pair(ranges, base, flags, capNow, capProp, stateTxt, extraNow = {}, extraProp = {}) {
  const st = stateLine([fmtRanges(ranges), ...(stateTxt || [])])
  return `<div class="pair">${block('now', ranges, { ...base, ...extraNow }, capNow, st)}${block('proposed', ranges, { ...base, ...flags, ...extraProp }, capProp, st)}</div>`
}
const sub = (title, small, inner) => `<div class="sub"><h3>${title}${small ? ` <small>${small}</small>` : ''}</h3>${inner}</div>`
const sec = (id, n, title, lede, inner) => `<section class="sec" id="${id}"><header><h2><span class="n">${n}</span>${title}</h2><p>${lede}</p></header>${inner}</section>`

const A_STATE = ['c7ry5gr75qv4b highlighted', 'line 118 selected']
const L_STATE = ['dk21j71dpu26c highlighted', 'line 3,000 selected']
const SEL118 = { sel: 118 }, SEL3000 = { sel: 3000 }, SEL10378 = { sel: 10378 }
const C_STATE_A = { composite: true, chrome: STATE_A, status: true, sel: 118, back: 8, hl: STATE_A.hl, viewLines: [84, 136], cap: undefined }
const C_STATE_B = { composite: true, chrome: STATE_B, status: true, sel: 10378, back: '2,977', hl: STATE_B.hl, viewLines: [10355, 10401] }

function build() {
  const out = []

  // ---- 0. at a glance ------------------------------------------------------------------------------------------------------------
  out.push(sec('s0', '0', 'At a glance',
    'The whole pane at 1560 px, today and with all ten changes applied, on the same real rows of io_waits.trc. Every number is the same in both; only what the eye is asked to do changes. The ten sections below take the changes one at a time.',
    sub('a · The 637 ms full scan', 'rows 84–136 · c7ry5gr75qv4b highlighted · line 118 selected',
      pair([[84, 136]], C_STATE_A, { ...ALL, p10: 1 },
        'Today: a salmon wash over 34 waits and 5 calls (39 of 54 rows), the 632 ms enqueue wait and the 637 ms fetch are not distinguishable from it, the toolbar carries a Highlighting chip, and the Statement column is empty on 50 of 54 rows.',
        'All ten changes: the lane is the highlight, the two hot spots are the only red rows, waits are quiet and bracketed under the call that waited, the 26 reads are a column, the plan is a quiet table, and the 130 px Statement column is a 14 px band.',
        null)) +
    sub('b · The 2.448 s sort', 'rows 10355–10401 · 52nzchs09dgn1 highlighted · line 10,378 selected',
      pair([[10355, 10401]], C_STATE_B, { ...ALL, sticky: STICKY_SORT },
        'Today: the toolbar wraps its last button, only the calls are tinted (the waits are past the chip\'s 1,000-wait cap; the statement has 3,293), the 2.448 s sort is a hairline bar in a plan cell, and the selected row has two colours.',
        'All ten changes, with the sticky lane row for 52nzchs09dgn1 pinned at the top: the SORT ORDER BY A-Time is the one red cell, the bar sits with Duration on a log scale, the clock shows only what changes.',
        null))))

  // ---- 1. highlight the lane ------------------------------------------------------------------------------------------------------
  out.push(sec('s1', '1', 'Highlight the lane, not the row',
    'The highlighted statement fills 33 of 37 rows with the same salmon as a hot spot or a selection. Move the highlight out of the row and into the Statement cell.',
    sub('Rows 95–130', 'c7ry5gr75qv4b highlighted, line 118 selected',
      pair([[95, 130]], { hl: 'c7ry5gr75qv4b', sel: 118 }, { p1: 1 },
        'A flat 10 % wash over every call and wait (33 rows): it reads as a selection, the zebra gap where BINDS and PLAN rows are not filled reads as noise, and hot row 122 is lost. The lane band is mixed 60 % toward ink, so orange draws as maroon.',
        'No row fill. The Statement cell takes the lane colour at 14 % for the full row height on every row of the lane, the band widens from 4 to 6 px in its own hue, and the number cell keeps a 3 px start-edge bar on the calls and waits. Only the amber selection (number cell included) and hot spots fill a row.',
        A_STATE.slice(1).concat('c7ry5gr75qv4b highlighted'))) +
    sub('Rows 2960–3010', 'dk21j71dpu26c highlighted, line 3,000 selected',
      pair([[2960, 3010]], { hl: 'dk21j71dpu26c', sel: 3000 }, { p1: 1 },
        'In the loop the wash stripes the view: EXEC, FETCH and CLOSE are filled, the BINDS rows between them are not, and the pink band mixes toward violet.',
        'The same rule in the loop: the lane reads as one column of pink, the rows stay on the surface, and the selected bind row (3,000) is the only amber.',
        L_STATE))))

  // ---- 2. hot spots ---------------------------------------------------------------------------------------------------------------
  out.push(sec('s2', '2', 'Hot spots unmistakable',
    'A hot spot is a call, wait or plan operation that takes 1 % of the traced time (64.6 ms of 6.46 s) or more. Today it is tinted at 9 % in the colour of a highlight: the same orange.',
    sub('Rows 84–96', 'the 907 µs hard parse and the 632 ms enq: KO wait at line 93',
      pair([[84, 96]], { sel: undefined }, { p2: 1 },
        'Row 93 is tinted orange at 9 %, the colour of a highlight or a lane: nothing says "this is where the time went".',
        'A hot-spot row fills with --s-critical at 16 % (22 % in dark), has a 3 px start bar in the same colour, and its Duration number is 600 in --s-critical. The hue is reserved for hot spots.',
        ['no statement highlighted'])) +
    sub('Rows 10380–10390', 'the SORT ORDER BY of 2.448 s',
      pair([[10380, 10390]], {}, { p2: 1 },
        'The 2.448 s sort is a 10 px bar inside a plan cell: the most expensive line of the file is the least visible one.',
        'The same rule on the plan: the A-Time cell of the operation whose own time is 1 % or more of the traced time (SORT ORDER BY, 2.446 s) fills in --s-critical, with the number at 600. The 637 ms FETCH at row 122 gets it too (section 3).',
        ['no statement highlighted']))))

  // ---- 3. bar with duration -------------------------------------------------------------------------------------------------------
  out.push(sec('s3', '3', 'The bar lives with Duration',
    'The Δ column also carries a bar of the line\'s own time that is 1–3 px wide and nearly invisible. Duration is where a time belongs; Δ goes back to being a number.',
    sub('Rows 95–130', 'no statement highlighted, line 118 selected',
      pair([[95, 130]], SEL118, { p3: 1, p2: 1 },
        'Δ is text over a bar at the far left edge (a 2 px line for almost every row, since the scale runs to 2.448 s); Duration is a bare number, so 9 µs and 637 ms differ by two characters.',
        'Duration gets a 56 px track after the number on a log scale (1 µs empty, 10 s full, a faint tick per decade), in the wait-class colour for waits and in slate for calls, the CPU part solid and the waited part lighter. Numbers get a ramp: µs 400 --ink-2, ms 500, s 650. Δ is dimmed, blank under 50 µs, and emphasised (--s-warning, 500) only when it is at least 1 ms and 2× the line before. The 637 ms FETCH at 122 takes the hot-spot rule from section 2.',
        ['no statement highlighted', 'line 118 selected'])) +
    sub('Δ as the unexplained gap', 'a variant of the Δ column: rows 36–39 and 10,366–10,368',
      pair([[36, 39], [10366, 10368]], {}, { p3gap: 1 },
        'Today Δ is the difference of the two tim values: +1.51 ms on the idle wait at 10,367 repeats that wait\'s own 1.49 ms, and the PARSE at 39 reads −1 µs because its tim sits before its CURSOR line\'s.',
        'Δ = start of this line (tim − its own time) minus the end of the line before, never negative and blank under 50 µs. The idle wait stands alone with its 1.49 ms, the PARSE is blank, and the +146 µs the session spent before the CURSOR stays, because nothing explains it.',
        ['two groups of rows']))))

  // ---- 4. calls loud, waits quiet --------------------------------------------------------------------------------------------------
  out.push(sec('s4', '4', 'Calls loud, waits quiet, the call says what it waited for',
    'Today WAIT is purple, calls are blue, PLAN green and BINDS teal: five hues in a column that is read for one thing, which line is a call.',
    sub('Rows 95–130', 'line 118 selected',
      pair([[95, 130]], SEL118, { p4: 1 },
        'Every operation has a hue (the app mixes them in oklch, so WAIT comes out purple), the same weight, and the FETCH of 637 ms says nothing about the 26 reads above it.',
        'PARSE, EXEC, FETCH, CLOSE and CURSOR are uppercase 600 in ink with no hue; a wait is a lowercase <code>wait</code> in --ink-3 with a 6 px dot in its wait-class colour in front of the event (a ring for idle). The FETCH adds <code>· 631 ms waiting (99 %)</code>, red from 50 %. Waits under a call are indented 2 ch and bracketed in the lane colour down to the call; idle waits get no bracket. <code>hard parse</code> is a tan pill, not red text.',
        ['line 118 selected'])) +
    sub('Rows 10359–10390', 'line 10,378 selected',
      pair([[10359, 10390]], SEL10378, { p4: 1 },
        'Reads, network and idle waits all look the same weight, and the 1.49 ms the client took between fetches reads like the 2 µs reads.',
        'Idle waits (<code>SQL*Net message from client</code>) between calls get no indent and no bracket and read as gaps; the reads and the <code>more data to client</code> waits belong to the FETCH that follows. The share is skipped where the call has no wait to speak of (FETCH 181 µs, c = e).',
        ['line 10,378 selected'])) +
    sub('Marks', 'rows 23–31 · the header',
      pair([[23, 31]], {}, { p4: 1 },
        'TIME, SESSION, CLIENT, MODULE… are dim but share the operation column with the calls.',
        'Marks are --ink-3 400, quieter than a call.',
        ['no statement'])) ))

  // ---- 5. sticky lane label --------------------------------------------------------------------------------------------------------
  out.push(sec('s5', '5', 'A sticky lane label and a 14 px Statement column',
    'The Statement column is 130 px wide and empty on every row but the first two of a lane; most of the time it is 130 px of nothing. A 14 px column keeps the colour and the lane\'s identity moves to an overlay.',
    sub('Rows 2960–3010', 'dk21j71dpu26c, 300 executions, 11.5 ms in all',
      pair([[2960, 3010]], SEL3000, { p5: 1, sticky: STICKY_LOOP },
        'The sql_id shows on the lane\'s first row and its SQL on the second; scroll 20 rows into a 300-execution loop and the column says nothing at all.',
        'The column is the band (6 px) and an 8 px gutter. The lane\'s identity is one sticky row pinned at the top while it scrolls, like today\'s plan head row: the band, the sql_id in the lane colour, the SQL start in --ink-3 (cut at 48 ch) and <code>11.5 ms here · exec 221 of 300</code> at the right. It covers only the top row, to the right of that row\'s Δ and line number. Each execution\'s first row (BINDS, else EXEC) is tagged <code>exec 221</code> in --ink-3.',
        L_STATE.slice(1))) +
    sub('Rows 10359–10390', '52nzchs09dgn1 and two recursive statements',
      pair([[10359, 10390]], SEL10378, { p5: 1, sticky: STICKY_SORT },
        'The same blank column; row 10,388 has the label of the recursive cursor <code>10gywwmwk6x…</code> cut at 10 characters (bug 10). Row 32\'s <code>unknown</code> (not drawn here) is a statement without SQL text.',
        'The pinned row names the statement for the whole 2.486 s of its exec (<code>2.486 s here · exec 1 of 1</code>). A statement without text would read <code>no SQL text · #…8360</code> instead of <code>unknown</code>.',
        ['line 10,378 selected']))))

  // ---- 6. row economy --------------------------------------------------------------------------------------------------------------
  out.push(sec('s6', '6', 'Row economy',
    'The loop spends 5 to 6 rows on 3 calls and one bind; a cursor start spends 5 rows (rule, CURSOR, SQL, END OF STMT, PARSE) on one statement.',
    sub('Rows 2960–3010', 'the loop',
      pair([[2960, 3010]], SEL3000, { p6: 1, p5: 0 },
        '5 rows per execution (BINDS head, the bind row, EXEC, FETCH, CLOSE) in a 51-line excerpt; the CLOSE says <code>already in the cursor cache</code> in a sentence, and every <code>0 µs</code> is full ink.',
        '4 rows per execution. A BINDS block with up to 4 binds of up to 24 characters is a row of chips (<code>:B1 = 8706 NUMBER</code>, then the link); its Bind# and attribute lines fold, with a dotted gap mark in the number cell (2,968 → 2,975). Each execution\'s first row has a 1 px --ruling top border. CLOSE reads <code>cached</code> or <code>closed</code>; <code>0 µs</code> is --ink-3.',
        L_STATE.slice(1))) +
    sub('Rows 84–96', 'a cursor start',
      pair([[84, 96]], {}, { p6: 1 },
        'CURSOR, then the SQL, then <code>end of statement</code> take three rows before the first call, and the ===== line and a blank line another two each.',
        'The CURSOR is one row (<code>c7ry5gr75qv4b  SELECT · user 165 · 99 chars</code>), the SQL follows, no <code>end of statement</code>; the blank folds and the ===== becomes a hairline above the next CURSOR. The <code>1 byte</code> of a SQL*Net message is dropped, <code>8,101 bytes</code> stays.',
        ['no statement highlighted'])) +
    sub('Rows 130–143', 'the next, recursive cursor',
      pair([[130, 143]], {}, { p6: 1 },
        'The rule, CURSOR, SQL, end of statement, PARSE, then a BINDS table of one bind: 7 rows before EXEC.',
        'The rule is a full-width hairline over the CURSOR row, the bind is a chip on the BINDS row.',
        ['no statement highlighted']))))

  // ---- 7. runs of the same event ---------------------------------------------------------------------------------------------------
  out.push(sec('s7', '7', 'Scannable Detail for runs of the same event',
    'A run of 26 direct path reads is read for the one field that changes. Today it is prose with · separators, and the block numbers jitter left and right.',
    sub('Rows 95–121', 'one FETCH\'s 27 waits',
      pair([[95, 121]], SEL118, { p7: 1 },
        '26 times <code>direct path read  MTK_ORDERS  file 12 · block 171160 · 8 blocks</code>: the eye has to read every line to find that the file never changes and the blocks climb.',
        'For a run of 3 or more of the same event and object the repeated prefix is a ditto (--ink-3 at 60 %) on every row after the first, and the varying fields are right-aligned micro-columns <code>file 12 | block 171160 | 8 blocks</code>, labels --ink-3, numbers ink, no ·.',
        ['line 118 selected'])) +
    sub('Rows 10359–10371', 'temp reads with network waits inside',
      pair([[10359, 10371]], SEL10378, { p7: 1 },
        'The same prose; the network waits at 10,361 and 10,365 sit inside the run.',
        'A network or idle wait inside the run breaks the ditto (the next read starts in full ink) but not the alignment: the columns stay where they are.',
        ['line 10,378 selected']))))

  // ---- 8. quieter tables -----------------------------------------------------------------------------------------------------------
  out.push(sec('s8', '8', 'Quieter plan and bind tables',
    'A plan or a BINDS block is a table in a column of prose: grey bands, a hairline under every row, a bar that touches the Cost number.',
    sub('Plans', 'rows 122–124 and 10382–10384',
      pair([[122, 124]], {}, { p8: 1 },
        'The table sits in the Detail column only, on a grey band with a rule under every row; the A-Time bar touches the Cost number, and the minimum bar (the 2.45 ms SORT AGGREGATE) is a lone <code>|</code> with no track.',
        'The table spans Operation to the right edge on --surface-sunken, a 1 px hairline frame, inset 1 ch; 11 px --ink-3 header cells with one hairline under them and no band; the fold handle sits in the head row (<code>▾ PLAN</code>). The A-Time bar gets a 56 px track and a gap; its fill is the operation\'s own time, so the header says so. Cost, E-Rows and Starts are the first columns to drop when the pane is narrow, and an estimate 10× off per start would turn --s-critical (none is here).',
        ['no statement highlighted']) +
      pair([[10382, 10384]], {}, { p8: 1, p2: 1 },
        'Here the 2.448 s bar fills the cell and meets the 2,014 of Cost.',
        'The same table with the hot-spot rule of section 2: the A-Time cell of SORT ORDER BY (2.446 s of its own) is the one red cell.',
        ['no statement highlighted'])) +
    sub('Bind tables', 'rows 136–143 and 153–196',
      pair([[136, 143]], {}, { p8: 1 },
        'A BINDS block of one bind is a header row, a bind row and a link inside the header; the table is as wide as its three columns.',
        'The link is a row after the last bind, not a header cell. Values and types sit in fixed columns, so they line up down a loop and from table to table.',
        ['no statement highlighted']) +
      pair([[153, 196]], {}, { p8: 1 },
        'Eight binds of dbvj6jc977hqh: a header and eight rows, line numbers 155, 160 … 190, the attribute lines folded.',
        'The same table in the quiet style; <code>:4 .0000000337759769235673 NUMBER</code> and the quoted VARCHAR2 values stay in their columns.',
        ['no statement highlighted']))))

  // ---- 9. clock -------------------------------------------------------------------------------------------------------------------
  out.push(sec('s9', '9', 'Clock that shows what changes',
    'Rows 95–130 are 4 ms of one second, and the clock says <code>11:35:29.8</code> on every one of them.',
    sub('Rows 95–130', 'line 118 selected',
      pair([[95, 130]], SEL118, { p9: 1 },
        '17 characters of clock per row, 11 of which never change.',
        'The full <code>11:35:29.828061</code> on the first visible row, on the selected row and wherever HH:MM:SS changes; the other rows show only the changing microseconds, right-aligned so the digits line up under the full stamp. The column shrinks from 17 ch to 10 ch and Detail gets the width.',
        ['line 118 selected']))))

  // ---- 10. chrome -----------------------------------------------------------------------------------------------------------------
  out.push(sec('s10', '10', 'Calmer chrome',
    'The top of the pane is a toolbar of ten controls, a breadcrumb, a bar, a row of chips and the column header: in the state of io_waits-bigplan-light.png (52nzchs09dgn1 highlighted, Hot spot 6, line 10,378), 1560 px wide. The rows below it are NOW\'s, so only the chrome differs.',
    sub('Toolbar, breadcrumb, bar, chips, column header', 'the first rows of the second composite below them',
      pair([[10359, 10362]], { composite: true, chrome: STATE_B, status: false, sel: 10378, viewLines: [10355, 10401], strip: true }, { p10: 1 },
        'The toolbar wraps its last button to a second line; a pressed Δ is a solid black block, the same weight as Raw | Formatted; the Highlighting chip says again what the chip row says; the bar is unlabelled and its chips show a share, not a time.',
        'One toolbar row that never wraps (the search shrinks first, down to 14 ch), pressed toggles in the quiet style, no Highlighting chip: the outlined statement chip carries the count and the ×. The bar is labelled, 12 px tall, with a time axis and a bracket for where the visible rows sit; chips show time and share, and statements under 1 % fold into <code>+4 under 1 %</code>. The column header reads in 11 px --ink-3, <code>Duration</code> over its numbers, and draws no resize grips until hovered.',
        ['state of io_waits-bigplan-light.png']))))

  // ---- bugs -----------------------------------------------------------------------------------------------------------------------
  out.push(`<section class="sec" id="bugs"><div class="bugs"><h2>Looks like bugs, not design</h2><p>Seen while drawing the NOW blocks; they do not depend on any of the ten changes.</p><ol>
    <li>The toolbar wraps at 1600 px with the Highlighting chip, and at 1280 px.</li>
    <li>The highlight stops silently at 1,000 waits: the chip's <code>1,000 waits</code> is the cap, and 52nzchs09dgn1's waits after line 10,359 are untinted while its FETCH rows are.</li>
    <li>The lane band is mixed 60 % toward ink, so orange c7ry5gr75qv4b draws as maroon and pink dk21j71dpu26c as violet.</li>
    <li>The plan's ▾ handle sits on the first STAT row in the Statement column, not on the PLAN head row.</li>
    <li>Negative Δ on a PARSE after its CURSOR line (−1 µs, −7 µs).</li>
    <li>At 1280 px with the panel open the plan drops A-Time, Buffers and Reads and keeps Cost and E-Rows, with no "n hidden" note.</li>
    <li>A header key longer than 26 ch (<code>Redo thread mounted by this instance</code>) pushes its value off the value column.</li>
    <li>The selected row is amber but its line-number cell is cyan.</li>
    <li>The A-Time bar touches the Cost number, and the minimum bar has no track, so it reads as a stray <code>|</code>.</li>
    <li>sql_ids are truncated in the lane (<code>10gywmwk6x…</code>).</li>
    <li>With Fold repeats on, the run of 26 identical direct path reads at lines 96–121 stayed unfolded with no handle row (seen in two runs; may be a rule gap rather than a bug).</li>
    <li>Toggling Fold repeats scrolls the selected line out of view.</li>
  </ol></div></section>`)
  return out
}

const TOC = [
  ['s0', '0', 'At a glance'], ['s1', '1', 'Highlight the lane'], ['s2', '2', 'Hot spots unmistakable'], ['s3', '3', 'The bar with Duration'], ['s4', '4', 'Calls loud, waits quiet'],
  ['s5', '5', 'Sticky lane label'], ['s6', '6', 'Row economy'], ['s7', '7', 'Scannable runs of waits'], ['s8', '8', 'Quieter plan and tables'], ['s9', '9', 'Clock shows the change'],
  ['s10', '10', 'Calmer chrome'], ['bugs', '!', 'Looks like bugs'],
]
