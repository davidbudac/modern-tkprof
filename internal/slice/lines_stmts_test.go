package slice

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// stmtEnv is a model-backed server with the line indexes of a trace set.
type stmtEnv struct {
	m   *model.Model
	s   *Server
	lis []*trace.LineIndex
}

func newStmtEnv(t testing.TB, paths []string) *stmtEnv {
	t.Helper()
	m, err := model.BuildFiles(paths, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	e := &stmtEnv{m: m}
	for _, fe := range m.File.Files {
		li, err := trace.OpenLineIndex(fe.Path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { li.Close() })
		e.lis = append(e.lis, li)
	}
	e.s = New(m).WithLines(e.lis)
	return e
}

// annotStmts is the statement id that annot=2 pages give every line of file fi
// (index line-1), -1 where the line has none.
func (e *stmtEnv) annotStmts(t testing.TB, fi int) []int32 {
	out, _ := e.annotStmtsKinds(t, fi)
	return out
}

// annotStmtsKinds is annotStmts with the kind of each line too.
func (e *stmtEnv) annotStmtsKinds(t testing.TB, fi int) ([]int32, []string) {
	t.Helper()
	li, f := e.lis[fi], &e.s.files()[fi]
	out := make([]int32, 0, li.Lines())
	kinds := make([]string, 0, li.Lines())
	for from := 1; from <= li.Lines(); from += 2000 {
		lines, err := e.s.annotate2(li, f, from, 2000)
		if err != nil {
			t.Fatal(err)
		}
		for _, l := range lines {
			kinds = append(kinds, l.K)
			if l.annotIDs == nil {
				out = append(out, -1)
			} else {
				out = append(out, l.S)
			}
		}
	}
	return out, kinds
}

// swallowedBlocks is the SQLT trace, whose first PL/SQL block has a len= that
// the text does not reach, so the parser reads on over its END OF STMT and takes
// the next PARSE, rule and PARSING IN CURSOR blocks for statement text: those
// blocks (PIC, SQL text and END OF STMT lines, about a hundred lines in all) have no cursor
// of their own in the model. annot=2 gives them the cursor before; the line map
// the call before. Every other fixture agrees to the line.
const swallowedBlocks = "big/orcl_ora_3484_S94737_SQLT_TRACE"

// lineStmtSets are the trace sets the line/statement tests run on: every fixture
// set, plus the 112k-line SQLT trace when it is there.
func lineStmtSets(t *testing.T) map[string][]string {
	sets := fixtureSets(t)
	if big := "../../testdata/big/orcl_ora_3484_S94737_SQLT_TRACE.trc"; !testing.Short() {
		if _, err := os.Stat(big); err == nil {
			sets["big/orcl_ora_3484_S94737_SQLT_TRACE"] = []string{big}
		}
	}
	return sets
}

// TestAnnotStmtIDs audits the per-line statement id of annot=2 pages (the ids
// the Trace pane highlights a statement by) against the model's own rows: every
// kind of line of a cursor must answer its statement: the PARSING IN CURSOR
// line, the SQL text lines and END OF STMT, the call lines, the WAIT lines, the
// BINDS header, its Bind# lines and attribute lines, the STAT lines and ERROR
// lines. Framing lines (blank, =====, ***) take the call before them and are not
// checked.
func TestAnnotStmtIDs(t *testing.T) {
	for name, paths := range lineStmtSets(t) {
		t.Run(name, func(t *testing.T) {
			e := newStmtEnv(t, paths)
			m := e.m
			for fi := range e.lis {
				got := e.annotStmts(t, fi)
				inFile := func(ctx model.ID) bool {
					return ctx >= 0 && int(ctx) < len(m.Contexts) && m.Contexts[ctx].FileIdx == fi
				}
				bad := map[string][]string{}
				checked := map[string]int{}
				check := func(kind string, line int, want model.ID) {
					if line < 1 || line > len(got) || want < 0 {
						return
					}
					checked[kind]++
					if got[line-1] != int32(want) {
						bad[kind] = append(bad[kind], fmt.Sprintf("line %d: annot s=%d, model %d", line, got[line-1], want))
					}
				}
				for i := range m.Calls {
					if c := &m.Calls[i]; inFile(c.Context) {
						check("call", int(c.Line), c.Statement)
					}
				}
				for i := range m.Waits {
					if w := &m.Waits[i]; inFile(w.Context) {
						check("wait", int(w.Line), w.Statement)
					}
				}
				for i := range m.Errors {
					if x := &m.Errors[i]; inFile(x.Context) {
						check("error", x.Line, x.Statement)
					}
				}
				// (a plan sits in the file of its cursor or a later one of a chain: the server's own list says which)
				for _, pl := range e.s.files()[fi].plans {
					p := &m.Plans[pl.id]
					for n := 0; n < int(p.N); n++ {
						check("stat", p.Line+n, p.Statement)
					}
				}
				for i := range m.Cursors {
					c := &m.Cursors[i]
					if c.Implicit || c.Line < 1 || !inFile(c.Context) {
						continue
					}
					check("cursor", c.Line, c.Statement)
					if c.Line > 1 { // the `=====` rule directly above a cursor's first line is the cursor's
						if prev, err := e.lis[fi].Read(c.Line-1, 1); err != nil {
							t.Fatal(err)
						} else if k := trace.NewClassifier(c.Line-1 == 1).Next(splitLines(prev)[0]); k == trace.KindSeparator {
							check("rule", c.Line-1, c.Statement)
						}
					}
					if st := &m.Statements[c.Statement]; st.Kind == model.StmtParseError { // PARSE ERROR: the SQL text follows the line, no terminator
						for j := 1; j <= strings.Count(st.Text, "\n")+1; j++ {
							check("parse-error text", c.Line+j, c.Statement)
						}
						continue
					}
					// the text lines and END OF STMT: classify from the cursor's line
					raw, err := e.lis[fi].Read(c.Line, min(maxStmtLines, e.lis[fi].Lines()-c.Line+1))
					if err != nil {
						t.Fatal(err)
					}
					cl := trace.NewClassifier(false)
					for j, l := range splitLines(raw) {
						k := cl.Next(l)
						if j == 0 {
							continue
						}
						if k == trace.KindSQLText {
							check("sqltext", c.Line+j, c.Statement)
						} else {
							if k == trace.KindEndOfStmt {
								check("endofstmt", c.Line+j, c.Statement)
							}
							break
						}
					}
				}
				// every PARSING IN CURSOR block of the text, whether or not the model has a cursor at its line (a cursor open before the
				// tracing started is adopted by the first block parsed under its number): the statement is the one with the block's sqlid
				bySQLID := map[string]model.ID{}
				for i := range m.Statements {
					if id := m.Statements[i].SQLID; id != "" {
						bySQLID[id] = m.Statements[i].ID
					}
				}
				{
					li := e.lis[fi]
					raw, err := li.Read(1, li.Lines())
					if err != nil {
						t.Fatal(err)
					}
					cl := trace.NewClassifier(true)
					var want model.ID = -1
					for j, l := range splitLines(raw) {
						switch k := cl.Next(l); k {
						case trace.KindParsingInCursor:
							want = -1
							if x := bytes.Index(l, []byte("sqlid='")); x >= 0 {
								if y := bytes.IndexByte(l[x+7:], '\''); y >= 0 {
									if id, ok := bySQLID[string(l[x+7:x+7+y])]; ok {
										want = id
									}
								}
							}
							check("pic-block", j+1, want)
						case trace.KindSQLText, trace.KindEndOfStmt:
							check("pic-block", j+1, want)
						}
					}
				}
				// the BINDS blocks: header, Bind# lines, attribute lines
				seen := map[int]bool{}
				for i := range m.Calls {
					c := &m.Calls[i]
					if !inFile(c.Context) || c.BindSet < 0 {
						continue
					}
					hdr, ok := e.s.src.BindSetLine(c.BindSet)
					if !ok || hdr < 1 || seen[hdr] {
						continue
					}
					seen[hdr] = true
					end, _, isBlock, err := bindBlockEnd(e.lis[fi], hdr)
					if err != nil {
						t.Fatal(err)
					}
					if !isBlock {
						continue
					}
					for n := hdr; n <= end; n++ {
						check("binds", n, c.Statement)
					}
				}
				var kinds []string
				for k := range checked {
					kinds = append(kinds, k)
				}
				sort.Strings(kinds)
				var sum []string
				for _, k := range kinds {
					sum = append(sum, fmt.Sprintf("%s %d", k, checked[k]))
				}
				t.Logf("file %d, %d lines: checked %s", fi, len(got), strings.Join(sum, ", "))
				for k, list := range bad {
					if k == "pic-block" && strings.HasPrefix(name, swallowedBlocks) && len(list) <= 60 {
						t.Logf("file %d: %d pic-block lines of blocks the parser did not read as cursors (known, see swallowedBlocks): %v", fi, len(list), list[:min(len(list), 3)])
						continue
					}
					t.Errorf("file %d: %d of %d %s lines have the wrong statement, e.g. %v", fi, len(list), checked[k], k, list[:min(len(list), 5)])
				}
			}
		})
	}
}

// TestStmtMapMatchesAnnot checks the file's line map (the base of
// /api/lines/stmts) against the statement id annot=2 gives each line, for every
// line of every file of every fixture set: the filter and the strip must show
// the lines the highlight tints.
func TestStmtMapMatchesAnnot(t *testing.T) {
	for name, paths := range lineStmtSets(t) {
		t.Run(name, func(t *testing.T) {
			e := newStmtEnv(t, paths)
			var sp *Server
			{
				agg, spill := buildSpilled(t, paths, t.TempDir())
				t.Cleanup(func() { spill.Close() })
				src, err := spill.Source()
				if err != nil {
					t.Fatal(err)
				}
				sp = NewServer(agg, src).WithLines(e.lis)
			}
			for fi := range e.lis {
				want, kinds := e.annotStmtsKinds(t, fi)
				start := time.Now()
				m, err := e.s.stmtMapOf(context.Background(), fi, e.lis[fi], &e.s.files()[fi])
				if err != nil {
					t.Fatal(err)
				}
				took := time.Since(start)
				if sp != nil { // the spill-backed server (what the engine runs) builds the same map
					m2, err := sp.stmtMapOf(context.Background(), fi, e.lis[fi], &sp.files()[fi])
					if err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(m.starts, m2.starts) || !reflect.DeepEqual(m.stmts, m2.stmts) {
						t.Fatalf("file %d: the spill-backed map differs from the model-backed one", fi)
					}
				}
				if m.total != len(want) {
					t.Fatalf("file %d: map has %d lines, file %d", fi, m.total, len(want))
				}
				got := make([]int32, 0, len(want))
				for r := range m.starts {
					if int(m.starts[r]) != len(got)+1 {
						t.Fatalf("file %d: run %d starts at %d, want %d", fi, r, m.starts[r], len(got)+1)
					}
					for n := int(m.starts[r]); n <= m.end(r); n++ {
						got = append(got, m.stmts[r])
					}
				}
				if len(got) != len(want) {
					t.Fatalf("file %d: runs cover %d lines of %d", fi, len(got), len(want))
				}
				var diffs []string
				ndiff := 0
				for i := range want {
					if got[i] != want[i] {
						ndiff++
						if len(diffs) < 8 {
							diffs = append(diffs, fmt.Sprintf("line %d: map %d, annot %d", i+1, got[i], want[i]))
						}
					}
				}
				t.Logf("file %d: %d lines, %d runs, built in %v, %d differ", fi, len(want), len(m.starts), took.Round(time.Microsecond), ndiff)
				if ndiff == 0 {
					continue
				}
				// the allowance: only the PIC / SQL text / END OF STMT lines of the blocks the parser read as text of the statement before them
				if name == swallowedBlocks {
					other := 0
					for i := range want {
						if got[i] != want[i] && kinds[i] != "parsing-in-cursor" && kinds[i] != "sql-text" && kinds[i] != "end-of-stmt" {
							other++
						}
					}
					if other == 0 && ndiff <= 120 {
						t.Logf("file %d: %d cursor-block lines differ (known, see swallowedBlocks)", fi, ndiff)
						continue
					}
				}
				t.Errorf("file %d: %d of %d lines differ, e.g. %v", fi, ndiff, len(want), diffs)
			}
		})
	}
}

// perLine expands a line map to the statement of every line (index line-1).
func (m *stmtLineMap) perLine() []int32 {
	out := make([]int32, 0, m.total)
	for r := range m.starts {
		for n := int(m.starts[r]); n <= m.end(r); n++ {
			out = append(out, m.stmts[r])
		}
	}
	return out
}

// pickStmts returns up to n statement ids that have lines, spread over the file, then an id without any.
func pickStmts(per []int32, n int) []int32 {
	seen := map[int32]bool{}
	var ids []int32
	for _, s := range per {
		if s >= 0 && !seen[s] {
			seen[s] = true
			ids = append(ids, s)
		}
	}
	ids = sample(ids, n)
	return append(ids, 1<<20)
}

func getJSON(t *testing.T, h http.Handler, url string, v any) int {
	t.Helper()
	code, body := fetch(h, url)
	if code == 200 {
		if err := json.Unmarshal(body, v); err != nil {
			t.Fatalf("%s: %v\n%s", url, err, body)
		}
	}
	return code
}

func joinIDs(ids []int32) string {
	var parts []string
	for _, id := range ids {
		parts = append(parts, strconv.Itoa(int(id)))
	}
	return strings.Join(parts, ",")
}

// TestLinesStmtsRoute checks the three answers of /api/lines/stmts against the per-line statements, on every fixture.
func TestLinesStmtsRoute(t *testing.T) {
	for name, paths := range lineStmtSets(t) {
		t.Run(name, func(t *testing.T) {
			e := newStmtEnv(t, paths)
			h := e.s.Handler()
			for fi := range e.lis {
				m, err := e.s.stmtMapOf(context.Background(), fi, e.lis[fi], &e.s.files()[fi])
				if err != nil {
					t.Fatal(err)
				}
				per := m.perLine()
				ids := pickStmts(per, 12)
				idq := joinIDs(ids)
				base := fmt.Sprintf("/api/lines/stmts?file=%d&ids=%s", fi, idq)

				// default: runs per statement, merged, in line order; lines is the whole-file count
				var got struct {
					Total int `json:"total"`
					Stmts []struct {
						ID    int32    `json:"id"`
						Lines int      `json:"lines"`
						Runs  [][2]int `json:"runs"`
					} `json:"stmts"`
					Truncated bool `json:"truncated"`
				}
				if c := getJSON(t, h, base, &got); c != 200 {
					t.Fatalf("%s: %d", base, c)
				}
				if got.Total != len(per) || got.Truncated || len(got.Stmts) != len(ids) {
					t.Fatalf("%s: total %d (want %d), truncated %v, %d statements (want %d)", base, got.Total, len(per), got.Truncated, len(got.Stmts), len(ids))
				}
				for i, st := range got.Stmts {
					if st.ID != ids[i] {
						t.Fatalf("statement %d is %d, want %d (the order asked for)", i, st.ID, ids[i])
					}
					var want [][2]int
					n := 0
					for line, s := range per {
						if s != st.ID {
							continue
						}
						n++
						if k := len(want); k > 0 && want[k-1][1] == line {
							want[k-1][1] = line + 1
						} else {
							want = append(want, [2]int{line + 1, line + 1})
						}
					}
					if want == nil {
						want = [][2]int{}
					}
					if st.Lines != n || !reflect.DeepEqual(st.Runs, want) {
						t.Fatalf("statement %d: lines %d runs %v, want lines %d runs %v", st.ID, st.Lines, st.Runs, n, want)
					}
				}

				// union: the merged runs of all
				var un struct {
					Total     int      `json:"total"`
					Lines     int      `json:"lines"`
					Runs      [][2]int `json:"runs"`
					Truncated bool     `json:"truncated"`
				}
				if c := getJSON(t, h, base+"&union=1", &un); c != 200 {
					t.Fatalf("union: %d", c)
				}
				in := map[int32]bool{}
				for _, id := range ids {
					in[id] = true
				}
				var wantU [][2]int
				nU := 0
				for line, s := range per {
					if !in[s] {
						continue
					}
					nU++
					if k := len(wantU); k > 0 && wantU[k-1][1] == line {
						wantU[k-1][1] = line + 1
					} else {
						wantU = append(wantU, [2]int{line + 1, line + 1})
					}
				}
				if wantU == nil {
					wantU = [][2]int{}
				}
				if un.Total != len(per) || un.Lines != nU || un.Truncated || !reflect.DeepEqual(un.Runs, wantU) {
					t.Fatalf("union: total %d lines %d truncated %v runs %v, want lines %d runs %v", un.Total, un.Lines, un.Truncated, un.Runs, nU, wantU)
				}

				// limit: the earliest runs in line order are kept, lines stays the whole-file count
				if len(wantU) > 2 {
					var cut struct {
						Lines     int      `json:"lines"`
						Runs      [][2]int `json:"runs"`
						Truncated bool     `json:"truncated"`
					}
					if c := getJSON(t, h, base+"&union=1&limit=2", &cut); c != 200 {
						t.Fatalf("union limit: %d", c)
					}
					if !cut.Truncated || cut.Lines != nU || !reflect.DeepEqual(cut.Runs, wantU[:2]) {
						t.Fatalf("union limit=2: %+v, want the first two of %v", cut, wantU)
					}
					var cutS struct {
						Stmts []struct {
							ID    int32    `json:"id"`
							Lines int      `json:"lines"`
							Runs  [][2]int `json:"runs"`
						} `json:"stmts"`
						Truncated bool `json:"truncated"`
					}
					if c := getJSON(t, h, base+"&limit=2", &cutS); c != 200 {
						t.Fatalf("limit: %d", c)
					}
					listed := 0
					for i, st := range cutS.Stmts {
						listed += len(st.Runs)
						if st.Lines != got.Stmts[i].Lines {
							t.Fatalf("limit=2: statement %d lines %d, want %d", st.ID, st.Lines, got.Stmts[i].Lines)
						}
					}
					all := 0
					for _, st := range got.Stmts {
						all += len(st.Runs)
					}
					if listed != min(2, all) || cutS.Truncated != (all > 2) {
						t.Fatalf("limit=2: %d runs listed of %d, truncated %v", listed, all, cutS.Truncated)
					}
				}

				// bins: the profile's bucket layout, a count of the statement's lines in each
				for _, b := range []int{1, 7, 200, 2000} {
					var bin struct {
						Total   int `json:"total"`
						Buckets int `json:"buckets"`
						Size    int `json:"size"`
						Stmts   []struct {
							ID     int32 `json:"id"`
							Lines  int   `json:"lines"`
							Counts []int `json:"counts"`
						} `json:"stmts"`
					}
					if c := getJSON(t, h, fmt.Sprintf("%s&bins=%d", base, b), &bin); c != 200 {
						t.Fatalf("bins=%d: %d", b, c)
					}
					var prof struct{ Buckets, Size int }
					getJSON(t, h, fmt.Sprintf("/api/lines/profile?file=%d&buckets=%d", fi, b), &prof)
					if bin.Total != len(per) || bin.Buckets != prof.Buckets || bin.Size != prof.Size || len(bin.Stmts) != len(ids) {
						t.Fatalf("bins=%d: total %d buckets %d size %d (profile %d, %d), %d statements", b, bin.Total, bin.Buckets, bin.Size, prof.Buckets, prof.Size, len(bin.Stmts))
					}
					for i, st := range bin.Stmts {
						want := make([]int, bin.Buckets)
						n := 0
						for line, s := range per {
							if s == ids[i] {
								want[line/bin.Size]++
								n++
							}
						}
						if st.ID != ids[i] || st.Lines != n || !reflect.DeepEqual(st.Counts, want) {
							t.Fatalf("bins=%d statement %d: lines %d counts %v, want %d %v", b, st.ID, st.Lines, st.Counts, n, want)
						}
					}
				}
				// the map is built once per file
				m2, _ := e.s.stmtMapOf(context.Background(), fi, e.lis[fi], &e.s.files()[fi])
				if m2 != m {
					t.Fatalf("file %d: the line map was built again", fi)
				}
			}
		})
	}
}

func TestLinesStmtsBadRequests(t *testing.T) {
	e := newStmtEnv(t, []string{traces + "basic_binds.trc"})
	h := e.s.Handler()
	for url, code := range map[string]int{
		"/api/lines/stmts":                                400, // ids is required
		"/api/lines/stmts?ids=":                           400,
		"/api/lines/stmts?ids=1,x":                        400,
		"/api/lines/stmts?ids=-1":                         400,
		"/api/lines/stmts?ids=1.5":                        400,
		"/api/lines/stmts?ids=1&limit=0":                  400,
		"/api/lines/stmts?ids=1&limit=500001":             400,
		"/api/lines/stmts?ids=1&bins=0":                   400,
		"/api/lines/stmts?ids=1&bins=2001":                400,
		"/api/lines/stmts?ids=1&bins=10&union=1":          400,
		"/api/lines/stmts?ids=1&union=yes":                400,
		"/api/lines/stmts?ids=1&file=9":                   404,
		"/api/lines/stmts?ids=1":                          200,
		"/api/lines/stmts?ids=1,1,2&union=0&limit=500000": 200,
		"/api/lines/stmts?ids=1&bins=2000":                200,
		"/api/lines/stmts?ids=1&union=true":               200,
	} {
		if c, body := fetch(h, url); c != code {
			t.Errorf("%s: %d, want %d (%s)", url, c, code, body)
		}
	}
	// duplicate ids are listed once, in the order given
	var got struct {
		Stmts []struct {
			ID int32 `json:"id"`
		} `json:"stmts"`
	}
	getJSON(t, h, "/api/lines/stmts?ids=2,1,2", &got)
	if len(got.Stmts) != 2 || got.Stmts[0].ID != 2 || got.Stmts[1].ID != 1 {
		t.Errorf("ids=2,1,2: %+v", got)
	}
	// too many ids
	var ids []string
	for i := 0; i <= maxStmtIDs; i++ {
		ids = append(ids, strconv.Itoa(i))
	}
	if c, _ := fetch(h, "/api/lines/stmts?ids="+strings.Join(ids, ",")); c != 400 {
		t.Errorf("%d ids: %d, want 400", len(ids), c)
	}
}

// BenchmarkStmtMapBuild is the cost of the line map of the SQLT trace (112k lines).
func BenchmarkStmtMapBuild(b *testing.B) {
	big := "../../testdata/big/orcl_ora_3484_S94737_SQLT_TRACE.trc"
	if _, err := os.Stat(big); err != nil {
		b.Skip("no big fixture")
	}
	e := newStmtEnv(b, []string{big})
	f := &e.s.files()[0]
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := e.s.buildStmtMap(context.Background(), 0, e.lis[0], f); err != nil {
			b.Fatal(err)
		}
	}
}
