# mtkprof (version to be chosen): the dump reader

Draft. The owner decides the version and whether to release. It is on
`main` since 2026-11-18, merged after v0.8.0, so this release comes after
it.

mtkprof now reads, best effort, the diagnostic dumps Oracle writes to trace
files: heap dumps, PGA memory dumps, errorstacks, process state, system state,
hang analysis, deadlock graphs and incident files. A file of dumps opens in a
tab of its own with the dump reader: an outline, the file's text, and a
computed reading for each kind it knows. SQL traces (10046) and optimizer
traces (10053) stay the primary formats.

## Moving from the 10053 release

- **Caches**: caches written before are rebuilt on first open
  (`CacheIndexFormat` 9). A file with diagnostic dumps no longer counts their
  lines as unknown lines (line kind `diagnostic`).

## The dump reader (desktop and `mtkprof serve`)

- A file that holds diagnostic dumps and no 10046 record or optimizer dump
  opens in a *dump* tab. The folder picker tags it *dump* with what it holds
  ("2 heap dumps, 1 process state"); its filter is now *Show*: SQL and
  optimizer traces (the default), *Also dump files*, *All files*. Given with
  10046 files in one request, the file is left out of the set with a note and
  a button that opens it.
- The outline lists the file in order and loads a dump's parts when a row is
  opened (titles, frames, processes, state objects, chains, extents), so a
  large system state opens at once.
- The centre shows the selected part's reading, or its text behind a
  *Reading | Text* switch. The text is paged from the engine; bulk parts
  (frame registers, memory maps, block dumps) are folded with their line
  count and reason.
- Search over the whole file with hit counts on the outline, a where-am-I
  path, a line map, a guide whose entries each name their source, notes and
  bookmarks on lines.
- **Heap dumps**: where the memory is, by comment, by chunk type, by sub-heap
  and in the free lists, with the heap tree and a stepper over the chunk lines
  of a row. The sums are checked against the totals the dump prints (Total
  heap size, Total free space, Permanent space): the check says they match, by
  how much they differ, or why they cannot be checked. On the test files no
  check differs, and the sums agree with Tanel Poder's `heapdump_analyzer`.
- **PGA memory dumps** (`pga_summary`, `pga_detail_dump`): the dump's tables
  as tables. The summary's figures are rounded and it prints no total, so
  nothing is checked.
- **Call stack** (errorstack, the dump after a deadlock, an incident): the
  error, the statement, the PL/SQL stack, the frames with the dump's own
  frames folded, the stack as one line to copy, the cursors with their binds.
- **Process**: who the session is, what it runs, what it waits for and since
  when, who blocks it, what it holds.
- **System state**: the process table from the dump's own summary and the
  blocker tree as the dump names it; idle background processes are hidden by
  default, blocked and blocking sessions always show.
- **Hang analysis and deadlock graph**: the chains as the dump prints them;
  the deadlock's graph, cycle and victim.
- A 10046 trace that holds a dump stays a 10046 trace, with a note and *Open
  in the dump reader*. A statement or session of a 10046 tab shows a *dump*
  mark when an open dump tab names it; a reading links back with a *10046*
  mark. Nothing is joined.
- An interleaved file (10046 and 10053 in one session) can now be opened as
  10053: *Open as 10053* beside its note.

## SQL heat and the Search map (desktop and `mtkprof serve`)

- **SQL heat**: a statement's plan has a third view, *Table | Row flow | SQL heat* (also a *SQL heat* button beside
  *Row flow*): the SQL text with each part tinted by its share of the time, the percentage in the margin, the
  plan lines each part stands for, what could not be placed, and how much of the execution the plan accounts for.
  Matches the trace cannot prove are marked ≈; an imported reference bundle makes them exact. A function that runs
  recursive SQL gets a ≈ note, or, called outside the plan (the select list), a share of its own.
- **Search map** (10053 view, *Search map* or `m`): one costing run's join-order search, each join order a column of
  the costs printed after each step on a log scale, abandoned orders ending at the best-so-far line, the winner
  marked, and a table of every run of the dump. It draws the costs the trace prints and computes none.

## Command line

- `mtkprof report file.trc` prints the digest of a file of dumps: its facts,
  the outline to two levels with line numbers, and every reading as text.
  `mtkprof html file.trc` writes the reader with the outline and the readings
  inside (not the file's text); `mtkprof json` the document.
- `-view 10046|10053|diag` on `report`, `html`, `json`, the default command and
  `serve` opens a single file another way: `-view diag` reads a 10046 trace's
  dumps, `-view 10053` an interleaved file's optimizer dumps.
- `-redact-binds` and `-binds none` apply to the bind values of the cursor
  dumps in the digest and in the HTML; the reader in the app shows the file
  as it is.
- `mtkprof lint` lists the line kind `diagnostic` and the sections.
- `pivot`, `export`, `plan`, `refscript`, `compare` and `brief` stop with one
  line for a file of dumps.

## Limits

- 19c is tested, on dumps made on a lab instance. Another version opens best
  effort, and the reader says "read with the 19c rules" and how many lines fell
  outside any known part. A system state is tested on a small lab system
  (about 80 processes).
- No real ORA-04030 trace was available; the memory blocks of an
  out-of-memory error are read from the `pga_summary` dump.
- The app does not take dumps; the assistant and `mtkprof mcp` do not open
  dump files; Compare and Cut are not offered on a dump tab; a file of dumps
  cannot be followed live.
