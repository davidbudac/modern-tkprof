package trace

import "bytes"

// Optimizer (10053) dumps in a 10046 trace file.
//
// Event 10053 writes the optimizer's log of one hard parse to the same trace
// file as event 10046 (docs/trace-format-10053.md). The parser does not read
// a dump; it recognises where one starts and ends so that its lines are not
// taken for 10046 lines: they are counted as KindOpt, and the dumps are
// reported through Stats.Dumps.
//
//   - A dump starts at the first "Registered qb: <name> 0x<hex> (PARSER)" line
//     outside a dump and ends at the "END SQL Statement Dump" banner. Further
//     "(PARSER)" lines inside it (one per query block) are part of it.
//   - Inside a dump a line that is a valid 10046 record or a "*** " marker
//     keeps that kind (event 10046 on in the same session writes complete
//     dep=1 records between the optimizer's lines), the 21 "=" separator
//     likewise; every other line is KindOpt. The bind lines of the dump's
//     "Bind Info" block are optimizer lines unless a real "BINDS #" header
//     opened them (the parser's bind-block state decides that, before this
//     file's rules apply).
//   - After the END banner a few hundred lines of adaptive-plan chatter can
//     follow ("AP: qesdp..."): they are KindOpt up to the next 10046 record,
//     marker, separator or dump. After a first dump, the lines the event
//     writes while the statement runs ("AP: ...", "kkeCostToTime: ..." and
//     its two continuation lines before a STAT line) are optimizer lines
//     wherever they sit between the 10046 records.
//   - Everything else is classified as in a trace without dumps.

// Dump is one optimizer dump found in a file.
type Dump struct {
	// First is the line of the "Registered qb: ... (PARSER)" line that starts
	// the dump; Last the line of the "END SQL Statement Dump" banner, or the
	// last line of the file (or the line before a "TRACE CONTINUES IN FILE"
	// marker) of a dump that was cut short.
	First, Last int
	// SQLID is the statement's sql_id from its "Current SQL Statement for this
	// session (sql_id=...)" line; "" when the dump ends before that line.
	SQLID string
	// Cut: the dump has no END banner (the file ends inside it).
	Cut bool
}

// Lines is the number of lines First..Last.
func (d Dump) Lines() int { return d.Last - d.First + 1 }

const (
	dumpStartPrefix = "Registered qb: "
	dumpEndText     = " END SQL Statement Dump "
	dumpSQLIDPrefix = "----- Current SQL Statement for this session (sql_id="
	continuesIn     = "CONTINUES IN FILE "
)

// IsDumpStart reports whether line is "Registered qb: <name> 0x<hex> (PARSER)",
// the line a dump starts with when seen outside one.
func IsDumpStart(line []byte) bool {
	if !hasPrefix(line, dumpStartPrefix) {
		return false
	}
	rest := line[len(dumpStartPrefix):]
	i := bytes.IndexByte(rest, ' ')
	if i <= 0 {
		return false
	}
	rest = rest[i+1:]
	if !hasPrefix(rest, "0x") {
		return false
	}
	j := 2
	for j < len(rest) && isHexDigit(rest[j]) {
		j++
	}
	if j == 2 {
		return false
	}
	return string(bytes.TrimRight(rest[j:], " \r")) == " (PARSER)"
}

// IsDumpEnd reports whether line is the "====== END SQL Statement Dump ======"
// banner that ends a dump.
func IsDumpEnd(line []byte) bool {
	return hasPrefix(line, "=====") && bytes.Contains(line, []byte(dumpEndText)) && bytes.HasSuffix(bytes.TrimRight(line, " \r"), []byte("====="))
}

// DumpSQLID returns the sql_id of a "----- Current SQL Statement for this
// session (sql_id=8sjn0t7rms5s7) -----" line.
func DumpSQLID(line []byte) (string, bool) {
	id, ok := dumpSQLID(line)
	return string(id), ok
}

func dumpSQLID(line []byte) ([]byte, bool) {
	if !hasPrefix(line, dumpSQLIDPrefix) {
		return nil, false
	}
	rest := line[len(dumpSQLIDPrefix):]
	i := bytes.IndexByte(rest, ')')
	if i <= 0 {
		return nil, false
	}
	return rest[:i], true
}

// isSeparator21 is the separator of 10046 traces: exactly 21 "=".
func isSeparator21(line []byte) bool {
	if len(line) != 21 {
		return false
	}
	for _, c := range line {
		if c != '=' {
			return false
		}
	}
	return true
}

// runtimeOptLine matches the lines the optimizer event writes while the
// statement runs, between 10046 records and outside any dump: the adaptive
// plan's "AP: qesdp..." and "AP: qerscStart(enter)...", and the three lines
// ("kkeCostToTime: using io calibrate stats ...", " block_size=...",
// " tot_io_size=...") written before each STAT line whose cost is printed.
func runtimeOptLine(line []byte) bool {
	switch line[0] {
	case 'A':
		return hasPrefix(line, "AP: ")
	case 'k':
		return hasPrefix(line, "kkeCostToTime: ")
	case ' ':
		return hasPrefix(line, " block_size=") || hasPrefix(line, " tot_io_size=")
	}
	return false
}

func isHexDigit(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

type optState uint8

const (
	optOut     optState = iota // outside any dump
	optDump                    // between a start line and the END banner
	optChatter                 // after the END banner, up to the next record
)

// optTracker follows the dump state of a stream of lines. The parser calls
// line only for lines no cursor text, PARSE ERROR text or BINDS block took,
// and only when it is in a dump or the line matched no record (a trace
// without dumps pays one comparison per line).
type optTracker struct {
	st    optState
	seen  bool // a dump was seen in this file
	cur   Dump
	dumps *[]Dump
	id    func([]byte) string // interns a sql_id
}

// line decides about one line the stateless recordKind classified as r; true
// means it is an optimizer line (KindOpt). n is its 1-based line number.
func (t *optTracker) line(n int, line []byte, r rec) bool {
	switch t.st {
	case optOut:
		if r.kind != KindUnknown {
			return false
		}
		if IsDumpStart(line) {
			t.begin(n)
			return true
		}
		return t.seen && runtimeOptLine(line)
	case optDump:
		if len(line) > 0 && line[0] == '=' && IsDumpEnd(line) {
			t.cur.Last = n
			*t.dumps = append(*t.dumps, t.cur)
			t.st = optChatter
			return true
		}
		switch r.kind {
		case KindUnknown:
			if t.cur.SQLID == "" {
				if id, ok := dumpSQLID(line); ok {
					t.cur.SQLID = t.id(id)
				}
			}
			return true
		case KindSeparator:
			return !isSeparator21(line)
		}
		return false
	default: // optChatter
		switch r.kind {
		case KindUnknown:
			if IsDumpStart(line) {
				t.begin(n)
			}
			return true
		case KindBlank:
			return false
		}
		t.st = optOut
		return false
	}
}

func (t *optTracker) begin(n int) {
	t.st, t.seen = optDump, true
	t.cur = Dump{First: n}
}

// marker sees a "*** " marker (rest is the text after the stars) inside a
// dump: "TRACE CONTINUES IN FILE" cuts the dump short before it.
func (t *optTracker) marker(n int, rest []byte) {
	if t.st == optDump && bytes.Contains(rest, []byte(continuesIn)) {
		t.cut(n - 1)
	}
}

func (t *optTracker) cut(last int) {
	t.cur.Last, t.cur.Cut = max(last, t.cur.First), true
	*t.dumps = append(*t.dumps, t.cur)
	t.st = optOut
}

// finish ends the input at line n (the last line read).
func (t *optTracker) finish(n int) {
	if t.st == optDump {
		t.cut(n)
	}
}

// open returns the dump in progress as a cut one (a snapshot of a growing file).
func (t *optTracker) open(n int) (Dump, bool) {
	if t.st != optDump {
		return Dump{}, false
	}
	d := t.cur
	d.Last, d.Cut = max(n, d.First), true
	return d, true
}

// maxChatterGuess is how far after a dump's END banner a page that starts
// there is assumed to be still in the adaptive-plan chatter (see MarkOpt).
const maxChatterGuess = 2000

// MarkOpt gives the optimizer lines of a page the kind the parser counts
// them as (KindOpt). kinds are what Classify or a Classifier said of lines
// (the first of which is line number lo of the file; a caller that seeds the
// SQL-text state classifies a few lines before its page and passes them
// all), dumps the file's dumps in file order (Stats.Dumps, FileEntry.Dumps).
// Inside a dump a line the stateless classifier did not recognise, a bind
// line outside a real BINDS block and a "=" banner other than the 21-"="
// separator become optimizer lines, as do the unrecognised lines after its END
// banner up to the next record and the lines the event writes while a
// statement runs ("AP: ..."). The parser decides all this with a state kept
// from the start of the file; a page that starts after a dump's end can only
// guess whether it starts in the chatter (it does for maxChatterGuess lines).
func MarkOpt(kinds []Kind, lines [][]byte, lo int, dumps []Dump) {
	if len(dumps) == 0 || len(kinds) == 0 {
		return
	}
	di := 0            // the first dump that has not ended before the line
	realBinds := false // inside a BINDS block the 10046 records opened
	chatter := false   // after a dump's END banner, no record yet
	n0 := lo
	for di < len(dumps) && dumps[di].Last < n0 {
		di++
	}
	if di > 0 && n0 > dumps[di-1].Last && n0-dumps[di-1].Last <= maxChatterGuess && (di >= len(dumps) || n0 < dumps[di].First) {
		chatter = true
	}
	for i, l := range lines {
		n := lo + i
		for di < len(dumps) && dumps[di].Last < n {
			if dumps[di].Last+1 == n {
				chatter = true
			}
			di++
		}
		k := kinds[i]
		if k == KindBinds {
			realBinds = true
		} else if k != KindBindLine && k != KindBlank {
			realBinds = false
		}
		in := di < len(dumps) && dumps[di].First <= n
		switch {
		case in:
			chatter = false
			switch k {
			case KindUnknown:
				kinds[i] = KindOpt
			case KindBindLine:
				if !realBinds {
					kinds[i] = KindOpt
				}
			case KindSeparator:
				if !isSeparator21(l) {
					kinds[i] = KindOpt
				}
			}
		case chatter:
			switch k {
			case KindUnknown:
				kinds[i] = KindOpt
			case KindBlank:
			default:
				chatter = false
			}
		case k == KindUnknown && n > dumps[0].First && len(l) > 0 && runtimeOptLine(l):
			kinds[i] = KindOpt
		}
	}
}
