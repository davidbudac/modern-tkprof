package slice

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

type atExec struct {
	Call, Cursor, ExecNo                                        int
	ExecFrom, ExecTo, PrevExec, NextExec, CursorLine, CloseLine int
	Object                                                      string
	Kind                                                        string
}

func (e *lineEnv) atExec(t *testing.T, file, line int) atExec {
	t.Helper()
	code, b := e.both(t, fmt.Sprintf("/api/at?file=%d&line=%d", file, line))
	if code != 200 {
		t.Fatalf("at file %d line %d: %d %s", file, line, code, b)
	}
	var r atExec
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestAtExecSpan(t *testing.T) {
	e := newLineEnv(t, []string{traces + "basic_binds.trc"})
	m := e.full
	// the calls of each cursor by execution
	byCursor := map[model.ID][]model.Call{}
	for _, c := range m.Calls {
		byCursor[c.Cursor] = append(byCursor[c.Cursor], c)
	}
	checked, withPrev, withNext := 0, 0, 0
	for cur, calls := range byCursor {
		var execs []model.Call
		for _, c := range calls {
			if c.Kind == trace.CallExec && c.ExecNo >= 1 {
				execs = append(execs, c)
			}
		}
		if len(execs) < 2 {
			continue
		}
		for _, x := range execs {
			// expected end: the last call of the execution that is not a PARSE or
			// CLOSE, plus the CLOSE that follows it
			end := x.Line
			for _, c := range calls {
				if c.ExecNo == x.ExecNo && c.Kind != trace.CallParse && c.Kind != trace.CallClose && c.Line > end {
					end = c.Line
				}
			}
			for _, c := range calls {
				if c.Line > end && c.Kind != trace.CallXctend {
					if c.Kind == trace.CallClose {
						end = c.Line
					}
					break
				}
			}
			start := x.Line
			if x.BindSet >= 0 && int32(m.BindSets[x.BindSet].Line) < start {
				start = int32(m.BindSets[x.BindSet].Line)
			}
			prev, next := -1, -1
			for _, o := range execs {
				if o.ExecNo == x.ExecNo-1 {
					prev = int(o.Line)
				}
				if o.ExecNo == x.ExecNo+1 {
					next = int(o.Line)
				}
			}
			want := atExec{Call: int(x.ID), Cursor: int(cur), ExecNo: int(x.ExecNo), ExecFrom: int(start), ExecTo: int(end), PrevExec: prev, NextExec: next, CursorLine: m.Cursors[cur].Line}
			lines := []int{int(x.Line)}
			if start != x.Line {
				lines = append(lines, int(start)) // the BINDS block
			}
			for _, c := range calls {
				if c.ExecNo == x.ExecNo && c.Kind == trace.CallFetch {
					lines = append(lines, int(c.Line))
				}
			}
			for _, l := range lines {
				got := e.atExec(t, fileOf(m, x.Context), l)
				if got.ExecFrom != want.ExecFrom || got.ExecTo != want.ExecTo || got.PrevExec != want.PrevExec || got.NextExec != want.NextExec ||
					got.CursorLine != want.CursorLine || got.Cursor != want.Cursor || got.ExecNo != want.ExecNo {
					t.Fatalf("cursor %d exec %d at line %d: got %+v, want %+v", cur, x.ExecNo, l, got, want)
				}
				if !(got.ExecFrom <= l && l <= got.ExecTo) {
					t.Fatalf("line %d outside its span %d..%d", l, got.ExecFrom, got.ExecTo)
				}
			}
			checked++
			if prev >= 0 {
				withPrev++
			}
			if next >= 0 {
				withNext++
			}
		}
	}
	if checked == 0 || withPrev == 0 || withNext == 0 {
		t.Fatalf("checked %d executions, %d with prev, %d with next", checked, withPrev, withNext)
	}
	// the cursor line itself and the close line
	for _, c := range m.Cursors {
		if c.Implicit {
			continue
		}
		r := e.atExec(t, fileOf(m, c.Context), c.Line)
		if r.Kind == "parsing-in-cursor" && (r.CursorLine != c.Line || r.ExecFrom != -1) {
			t.Fatalf("cursor %d: %+v", c.ID, r)
		}
	}
	for cur, calls := range byCursor {
		for _, c := range calls {
			if c.Kind != trace.CallClose {
				continue
			}
			// a CLOSE line answers itself; the exec lines before it see it
			if r := e.atExec(t, fileOf(m, c.Context), int(c.Line)); r.CloseLine != int(c.Line) || r.Cursor != int(cur) {
				t.Fatalf("close of cursor %d at line %d: %+v", cur, c.Line, r)
			}
			break
		}
	}
}

// TestAtExecSpanAllFixtures checks the invariants of the exec fields on every
// fixture, with the model-backed and the spill-backed server.
func TestAtExecSpanAllFixtures(t *testing.T) {
	for name, paths := range fixtureSets(t) {
		t.Run(name, func(t *testing.T) {
			e := newLineEnv(t, paths)
			m := e.full
			for _, c := range sample(m.Calls, 300) {
				if c.Synthetic {
					continue
				}
				r := e.atExec(t, fileOf(m, c.Context), int(c.Line))
				if r.Call != int(c.ID) {
					continue
				}
				if c.ExecNo >= 1 {
					if r.ExecFrom < 0 || r.ExecTo < r.ExecFrom || int(c.Line) < r.ExecFrom || int(c.Line) > r.ExecTo {
						t.Fatalf("call %d line %d: span %d..%d", c.ID, c.Line, r.ExecFrom, r.ExecTo)
					}
				} else if r.ExecFrom != -1 || r.ExecTo != -1 || r.PrevExec != -1 || r.NextExec != -1 {
					t.Fatalf("call %d (exec %d): %+v", c.ID, c.ExecNo, r)
				}
				if r.PrevExec >= r.ExecFrom && r.PrevExec != -1 || r.NextExec != -1 && r.NextExec <= r.ExecTo {
					t.Fatalf("call %d: neighbours %d / %d inside span %d..%d", c.ID, r.PrevExec, r.NextExec, r.ExecFrom, r.ExecTo)
				}
				if r.CloseLine != -1 && r.CloseLine < int(c.Line) {
					t.Fatalf("call %d: close line %d before it", c.ID, r.CloseLine)
				}
			}
			for _, w := range sample(m.Waits, 100) {
				if r := e.atExec(t, fileOf(m, w.Context), int(w.Line)); r.Object != "" {
					t.Fatalf("object %q without a reference bundle", r.Object)
				}
			}
		})
	}
}

// nextWalk follows lines/next from `from` until 404 and returns the lines.
func (e *lineEnv) nextWalk(t *testing.T, file int, what string, dir, from int) []int {
	t.Helper()
	var out []int
	for len(out) < 1<<20 {
		code, b := e.both(t, fmt.Sprintf("/api/lines/next?file=%d&from=%d&what=%s&dir=%d", file, from, what, dir))
		if code == 404 {
			return out
		}
		if code != 200 {
			t.Fatalf("lines/next %s: %d %s", what, code, b)
		}
		var r struct{ Line int }
		if err := json.Unmarshal(b, &r); err != nil {
			t.Fatal(err)
		}
		if dir > 0 && r.Line <= from || dir < 0 && r.Line >= from {
			t.Fatalf("lines/next %s dir %d from %d answered %d", what, dir, from, r.Line)
		}
		out = append(out, r.Line)
		from = r.Line
	}
	t.Fatal("lines/next does not end")
	return nil
}

func distinctSorted(x []int) []int {
	sort.Ints(x)
	out := x[:0:0]
	for i, v := range x {
		if i == 0 || v != x[i-1] {
			out = append(out, v)
		}
	}
	return out
}

func reversed(x []int) []int {
	out := make([]int, len(x))
	for i, v := range x {
		out[len(x)-1-i] = v
	}
	return out
}

func TestLinesNext(t *testing.T) {
	for name, paths := range fixtureSets(t) {
		t.Run(name, func(t *testing.T) {
			e := newLineEnv(t, paths)
			m := e.full
			for fi := range e.lis {
				want := map[string][]int{}
				for _, c := range m.Calls {
					if fileOf(m, c.Context) == fi {
						want["call"] = append(want["call"], int(c.Line))
					}
				}
				for _, w := range m.Waits {
					if fileOf(m, w.Context) == fi {
						want["wait"] = append(want["wait"], int(w.Line))
					}
				}
				for _, c := range m.Cursors {
					if !c.Implicit && fileOf(m, c.Context) == fi {
						want["cursor"] = append(want["cursor"], c.Line)
					}
				}
				for _, c := range m.Contexts {
					if c.FileIdx == fi {
						want["ctx"] = append(want["ctx"], c.Line)
					}
				}
				for _, x := range m.Errors {
					if fileOf(m, x.Context) == fi {
						want["error"] = append(want["error"], x.Line)
					}
				}
				text := fileLines(t, m.File.Files[fi].Path)
				// commits: the model's transactions, each of which must be an
				// XCTEND line of the text; every XCTEND line of the text is one
				// except in nasty_sql.trc, whose fake trace lines sit in SQL text
				for _, x := range m.Transactions {
					if fileOf(m, x.Context) == fi {
						if !strings.HasPrefix(text[x.Line-1], "XCTEND") {
							t.Fatalf("transaction at line %d is %q", x.Line, text[x.Line-1])
						}
						want["commit"] = append(want["commit"], x.Line)
					}
				}
				if !strings.Contains(name, "nasty_sql") {
					var grep []int
					for i, l := range text {
						if strings.HasPrefix(l, "XCTEND") {
							grep = append(grep, i+1)
						}
					}
					if !reflect.DeepEqual(grep, distinctSorted(append([]int(nil), want["commit"]...))) {
						t.Fatalf("file %d: XCTEND lines %v, transactions %v", fi, head(grep), head(want["commit"]))
					}
				}
				for _, what := range []string{"call", "wait", "cursor", "ctx", "error", "commit"} {
					w := distinctSorted(want[what])
					got := e.nextWalk(t, fi, what, 1, 0)
					if len(w) == 0 && len(got) == 0 {
						continue
					}
					if !reflect.DeepEqual(got, w) {
						t.Fatalf("file %d %s: walk forward gave %d lines, want %d (first diff near %v / %v)", fi, what, len(got), len(w), head(got), head(w))
					}
					back := e.nextWalk(t, fi, what, -1, len(text)+1)
					if !reflect.DeepEqual(back, reversed(w)) {
						t.Fatalf("file %d %s: walk backward differs (%d lines, want %d)", fi, what, len(back), len(w))
					}
				}
			}
		})
	}
}

func head(x []int) []int { return x[:min(len(x), 5)] }

func TestLinesNextSpecifics(t *testing.T) {
	e := newLineEnv(t, []string{traces + "io_waits.trc"})
	m := e.full
	if len(m.Calls) == 0 || len(m.Waits) == 0 {
		t.Fatal("io_waits has no rows")
	}
	if len(e.nextWalk(t, 0, "error", 1, 0)) != 0 {
		t.Fatal("io_waits has errors; pick another fixture")
	}
	// a file without errors: 404 either way
	for _, dir := range []string{"1", "-1"} {
		if code, _ := e.both(t, "/api/lines/next?file=0&from=5&what=error&dir="+dir); code != 404 {
			t.Errorf("error dir %s: %d", dir, code)
		}
	}
	for _, u := range []string{
		"/api/lines/next?file=0&from=0&dir=1",
		"/api/lines/next?file=0&from=0&what=nope&dir=1",
		"/api/lines/next?file=0&from=0&what=call",
		"/api/lines/next?file=0&from=0&what=call&dir=2",
		"/api/lines/next?file=0&from=-3&what=call&dir=1",
	} {
		if code, _ := e.both(t, u); code != 400 {
			t.Errorf("%s: %d, want 400", u, code)
		}
	}
	if code, _ := e.both(t, "/api/lines/next?file=9&from=0&what=call&dir=1"); code != 404 {
		t.Errorf("no such file: %d", code)
	}
	// strictly after / before: from on a call line steps past it
	first := int(m.Calls[0].Line)
	for _, c := range m.Calls {
		if int(c.Line) < first {
			first = int(c.Line)
		}
	}
	if code, _ := e.both(t, fmt.Sprintf("/api/lines/next?file=0&from=%d&what=call&dir=-1", first)); code != 404 {
		t.Errorf("before the first call: %d", code)
	}
	// errors on a fixture that has them
	e2 := newLineEnv(t, []string{traces + "errors.trc"})
	if len(e2.full.Errors) == 0 {
		t.Fatal("errors.trc has no errors")
	}
	var want []int
	for _, x := range e2.full.Errors {
		want = append(want, x.Line)
	}
	if got := e2.nextWalk(t, 0, "error", 1, 0); !reflect.DeepEqual(got, distinctSorted(want)) {
		t.Errorf("errors: %v, want %v", got, distinctSorted(want))
	}
}

type atBinds struct {
	BindSet  int
	BindLine int
	Binds    []BindRow
	Kind     string
}

func (e *lineEnv) atBinds(t *testing.T, file, line int) atBinds {
	t.Helper()
	code, b := e.both(t, fmt.Sprintf("/api/at?file=%d&line=%d", file, line))
	if code != 200 {
		t.Fatalf("at file %d line %d: %d %s", file, line, code, b)
	}
	var r atBinds
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

// TestAtBinds: every line of a BINDS block, the header, the ` Bind#`, the
// `value=` lines and the continuation lines of memory dumps, answers the bind
// set of the block, the line of its header and its decoded values.
func TestAtBinds(t *testing.T) {
	for _, name := range []string{"basic_binds", "bind_types"} {
		t.Run(name, func(t *testing.T) {
			e := newLineEnv(t, []string{traces + name + ".trc"})
			m := e.full
			sets, valueLines, cont := 0, 0, 0
			for _, bs := range m.BindSets {
				if bs.Call < 0 || bs.N == 0 {
					continue
				}
				file := fileOf(m, m.Calls[bs.Call].Context)
				li := e.lis[file]
				// the block: the lines after the header up to the first recognised
				// line that is not a bind line
				end := bs.Line
				for l := bs.Line + 1; l <= li.Lines(); l++ {
					raw, err := li.Read(l, 1)
					if err != nil {
						t.Fatal(err)
					}
					k, _ := trace.Classify(splitLines(raw)[0], false)
					if k != trace.KindUnknown && k != trace.KindBlank && k != trace.KindBindLine {
						break
					}
					end = l
				}
				want := m.Binds[bs.First : bs.First+bs.N]
				for l := bs.Line; l <= end; l++ {
					r := e.atBinds(t, file, l)
					if r.BindSet != int(bs.ID) || r.BindLine != bs.Line || len(r.Binds) != len(want) {
						t.Fatalf("line %d of block %d (header %d): got set %d header %d with %d binds (%s), want %d binds", l, bs.ID, bs.Line, r.BindSet, r.BindLine, len(r.Binds), r.Kind, len(want))
					}
					if r.Kind == "unknown" {
						cont++
					}
					if r.Kind == "bind-line" {
						raw, _ := li.Read(l, 1)
						if strings.HasPrefix(string(raw), "  value=") {
							valueLines++
						}
					}
				}
				for i, b := range want {
					if got := e.atBinds(t, file, bs.Line).Binds[i]; got.Pos != b.Pos || got.Value != b.Value || got.Type != b.TypeName() || got.Typed != b.Typed() || got.Kind != b.Kind().String() {
						t.Fatalf("set %d bind %d: got %+v, want %+v", bs.ID, i, got, b)
					}
				}
				sets++
			}
			if sets == 0 || valueLines == 0 {
				t.Fatalf("checked %d sets, %d value lines", sets, valueLines)
			}
			if name == "bind_types" && cont == 0 {
				t.Fatalf("no continuation line of a bind block was checked")
			}
			t.Logf("%d sets, %d value lines, %d continuation lines", sets, valueLines, cont)
		})
	}
}
