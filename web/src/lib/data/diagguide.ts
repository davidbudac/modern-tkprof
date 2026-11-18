// The dump reader's guide: "sourced or silent" (docs/PLAN-DIAG.md § The reader). An entry is written only where docs/trace-format-diag.md backs it, and
// its source (the section of that file) is printed with it. A kind of node without an entry says "No guide text for this kind of section".
// Text is the guide's lightweight markup: `code` between backticks, **bold** between double stars.
import type { DiagNode } from './diag'

/** The file the entries are written from. */
export const GUIDE_SOURCE = 'docs/trace-format-diag.md'

export interface GuideEntry {
  /** whether the entry is about this node: by its kind, and for a `title` node by its title */
  match: (n: Pick<DiagNode, 'kind' | 'title'>) => boolean
  title: string
  text: string
  /** a second paragraph, set apart (what the reader checks, what was verified) */
  note?: string
  /** the section of GUIDE_SOURCE the entry is from */
  src: string
}

const kind = (...k: string[]) => (n: Pick<DiagNode, 'kind' | 'title'>) => k.includes(n.kind)
const titled = (re: RegExp) => (n: Pick<DiagNode, 'kind' | 'title'>) => n.kind === 'title' && re.test(n.title)

const DIAGDUMP = 'A diagnostic dump: error stack, call stack, process state'

export const GUIDE: readonly GuideEntry[] = [
  {
    match: kind('header'), title: 'File header', src: 'Common frame',
    text: 'As a 10046 trace: `Trace file …`, the version lines, `Unix process pid:`, then the group of `*** ` markers (`SESSION ID`, `MODULE NAME`, `ACTION NAME`, `CONTAINER ID`). An incident file starts with `Dump file …` instead.',
  },
  {
    match: kind('other'), title: 'Lines between sections', src: 'Common frame',
    text: '`*** ` timestamp lines and what the dumps leave around them, such as the wrapper lines oradebug writes (`Processing Oradebug command …` before a dump, `Oradebug command … console output` after it). A `*** ` timestamp also occurs inside dumps; it does not end a section.',
  },
  {
    match: kind('trace10046'), title: 'SQL trace (10046) lines', src: 'Common frame',
    text: 'A run of 10046 records between dumps: `PARSING IN CURSOR`, `EXEC`, `FETCH`, `WAIT`, `STAT`. No line inside a dump has the form of a 10046 record, so a dump ends at the next one. Open the file as a SQL trace to read these.',
  },
  {
    match: kind('diagdump'), title: 'A diagnostic dump', src: DIAGDUMP,
    text: 'An error stack, a deadlock and an incident all write the same unit. It starts at `dbkedDefDump(): Starting a non-incident diagnostic dump (flags, level, mask)`; its sections are `----- Title -----` lines. **There is no end line**: in a trace of its own the dump runs to the end of the file, inside a 10046 trace to the next 10046 record.',
  },
  {
    match: titled(/^(Error Stack Dump|Current SQL Statement|Parser State|PL\/SQL Stack|PL\/SQL Call Stack|Call Stack Trace)/), title: 'Error stack, SQL, PL/SQL stack and call stack', src: DIAGDUMP,
    text: '`Current SQL Statement for this session (sql_id=…)` names the statement the session runs and prints its text. The PL/SQL call stack is a table of handle, line number and object name, ended by a blank line. The call stack table has three header lines, then per frame `caller()+offset`, `call`, `callee()` and the argument values; `?` marks a dubious value. A long caller name wraps onto the next line, so the frame list is read from the binary stack dump\'s frame headers, which give the whole name.',
  },
  {
    match: (n) => n.kind === 'frame' || titled(/^(Binary Stack Dump|Argument\/Register Address Dump|End of Call Stack Trace)/)(n), title: 'Binary stack dump and its frames', src: DIAGDUMP,
    text: 'One `========== FRAME [n] (caller()+off -> callee()) ==========` block per frame, with registers and memory. The frame headers are the reliable source of the frame list. The `Argument/Register Address Dump` follows, and `End of Call Stack Trace` closes the call stack.',
  },
  {
    match: titled(/^(Process Map Dump|Process Resource Limits|Java Stack|KSWRDUMP|KSMEM_DUMP|KSM MGA PRIVATE DUMP|VKTM Time Drifts)/), title: 'The dump\'s own housekeeping sections', src: DIAGDUMP,
    text: 'After the call stack a diagnostic dump lists `Process Map Dump`, `Process Resource Limits`, `Java Stack`, `KSWRDUMP START` / `END`, `KSMEM_DUMP START` / `END`, `KSM MGA PRIVATE DUMP START` / `END` and `VKTM Time Drifts Circular Buffer`, in that order at level 1.',
  },
  {
    match: titled(/^(Session Cursor Dump|Session Open Cursors|Dump Cursor |Bind Byte Code|Bind Info|Session Cached Cursor Dump|Generic Session Cached|RDBMS Session Cached)/), title: 'Cursor dumps', src: DIAGDUMP,
    text: 'Level 2 adds `Session Cursor Dump`, `Session Open Cursors`, a `Dump Cursor sql_id=…` block per cursor with `Bind Byte Code (IN)` and `Bind Info (kkscoacd)`, and `Session Cached Cursor Dump`. Bind values print in the form of a 10046 `BINDS` body: these are what redaction has to act on.',
  },
  {
    match: kind('procstate'), title: 'Process state', src: 'Process state',
    text: 'Starts at `PROCESS STATE` with a 13-dash underline, after a rule of `=`; ends at `END OF PROCESS STATE`, the last line of a process state of its own and of the one inside an errorstack. A state object is `SO: 0x…, type: name (number), map: 0x…`, indented two blanks per level of the tree; the next lines give `state:`, `owner:` and `child list count:`, then an `SOC:` line and the object\'s own text, which begins with its kind in parentheses (`(process)`, `(session)`, `(call)`, `(enqueue)`). The session object holds `Current Wait Stack:` (or `Not in wait; last wait ended N sec ago`) and `Session Wait History:`.',
    note: 'When blockers exist the dump names them itself: `Dumping 1 direct blocker(s)`, `Dumping final blocker`, `There are N sessions blocked by this session`.',
  },
  {
    match: kind('so'), title: 'State object', src: 'Process state',
    text: '`SO: 0x<addr>, type: <name> (<number>), map: 0x<addr>`, indented two blanks per level of the tree. The next lines give `state:`, `owner: 0x<parent>, proc: 0x<process>` and `child list count:`; a `SOC:` line and the object\'s own text follow, which begins with its kind in parentheses. Types seen in a user process: process (2), session (4), call (3), enqueue (11), transaction (85), DML lock (83), LIBRARY OBJECT LOCK (118), LIBRARY OBJECT PIN (119), channel handle (19), Block List (84).',
  },
  {
    match: kind('heap'), title: 'A heap dump', src: 'Heap dump',
    text: 'Starts at `HEAP DUMP heap name="…" desc=0x…` after a line of 54 `*`. The header gives `parent=` (the descriptor of the parent heap, `(nil)` for a top heap) and `dsx heap depth=`. A chunk line is `Chunk addr sz=bytes type "comment"`, optionally with `ds=0x…` (the sub-heap the chunk belongs to as an extent) or `alo=` (perm chunks). Then come `Total heap size`, `FREE LISTS:` (buckets, each with its chunks; a `kghdsx` chunk of size 0 is a list head), `Total free space`, `PERMANENT CHUNKS:` (each perm chunk again) and `Permanent space`. The comment is cut to about 15 characters by the dump.',
    note: 'On the 87 heaps of the lab that print totals, the chunks of the extents sum to `Total heap size`, the free-list chunks to `Total free space` and the perm chunks under `PERMANENT CHUNKS:` to `Permanent space`. A PDB-filtered dump, a sampled heap and a header without extents print nothing to check.',
  },
  {
    match: kind('extents', 'extent'), title: 'Extents of a heap', src: 'Heap dump',
    text: '`EXTENT n addr=0x…` starts each extent of the heap; its chunk lines follow. A `ds` line after the `recreate` chunk that holds a sub-heap\'s descriptor gives the sub-heap\'s size and its extent count (`ct=`), then up to ten of its extents as bare `<addr> sz=<bytes>` lines.',
  },
  {
    match: kind('freelists', 'bucket'), title: 'Free lists', src: 'Heap dump',
    text: '`FREE LISTS:` is followed by `Bucket N size=<bytes>` lines, each with its chunks; a `kghdsx` chunk of size 0 is a list head. `Total free space` follows the last bucket.',
  },
  {
    match: kind('unpinned', 'permanent'), title: 'Unpinned and permanent chunks', src: 'Heap dump',
    text: '`UNPINNED RECREATABLE CHUNKS (lru first):` (SGA heaps add a `SEPARATOR` line and `Unpinned space = N rcr=N trn=N`), then `PERMANENT CHUNKS:` (each perm chunk again, with its parts as `cprm` lines) and `Permanent space`.',
  },
  {
    match: kind('subheaps'), title: 'Largest sub-heaps', src: 'Heap dump',
    text: 'After a heap\'s `Permanent space`, `N LARGEST SUB HEAPS for heap name="…"` lists the sub-heaps, each as `SUBHEAP n: desc=…`, and the sub-heap\'s own `HEAP DUMP` follows, whose `parent=` is the parent\'s `desc` and whose `dsx heap depth` is one more. The `size=` on the `Subheap` line is a little larger than the sub-heap\'s `Total heap size`.',
  },
  {
    match: kind('pga-summary'), title: 'PGA memory summary', src: 'PGA memory dumps',
    text: 'The memory part an out-of-memory trace prints: `TOP 10 MEMORY USES FOR THIS PROCESS`, `PRIVATE MEMORY SUMMARY FOR THIS PROCESS`, `Private memory usage per Oracle process`, `ESTIMATED MEMORY USES FOR ALL PROCESSES` and `SWAP INFORMATION`. Sizes are rounded (KB or MB as printed), so this dump has no exact total to check.',
  },
  {
    match: kind('pga-detail'), title: 'PGA memory detail dump', src: 'PGA memory dumps',
    text: 'Between `Begin PGA memory detail dump` and `End PGA memory detail dump`, under `PGA memory detail for pid N, OS pid N`: pairs of lines with exact bytes (`3512312 bytes, 217 chunks: "pl/sql vc2" PL/SQL`, then the heap name with its `ds=` and `dsprt=`).',
  },
  {
    match: kind('sysstate'), title: 'System state', src: 'System state',
    text: 'Starts at `SYSTEM STATE (level=N[, with short stacks])` with a dash underline, ends at `END OF SYSTEM STATE`. `Dumping the Process Summary` has one line per process: Oracle pid, name (`USER` for a foreground), `ospid`, `sid`, `ser`, and `waiting for \'event\'`, with an optional `Cmd:` line.',
    note: 'The dump names blockers itself: `Dumping 1 direct blocker(s)`, `Dumping final blocker`, `There are N sessions blocked by this session`.',
  },
  {
    match: kind('process'), title: 'PROCESS n', src: 'System state',
    text: 'Each process starts at `PROCESS <n>: <name>`; under it the process\'s state object tree, as in a process state, with a `Short stack dump:` (functions joined by `<-`) at levels with short stacks.',
  },
  {
    match: titled(/^Process summary/), title: 'Process summary', src: 'System state',
    text: '`Dumping the Process Summary`: one line per process with its Oracle pid, name, `ospid`, `sid`, `ser` and what it waits for, and an optional `Cmd:` line. It is the summary `ass109.awk` was written to produce.',
  },
  {
    match: kind('hang', 'chain'), title: 'Hang analysis', src: 'Hang analysis',
    text: 'Starts at a rule of 79 `=` and `HANG ANALYSIS:`; ends at `END OF HANG ANALYSIS`, followed by a `HANG ANALYSIS DUMPS:` block. `Chains most likely to have caused the hang:` lists each chain with its signature. Each `Chain N:` lists sessions, the first waiting, each next one after `and is blocked by`. `current sql_id` is a **number** here, not the 13-character sql_id.',
  },
  {
    match: kind('deadlock'), title: 'Deadlock graph', src: 'Deadlock graph',
    text: 'Starts at `DEADLOCK DETECTED ( ORA-00060 )`. The graph is a fixed-column table, one row per resource, with its blockers and waiters; the sessions\' blocks follow, each with its `current SQL:`. After `End of information for waiting sessions` a whole diagnostic dump follows, so the graph is a few dozen lines of a large file.',
  },
  {
    match: kind('incident'), title: 'Incident file', src: 'Incident file',
    text: 'Starts with `Dump file …` instead of `Trace file …`, then its own header. `[TOCnnnnn]` and `[TOCnnnnn-END]` markers bracket the sections and nest; the file ends with its own table of contents (`TOC00000 - Table of contents`, one line per marker, `| ` per nesting level), a ready outline of the file.',
  },
  {
    match: kind('toc'), title: 'Table of contents entry', src: 'Incident file',
    text: '`[TOCnnnnn]` and `[TOCnnnnn-END]` markers bracket the sections of an incident file and nest. Most stand on a line of their own, some at the end of a line (`NamespaceDump:  [TOC00026]`); a closing marker is a line of its own and can be indented.',
  },
]

/** The entries that say something of a node (none: the guide is silent). */
export function guideFor(n: Pick<DiagNode, 'kind' | 'title'>): GuideEntry[] {
  return GUIDE.filter((g) => g.match(n))
}

/** The words the facts list uses for a node kind. */
export const KIND_NAME: Record<string, string> = {
  header: 'File header', other: 'Other lines', trace10046: 'SQL trace lines', heap: 'Heap dump', 'pga-summary': 'PGA memory summary', 'pga-detail': 'PGA memory detail dump',
  diagdump: 'Diagnostic dump', procstate: 'Process state', sysstate: 'System state', hang: 'Hang analysis', deadlock: 'Deadlock graph', incident: 'Incident file',
  title: 'Section', banner: 'Banner', frame: 'Stack frame', process: 'Process', so: 'State object', chain: 'Chain', toc: 'Table of contents entry',
  extents: 'Extents', extent: 'Extent', freelists: 'Free lists', bucket: 'Free list bucket', unpinned: 'Unpinned chunks', permanent: 'Permanent chunks', subheaps: 'Largest sub-heaps',
}
