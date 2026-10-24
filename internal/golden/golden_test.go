package golden

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// every version directory under testdata/traces (19c, 21c, 23ai, ...) is compared
const fixtures = "../../testdata/traces"

func secs(us int64) float64 { return float64(us) / 1e6 }

// tkprof prints seconds with 2 decimals and rounds each statement section;
// allow 0.01 s per section plus a little.
func closeEnough(got, want float64, sections int) bool {
	return math.Abs(got-want) <= 0.011*float64(sections)+0.001
}

func TestAgainstTkprof(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(fixtures, "*", "*.trc"))
	if len(files) == 0 {
		t.Skip("no fixtures")
	}
	for _, trc := range files {
		name := filepath.Base(filepath.Dir(trc)) + "/" + strings.TrimSuffix(filepath.Base(trc), ".trc")
		tk := strings.TrimSuffix(trc, ".trc") + ".tkprof.txt"
		if _, err := os.Stat(tk); err != nil {
			continue
		}
		t.Run(name, func(t *testing.T) {
			ref, err := ParseTkprof(tk)
			if err != nil {
				t.Fatal(err)
			}
			m, err := model.Build(trc, model.Options{})
			if err != nil {
				t.Fatal(err)
			}
			stats := analyze.Statements(m)
			bySQLID := map[string]*analyze.StmtStats{}
			byText := map[string]*analyze.StmtStats{}
			for i := range stats {
				st := &m.Statements[i]
				if st.Kind == model.StmtSQL && st.SQLID != "" {
					bySQLID[st.SQLID] = &stats[i]
					byText[NormalizeText(st.Text)] = &stats[i]
				}
			}
			if len(ref.Stmts) == 0 {
				t.Fatalf("tkprof output has no statements")
			}
			// statements sharing a cursor number with a PARSE ERROR: tkprof puts the
			// error's waits (SQL*Net break/reset) on them, we put them on the failed statement
			perrNumbers := map[string]bool{}
			for _, e := range m.Errors {
				if !e.ParseError {
					continue
				}
				num := m.Cursors[e.Cursor].Number
				for i := range m.Cursors {
					if m.Cursors[i].Number == num {
						perrNumbers[m.Statements[m.Cursors[i].Statement].SQLID] = true
					}
				}
			}
			assumedNumbers := map[uint64]bool{}
			for i := range m.Cursors {
				if m.Cursors[i].Assumed {
					assumedNumbers[m.Cursors[i].Number] = true
				}
			}
			for _, id := range ref.Order {
				r := ref.Stmts[id]
				s, ok := bySQLID[id]
				if !ok {
					s, ok = byText[NormalizeText(r.Text)]
				}
				if !ok {
					// tkprof cuts statement text at a literal "END OF STMT" line: prefix match
					nt := NormalizeText(r.Text)
					for k, v := range byText {
						if strings.HasPrefix(k, nt) {
							s, ok = v, true
							t.Logf("%s matched by text prefix", nt[:40])
							break
						}
					}
				}
				if !ok {
					t.Errorf("%s: in tkprof but not in model (text %.60q)", id, r.Text)
					continue
				}
				if r.SQLID == "" {
					id = m.Statements[s.ID].SQLID + " (matched by text)"
				}
				// Split traces (TRACE CONTINUED FROM FILE): a parent call that started
				// before this file does not get its children subtracted by tkprof; we
				// do subtract them (the children demonstrably ran inside it).
				// Cursor numbers are reused: a later statement that runs on the number of
				// an assumed cursor deviates the same way (23ai midtrace_start: tkprof
				// reports 2 query for 3 executes that all ran, with their children,
				// inside the file; the model's 0 self is the arithmetic the trace gives).
				adopted := false
				for _, cid := range m.Statements[s.ID].Cursors {
					if assumedNumbers[m.Cursors[cid].Number] {
						adopted = true
					}
				}
				check := func(kind string, got analyze.CallStats, want TkprofCalls) {
					pre := fmt.Sprintf("%s %s:", id, kind)
					if got.Count != want.Count {
						t.Errorf("%s count got %d want %d", pre, got.Count, want.Count)
					}
					if adopted && len(m.File.ContinuedFrom) > 0 {
						return
					}
					if got.SelfDisk != want.Disk || got.SelfQuery != want.Query || got.SelfCurrent != want.Current || got.Rows != want.Rows {
						t.Errorf("%s disk/query/current/rows got %d/%d/%d/%d want %d/%d/%d/%d (inclusive %d/%d/%d)", pre, got.SelfDisk, got.SelfQuery, got.SelfCurrent, got.Rows, want.Disk, want.Query, want.Current, want.Rows, got.Disk, got.Query, got.Current)
					}
					if !closeEnough(secs(got.SelfCPU), want.CPU, r.Sections) {
						t.Errorf("%s cpu got %.4f want %.2f (inclusive %.4f)", pre, secs(got.SelfCPU), want.CPU, secs(got.CPU))
					}
					if !closeEnough(secs(got.SelfElapsed), want.Elapsed, r.Sections) {
						t.Errorf("%s elapsed got %.4f want %.2f (inclusive %.4f)", pre, secs(got.SelfElapsed), want.Elapsed, secs(got.Elapsed))
					}
				}
				check("parse", s.Parse, r.Parse)
				check("exec", s.Exec, r.Execute)
				check("fetch", s.Fetch, r.Fetch)
				check("total", s.Total, r.Total)
				if s.HardParses != r.Misses {
					t.Errorf("%s misses got %d want %d", id, s.HardParses, r.Misses)
				}
				// waits: tkprof counts waits by statement (cursor at wait time)
				if perrNumbers[m.Statements[s.ID].SQLID] {
					continue
				}
				got := analyze.WaitsByEvent(m, func(w *model.Wait) bool { return w.Statement == s.ID })
				gotBy := map[string]analyze.EventAgg{}
				for _, g := range got {
					gotBy[g.Name] = g
				}
				for ev, w := range r.Waits {
					g, ok := gotBy[ev]
					if !ok {
						t.Errorf("%s wait %q: tkprof %d waits, model none", id, ev, w.Times)
						continue
					}
					if g.Count != w.Times {
						t.Errorf("%s wait %q: count got %d want %d", id, ev, g.Count, w.Times)
					}
					if !closeEnough(secs(g.Us), w.Total, r.Sections) {
						t.Errorf("%s wait %q: total got %.4f want %.2f", id, ev, secs(g.Us), w.Total)
					}
				}
				for ev, g := range gotBy {
					if _, ok := r.Waits[ev]; !ok {
						t.Errorf("%s wait %q: model %d waits, tkprof none", id, ev, g.Count)
					}
				}
			}
			// overall totals: tkprof non-recursive = statements at depth 0
			var nonrec, rec analyze.CallStats
			for i := range stats {
				st := &m.Statements[i]
				if st.Kind != model.StmtSQL {
					continue
				}
				if stats[i].MinDep == 0 {
					nonrec.Count += stats[i].Total.Count
					nonrec.Elapsed += stats[i].Total.SelfElapsed
					nonrec.Disk += stats[i].Total.SelfDisk
					nonrec.Query += stats[i].Total.SelfQuery
					nonrec.Rows += stats[i].Total.Rows
				} else {
					rec.Count += stats[i].Total.Count
					rec.Elapsed += stats[i].Total.SelfElapsed
					rec.Disk += stats[i].Total.SelfDisk
					rec.Query += stats[i].Total.SelfQuery
					rec.Rows += stats[i].Total.Rows
				}
			}
			if len(m.File.ContinuedFrom) > 0 {
				return // see above: tkprof does not subtract children of calls that started in the previous file
			}
			if nonrec.Count != ref.NonRecursive.Count || nonrec.Query != ref.NonRecursive.Query || nonrec.Rows != ref.NonRecursive.Rows {
				t.Errorf("non-recursive totals: count/query/rows got %d/%d/%d want %d/%d/%d", nonrec.Count, nonrec.Query, nonrec.Rows, ref.NonRecursive.Count, ref.NonRecursive.Query, ref.NonRecursive.Rows)
			}
			if rec.Count != ref.Recursive.Count || rec.Query != ref.Recursive.Query || rec.Rows != ref.Recursive.Rows {
				t.Errorf("recursive totals: count/query/rows got %d/%d/%d want %d/%d/%d", rec.Count, rec.Query, rec.Rows, ref.Recursive.Count, ref.Recursive.Query, ref.Recursive.Rows)
			}
			t.Logf("%s: %d tkprof statements compared, model: %d statements, %d calls, %d waits", name, len(ref.Stmts), len(m.Statements), len(m.Calls), len(m.Waits))
		})
	}
}
