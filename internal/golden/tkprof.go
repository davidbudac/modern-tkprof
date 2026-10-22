// Package golden compares our statistics against the output of Oracle's own
// tkprof for the same trace files (testdata/traces/19c/*.tkprof.txt).
package golden

import (
	"bufio"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// TkprofCalls is one row of the tkprof call table.
type TkprofCalls struct {
	Count   int64
	CPU     float64
	Elapsed float64
	Disk    int64
	Query   int64
	Current int64
	Rows    int64
}

func (a *TkprofCalls) add(b TkprofCalls) {
	a.Count += b.Count
	a.CPU += b.CPU
	a.Elapsed += b.Elapsed
	a.Disk += b.Disk
	a.Query += b.Query
	a.Current += b.Current
	a.Rows += b.Rows
}

// TkprofWait is one row of the "Elapsed times include waiting on following events" table.
type TkprofWait struct {
	Times int64
	Max   float64
	Total float64
}

// TkprofStmt is one tkprof statement section (summed over plan hashes).
type TkprofStmt struct {
	SQLID    string
	Text     string
	Parse    TkprofCalls
	Execute  TkprofCalls
	Fetch    TkprofCalls
	Total    TkprofCalls
	Misses   int64
	Depth    int
	Sections int
	Waits    map[string]*TkprofWait
}

// TkprofReport is a parsed tkprof output file.
type TkprofReport struct {
	Stmts        map[string]*TkprofStmt // by SQL ID
	Order        []string
	NonRecursive TkprofCalls // OVERALL TOTALS FOR ALL NON-RECURSIVE STATEMENTS: total row
	Recursive    TkprofCalls
	NonRecParse  TkprofCalls
	RecParse     TkprofCalls
	NonRecExec   TkprofCalls
	RecExec      TkprofCalls
	NonRecFetch  TkprofCalls
	RecFetch     TkprofCalls
}

var (
	reSQLID  = regexp.MustCompile(`^SQL ID: (\S+)`)
	reCall   = regexp.MustCompile(`^(Parse|Execute|Fetch|total)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$`)
	reMisses = regexp.MustCompile(`^Misses in library cache during parse: (\d+)`)
	reDepth  = regexp.MustCompile(`recursive depth: (\d+)`)
	reWait   = regexp.MustCompile(`^  (\S.*?)\s{2,}(\d+)\s+([\d.]+)\s+([\d.]+)\s*$`)
)

// NormalizeText collapses whitespace so tkprof's re-wrapped statement text
// can be compared with the original.
func NormalizeText(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// ParseTkprof reads a tkprof output file. Sections are keyed by SQL ID when
// tkprof prints one, otherwise by the normalised statement text ("text:...").
func ParseTkprof(path string) (*TkprofReport, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r := &TkprofReport{Stmts: map[string]*TkprofStmt{}}
	var cur *TkprofStmt
	overall := "" // "nonrec" | "rec"
	inWaits := false
	expectSection := false // just after a separator: next non-blank line starts a section
	var text []string
	inText := false
	startSection := func(id string) {
		st := r.Stmts[id]
		if st == nil {
			st = &TkprofStmt{SQLID: strings.TrimPrefix(id, "text:"), Waits: map[string]*TkprofWait{}}
			if strings.HasPrefix(id, "text:") {
				st.SQLID = ""
			}
			r.Stmts[id] = st
			r.Order = append(r.Order, id)
		}
		st.Sections++
		cur = st
		overall = ""
		inWaits = false
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "OVERALL TOTALS FOR ALL NON-RECURSIVE"):
			overall, cur, inWaits, expectSection, inText = "nonrec", nil, false, false, false
			continue
		case strings.HasPrefix(line, "OVERALL TOTALS FOR ALL RECURSIVE"):
			overall, cur, inWaits, expectSection, inText = "rec", nil, false, false, false
			continue
		case strings.HasPrefix(line, "********"):
			inWaits, expectSection, inText = false, true, false
			continue
		}
		if inText {
			if strings.HasPrefix(line, "call ") && strings.Contains(line, "count") {
				inText = false
				t := strings.Join(text, "\n")
				if cur != nil && cur.Text == "" {
					cur.Text = t
				}
				if cur == nil {
					startSection("text:" + NormalizeText(t))
					cur.Text = t
				}
				continue
			}
			text = append(text, line)
			continue
		}
		if expectSection {
			if strings.TrimSpace(line) == "" {
				continue
			}
			expectSection = false
			if m := reSQLID.FindStringSubmatch(line); m != nil {
				startSection(m[1])
				text, inText = nil, true
				continue
			}
			if strings.HasPrefix(line, "count    =") || strings.HasPrefix(line, "Trace file") || strings.HasPrefix(line, "TKPROF") {
				continue
			}
			// a statement without an SQL ID line: the text starts here
			cur = nil
			text, inText = []string{line}, true
			continue
		}
		if m := reCall.FindStringSubmatch(line); m != nil {
			c := TkprofCalls{Count: atoi(m[2]), CPU: atof(m[3]), Elapsed: atof(m[4]), Disk: atoi(m[5]), Query: atoi(m[6]), Current: atoi(m[7]), Rows: atoi(m[8])}
			var dst *TkprofCalls
			switch {
			case overall == "nonrec":
				dst = map[string]*TkprofCalls{"Parse": &r.NonRecParse, "Execute": &r.NonRecExec, "Fetch": &r.NonRecFetch, "total": &r.NonRecursive}[m[1]]
			case overall == "rec":
				dst = map[string]*TkprofCalls{"Parse": &r.RecParse, "Execute": &r.RecExec, "Fetch": &r.RecFetch, "total": &r.Recursive}[m[1]]
			case cur != nil:
				dst = map[string]*TkprofCalls{"Parse": &cur.Parse, "Execute": &cur.Execute, "Fetch": &cur.Fetch, "total": &cur.Total}[m[1]]
			}
			if dst != nil {
				dst.add(c)
			}
			continue
		}
		if cur != nil {
			if m := reMisses.FindStringSubmatch(line); m != nil {
				cur.Misses += atoi(m[1])
				continue
			}
			if m := reDepth.FindStringSubmatch(line); m != nil {
				cur.Depth = int(atoi(m[1]))
				continue
			}
			if strings.HasPrefix(line, "Elapsed times include waiting") {
				inWaits = true
				continue
			}
			if inWaits {
				if m := reWait.FindStringSubmatch(line); m != nil {
					w := cur.Waits[m[1]]
					if w == nil {
						w = &TkprofWait{}
						cur.Waits[m[1]] = w
					}
					w.Times += atoi(m[2])
					w.Total += atof(m[4])
					if mx := atof(m[3]); mx > w.Max {
						w.Max = mx
					}
				}
			}
		}
	}
	return r, sc.Err()
}

func atoi(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func atof(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}
