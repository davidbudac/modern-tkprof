// Package opt reads Oracle optimizer trace dumps (event 10053) into a model for the 10053 reader:
// the dumps of a file, each with its outline (a tree of sections with line ranges), landmarks, folds,
// costing runs, the versions of the transformed SQL, the final plan, hints, peeked binds and altered
// parameters. It reads structure and the trace's own words; it computes nothing from the costs
// (docs/PLAN-10053.md § Decisions, docs/trace-format-10053.md).
//
// This file is the data contract. The JSON form of these types is what the engine serves, what the
// standalone report embeds and what web/src/lib/data/opt.ts mirrors: a field may be added, never
// renamed or removed, without changing the TypeScript twin in the same commit.
//
// Line numbers are 1-based positions in the file. A Range is inclusive at both ends.
package opt

// Range is a run of lines, From..To inclusive.
type Range struct {
	From int `json:"from"`
	To   int `json:"to"`
}

// File is what one pass over a trace file finds.
type File struct {
	Name    string `json:"name"`    // base name of the file
	Lines   int    `json:"lines"`   // lines in the file
	Release string `json:"release"` // prologue line 2, e.g. "Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production"
	Version string `json:"version"` // prologue "Version 19.27.0.0.0" -> "19.27.0.0.0"; "" when the file has no prologue
	Tested  bool   `json:"tested"`  // Version is a 19.x one (the rules were written for 19c)
	// Records10046 counts the 10046 records (PARSING IN CURSOR, calls, WAIT, STAT, BINDS, XCTEND, ERROR)
	// in the file, inside or outside dumps. A file is a 10053 file when len(Dumps) > 0 and this is 0.
	Records10046 int        `json:"records10046"`
	Dumps        []DumpInfo `json:"dumps"`
}

// Pure reports whether the file is read as a 10053 file: it has a dump and no 10046 record.
func (f *File) Pure() bool { return f != nil && len(f.Dumps) > 0 && f.Records10046 == 0 }

// DumpInfo is the summary of one dump: what the dump list shows, and what a 10046 tab needs to link to it.
type DumpInfo struct {
	Idx int `json:"idx"` // 0-based position in the file
	// From..End is the dump itself: the first "Registered qb: … (PARSER)" line to "END SQL Statement Dump".
	// ViewFrom..ViewTo is what the reader shows for it: the file prologue for the first dump, and the lines
	// after the dump up to the next one (the adaptive plan's execution lines). The views of a file's dumps
	// tile the file.
	From      int      `json:"from"`
	End       int      `json:"end"`
	ViewFrom  int      `json:"viewFrom"`
	ViewTo    int      `json:"viewTo"`
	LineCount int      `json:"lineCount"`           // ViewTo - ViewFrom + 1
	Truncated bool     `json:"truncated,omitempty"` // the file ended, or another dump began, before the end line
	SQLID     string   `json:"sqlId"`
	Nth       int      `json:"nth"`      // 1-based count among the file's dumps of this sql_id
	StmtText  string   `json:"stmtText"` // the statement as typed, from "Current SQL Statement for this session"
	SQLStart  string   `json:"sqlStart"` // StmtText on one line, white space collapsed, cut at 240 characters
	Tables    []string `json:"tables"`   // distinct table names of the parser's query blocks and costing runs, in order of first mention
	PlanHash  string   `json:"planHash"` // "plan_hash" of the other_xml section (the plh of a 10046 EXEC line); "" when absent
	RunCount  int      `json:"runCount"`
	// Unplaced counts the lines of From..End that sit directly under a phase or the dump node, in no known
	// section: the measure the reader shows for a file of an untested version.
	Unplaced int `json:"unplaced"`
}

// Dump is the whole model of one dump.
type Dump struct {
	DumpInfo
	StmtLine  int        `json:"stmtLine"` // first line of the statement text
	StmtTo    int        `json:"stmtTo"`   // its last line
	Tree      *Node      `json:"tree"`     // the outline; the root is the dump (kind "dump", ViewFrom..ViewTo)
	Landmarks []Landmark `json:"landmarks"`
	Folds     []Fold     `json:"folds"`
	Runs      []Run      `json:"runs"`
	SQL       []SQL      `json:"sql"`
	Plan      *Plan      `json:"plan,omitempty"`
	Legend    []Term     `json:"legend"`
	Banners   []Banner   `json:"banners"`
	// Roles marks the lines the formatted text dresses, by line number: "bt" banner top, "bh" banner title,
	// "bb" banner bottom (a top or bottom line is not drawn; the title is a heading), "uh" a heading line
	// (a title directly above its "-----" or "=====" underline), "ul" that underline. A "----- X -----" line
	// has no role: the reader dresses it by its shape, as the mock-up does.
	Roles   map[int]string `json:"roles"`
	Hints   []Hint         `json:"hints"`
	Binds   []Bind         `json:"binds"`
	Altered []Param        `json:"altered"`
	// BindLines are the lines that print a bind value ("value=11" under Bind Info and Peeked Binds): what
	// -redact-binds and -binds none act on.
	BindLines []int `json:"bindLines"`
	// Digest are the line ranges the digest keeps, ascending, not overlapping: the trace without its noise.
	Digest []Range `json:"digest"`
}

// Node is a section of the outline. Kind is one of the kinds listed in kinds.go; the optional fields are
// set for the kinds named beside them.
type Node struct {
	ID       string  `json:"id"` // unique in the dump, stable for one file ("n12")
	Kind     string  `json:"kind"`
	Label    string  `json:"label"` // the outline row
	Crumb    string  `json:"crumb"` // the short form for the where-am-I path
	From     int     `json:"from"`
	To       int     `json:"to"`
	Lvl      int     `json:"lvl"` // depth: 0 the dump, 1 a phase
	Children []*Node `json:"children,omitempty"`

	QB    string `json:"qb,omitempty"`    // run, registered: the query block name
	QBN   string `json:"qbn,omitempty"`   // run: the "(#n)" number
	N     int    `json:"n,omitempty"`     // run, iteration, join-order: its number
	Of    int    `json:"of,omitempty"`    // run: the dump's run count
	Title string `json:"title,omitempty"` // tsec, cbsec: the banner title
	Count int    `json:"count,omitempty"` // tsec, cbsec: how many consecutive sections of this title the node merges

	Prefix    string   `json:"prefix,omitempty"`    // iteration: "GBP", "CVM", "JPPD", …
	Space     string   `json:"space,omitempty"`     // iteration: the state space text, "(1,2,3,4) : (0,0,0,0)"
	RunIDs    []string `json:"runs,omitempty"`      // iteration: ids of its runs, nested iterations' runs included
	Verdict   *Verdict `json:"verdict,omitempty"`   // iteration, run: the verdict line of the iteration
	Iter      string   `json:"iter,omitempty"`      // run: id of the innermost iteration holding it
	IterLabel string   `json:"iterLabel,omitempty"` // run: that iteration's crumb, "GBP iteration 1"
	Final     bool     `json:"final,omitempty"`     // run: after "Final query after transformations"
	SameAs    int      `json:"sameAs,omitempty"`    // run: the number of the earlier run with the same text; 0 none
	BestJo    int      `json:"bestJo,omitempty"`    // run: "Best join order: N"

	Table  string   `json:"table,omitempty"`  // table: the name; join-step: "MTK_ORDERS[O]#1"
	Best   string   `json:"best,omitempty"`   // table: the access path of its "Best:: AccessPath" line
	Tables []string `json:"tables,omitempty"` // join-order: its tables as printed, "MTK_CUST[C]#0"
	Cost   string   `json:"cost,omitempty"`   // join-order: the cost of its last "Best so far" line, as printed
	IsBest bool     `json:"isBest,omitempty"` // join-order: the run's "Best join order" names it
	Method string   `json:"method,omitempty"` // join-step: the method of its "Best:: JoinMethod" line
	// Result is the right-hand text of the outline row, in the trace's words: a table's access path, a join
	// order's "cost: 453.647906" or "aborted", a join step's method.
	Result       string `json:"result,omitempty"`
	BannerBottom int    `json:"bannerBottom,omitempty"` // params-default: the last line of its banner
}

// Verdict is the line that closes a cost-based iteration.
type Verdict struct {
	Text string `json:"text"` // "GBP: Updated best state, Cost = 384.608830"
	Line int    `json:"line"`
	Kept bool   `json:"kept"` // "Updated best state"; false for "Not update best state"
}

// Landmark is a key line. Kind: "best-ap", "best-jm", "final-cost", "aborted", "verdict", "refused",
// "hint-error". Tone: "kept", "rejected", "problem".
type Landmark struct {
	Line int    `json:"line"`
	Kind string `json:"kind"`
	Tone string `json:"tone"`
	Text string `json:"text"` // the line, trimmed
}

// Fold is a run of lines the formatted text closes by default. Kind: "params" (parameters with default
// values), "state" (the optimizer state dump), "fix" (the fix controls, inside "state"), "ap" (adaptive plan
// re-costing), "same-run" (a costing run whose text repeats an earlier one), "stmt-again" (the statement
// text repeated), "same-sql" (an UNPARSED statement equal to an earlier one).
type Fold struct {
	ID     string `json:"id"`
	From   int    `json:"from"`
	To     int    `json:"to"`
	Lines  int    `json:"lines"`
	Kind   string `json:"kind"`
	Label  string `json:"label"` // the reason shown on the closed row
	Closed bool   `json:"closed"`
}

// Run is a costing run (kkoqbc: optimizing … to kkoqbc: finish optimizing …), also a node of the tree
// (ID is the node's).
type Run struct {
	ID      string   `json:"id"`
	N       int      `json:"n"`
	Of      int      `json:"of"`
	QB      string   `json:"qb"`
	QBN     string   `json:"qbn"`
	From    int      `json:"from"`
	To      int      `json:"to"`
	Verdict *Verdict `json:"verdict,omitempty"`
	Iter    string   `json:"iter"` // the crumb of its iteration, "CVM iteration 1"; "" outside any
	Final   bool     `json:"final"`
	SameAs  int      `json:"sameAs"` // 0 none
	BestJo  int      `json:"bestJo"`
}

// SQL is one "UNPARSED QUERY IS" statement.
type SQL struct {
	N      int    `json:"n"`      // 1-based, in file order within the dump
	Head   int    `json:"head"`   // the header line
	Line   int    `json:"line"`   // the statement's line
	Label  string `json:"label"`  // what the header (or the line before it) calls it: "Final query after transformations"
	Text   string `json:"text"`   // the statement, one line
	SameAs int    `json:"sameAs"` // Line of the earlier identical statement; 0 none
	Prev   int    `json:"prev"`   // Line of the previous statement in the file; 0 none
}

// Plan is the dump's plan table with what follows it.
type Plan struct {
	From    int                `json:"from"`    // first line of the "Plan Table" banner
	Head    int                `json:"head"`    // the column header line
	TableTo int                `json:"tableTo"` // last line of the table
	To      int                `json:"to"`      // last line of the predicate section
	Cols    []string           `json:"cols"`
	Rows    []PlanRow          `json:"rows"`
	QBs     map[int]PlanQB     `json:"qbs"`   // by operation id
	Preds   map[int][]PlanPred `json:"preds"` // by operation id
}

// PlanRow is one operation; the numbers are kept as printed ("96K").
type PlanRow struct {
	Line  int    `json:"line"`
	ID    int    `json:"id"`
	Depth int    `json:"depth"`
	Op    string `json:"op"`
	Name  string `json:"name"`
	Rows  string `json:"rows"`
	Bytes string `json:"bytes"`
	Cost  string `json:"cost"`
	Time  string `json:"time"`
	// Extra are the cells of the columns after the seven standard ones, aligned with Plan.Cols[7:]: Pstart and
	// Pstop of a partitioned plan, TQ, IN-OUT and PQ Distrib of a parallel one. "" for an empty cell; absent when
	// the plan has no such column.
	Extra []string `json:"extra,omitempty"`
}

// planStdCols is the number of columns every plan table has: Id, Operation, Name, Rows, Bytes, Cost, Time.
const planStdCols = 7

// PlanQB is an operation's query block name and object alias.
type PlanQB struct {
	QB    string `json:"qb"`
	Alias string `json:"alias"`
	Line  int    `json:"line"`
}

// PlanPred is one predicate line of an operation, "access(…)" or "filter(…)".
type PlanPred struct {
	Text string `json:"text"`
	Line int    `json:"line"`
}

// Term is an entry of the trace's own Legend.
type Term struct {
	Term  string      `json:"term"`
	Text  string      `json:"text"`
	Line  int         `json:"line"`
	Codes [][2]string `json:"codes"` // dmeth's numbered meanings; empty otherwise
}

// Banner is a title between two rule lines.
type Banner struct {
	Top    int    `json:"top"`
	Title  int    `json:"title"`
	Bottom int    `json:"bottom"`
	Text   string `json:"text"`
}

// Hint is one line of "Dumping Hints" or of the Hint Report.
type Hint struct {
	Line int    `json:"line"`
	Text string `json:"text"`           // the hint, "INDEX (\"O\" \"NO_SUCH_INDEX\")"; a Hint Report line as printed ("Unused: index(o no_such_index)", "use_hash(c)")
	Err  int    `json:"err"`            // atom_hint err=
	Used int    `json:"used"`           // atom_hint used=; 0 for a Hint Report line (the report prints no such value)
	Note string `json:"note,omitempty"` // Hint Report: "Unused", "Syntax Error", with its reason when printed
	// Src says which section the line is from: "dump" (Dumping Hints) or "report" (Hint Report).
	Src string `json:"src,omitempty"`
}

// Bind is a peeked bind of the other_xml section (or of Bind Info when that section has none).
type Bind struct {
	Pos   int    `json:"pos"`
	Type  string `json:"type"`  // "NUMBER"
	Value string `json:"value"` // as printed; "" when the trace prints none
	Line  int    `json:"line"`  // the "value=" line; 0 when none
	// Dup is the position of the bind this one repeats (other_xml "dup_position="; Bind Info "No oacdef for
	// this bind."); 0 when it is not a repeat.
	Dup int `json:"dup,omitempty"`
}

// Param is an altered parameter or fix control (PARAMETERS WITH ALTERED VALUES, PARAMETERS IN OPT_PARAM HINT).
type Param struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	Line  int    `json:"line"`
	From  string `json:"from"` // "altered", "opt_param"
}
