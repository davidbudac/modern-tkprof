// Package diag reads the diagnostic dumps of an Oracle trace file (heap dumps, PGA memory dumps, the
// diagnostic dump of an errorstack, process state, system state, hang analysis, deadlock graphs and the
// contents of an incident file) for the dump reader. This is level 0 of docs/PLAN-DIAG.md: any trace file
// gets an outline, paged text and search. The outline is served lazily: the scan holds the top level
// (which tiles the file) and the children of a node are found, when asked for, by reading only that node's
// lines. The computed readings of a section (a heap's totals, a call stack, a process state) are later
// stages; nothing here interprets a dump beyond where its parts start.
//
// This file is the data contract. The JSON form of these types is what the engine serves, what the
// standalone report embeds and what a TypeScript twin will mirror: a field may be added, never renamed or
// removed, without the twin changing in the same commit (TestJSONShape pins the Go side).
//
// Line numbers are 1-based positions in the file, as in internal/opt. A range is inclusive at both ends.
package diag

// File is what one pass over a trace file finds.
type File struct {
	Name    string `json:"name"`    // base name of the file
	Lines   int    `json:"lines"`   // lines in the file
	Release string `json:"release"` // prologue line 2, e.g. "Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production"; "" when the file has none
	Version string `json:"version"` // prologue "Version 19.27.0.0.0" -> "19.27.0.0.0"; "" when the file has none
	Tested  bool   `json:"tested"`  // Version is a 19.x one (the rules were written for 19c; another version is read with them)
	// Records10046 counts the lines that are 10046 records (PARSING IN CURSOR, calls, WAIT, STAT, BINDS,
	// XCTEND, ERROR, ...). It is 0 for a file this reader is the default view of; a 10046 trace that holds
	// a dump and is opened as a diag file has them, and its runs of records are "SQL trace (10046) lines".
	Records10046 int `json:"records10046"`
	// Incident is set when the file is an incident file (it starts with "Dump file ..." instead of "Trace
	// file ...", or holds the table of contents of one).
	Incident *Incident `json:"incident,omitempty"`
	// Sections are the diagnostic dumps the parser found (trace.Section), in file order: the kinds are
	// heap, pga-summary, pga-detail, diagdump, procstate, sysstate, hang, deadlock and incident.
	Sections []Section `json:"sections"`
	// Unplaced counts the lines outside the file header and every section that are none of: blank, a "*** "
	// marker, a rule line (a line of "=" or of 54 "*"), a 10046 record. They fall in the nodes titled "Other
	// lines". The measure the reader shows for a file of a version it was not tested on.
	Unplaced int `json:"unplaced"`
	// Outline is the top level: the file header, then in file order every section and every run of lines
	// between sections. The nodes tile the file (each starts at the line after the one before it, the
	// first at line 1, the last ends at Lines). At most Cap nodes are listed here; OutlineTotal says how
	// many there are and the rest is served as the children of the node "root" (Reader.Children).
	Outline      []Node `json:"outline"`
	OutlineTotal int    `json:"outlineTotal"`
}

// Section is one diagnostic dump the parser found (trace.Section).
type Section struct {
	Kind  string `json:"kind"`
	First int    `json:"first"`
	Last  int    `json:"last"`
	// Cut: a kind that has an end line stopped without reaching it (the file ended, or a line of a primary
	// format came first).
	Cut bool `json:"cut,omitempty"`
}

// Incident are the facts of an incident file.
type Incident struct {
	DumpFile      string `json:"dumpFile"`                // line 1: "Dump file <path>"
	ContinuedFrom string `json:"continuedFrom,omitempty"` // "Dump continued from file: <path>": the trace file of the session that raised it
	ID            string `json:"id,omitempty"`            // "========= Dump for incident 199651 (ORA 6544 [...]) ========" -> "199651"
	Problem       string `json:"problem,omitempty"`       // ... -> "ORA 6544 [pevm_peruws_callback-1]"
}

// Node is a row of the outline: a part of the file with a title and a range of lines.
//
// Kind is one of
//
//	top level only:  header (the prologue and the "*** " marker group), other (a run of lines between
//	                 sections), trace10046 (a run between sections that holds 10046 records)
//	a section (top level or nested in another): heap, pga-summary, pga-detail, diagdump, procstate,
//	                 sysstate, hang, deadlock, incident (the trace.SectionKind names)
//	inside a section: title ("----- X -----"), banner (a title framed by rules or underlined), frame
//	                 ("========== FRAME [n] (...) =========="), process ("PROCESS n: name" of a system
//	                 state), so (a state object "SO: 0x..., type: name (n)"), chain ("Chain N:" of a hang
//	                 analysis), toc ("[TOCnnnnn]" ... "[TOCnnnnn-END]" of an incident file), extent,
//	                 freelists, bucket, unpinned, permanent, subheaps (the parts of a heap dump)
//
// The rule behind each kind is in the table in rules.go, with the fixture line that shows it.
type Node struct {
	// ID is unique in the file and stable for it ("heap:32-923:1": kind, first and last line, the lines the
	// node's own heading takes). Reader.Children takes it back. "root" is the top level.
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Title string `json:"title"`         // plain words: "Heap dump: pga heap", "Diagnostic dump (level 2)", "Process 6: PMON"
	Sub   string `json:"sub,omitempty"` // a short second line: what the title does not say; optional
	From  int    `json:"from"`
	To    int    `json:"to"`
	Lines int    `json:"lines"` // To - From + 1
	// HasChildren: the node has parts of its own (Reader.Children gives them). Known for every node
	// without a scan of its own: it is read off the same pass that found the node.
	HasChildren bool `json:"hasChildren"`

	N       int    `json:"n,omitempty"`       // process, frame, chain, extent, bucket: its number; toc: the number of the marker
	Name    string `json:"name,omitempty"`    // heap: the heap name ("pga heap"); process: the process name ("PMON")
	Depth   *int   `json:"depth,omitempty"`   // heap: "dsx heap depth" of the header (0 a top heap, 1 a sub-heap of one, ...); absent when the header has none
	Size    int64  `json:"size,omitempty"`    // heap: "dsx heap size" of the header, bytes
	Records int    `json:"records,omitempty"` // trace10046: the number of 10046 records in the run
	Cut     bool   `json:"cut,omitempty"`     // a section whose end line was not reached
	// Reading is the kind of the computed reading the node has (Reader.Reading, GET api/diag/reading): "heap" for
	// a heap dump, "pga-summary", "pga-detail"; "callstack" for a diagnostic dump (and an incident file), "procstate" for a process state or a PROCESS n of a system
	// state; later stages add hang, deadlock, sysstate.
	// Absent when the node has none.
	Reading string `json:"reading,omitempty"`
	// Fold is a short reason, in plain words, for a part whose text is noise by default ("frame data: registers
	// and memory of each frame"): a client shows it closed. Absent for every other part. The parts and the
	// evidence for each are the table foldTable in rules.go.
	Fold string `json:"fold,omitempty"`

	unk int // other: lines that count as unplaced (the scan sums them for File.Unplaced)
}

// Outline is the answer for the children of a node.
type Outline struct {
	Node     string `json:"node"`     // the id asked for
	Children []Node `json:"children"` // at most Cap of them, in file order, inside the node, not overlapping
	// More is how many children follow those listed; Next, when More > 0, is the "after" to ask for the next
	// page (the number of children already seen).
	More int `json:"more"`
	Next int `json:"next,omitempty"`
}

// Cap is how many children one answer lists; a node with more is paged (the "after" parameter).
const Cap = 2000
