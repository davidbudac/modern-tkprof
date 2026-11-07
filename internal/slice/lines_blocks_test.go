package slice

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// gapRef is the gap rule written the plain way: all rows of the (single-file)
// model by line; a call is compared with the previous call, a wait with the
// previous row of either kind. Returns the lines whose gap is >= min.
func (e *lineEnv) gapRef(min int64) []int {
	type row struct {
		line     int
		tim, dur int64
		wait     bool
	}
	var rows []row
	for _, c := range e.full.Calls {
		rows = append(rows, row{int(c.Line), c.Tim, c.E, false})
	}
	for _, w := range e.full.Waits {
		rows = append(rows, row{int(w.Line), w.Tim, w.Ela, true})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].line < rows[j].line })
	var out []int
	lastCall := -1
	for i, r := range rows {
		prev := -1
		if r.wait {
			prev = i - 1
		} else {
			prev = lastCall
		}
		if prev >= 0 && r.tim != 0 && rows[prev].tim != 0 && r.tim-r.dur-rows[prev].tim >= min { // tim=0: no time
			out = append(out, r.line)
		}
		if !r.wait {
			lastCall = i
		}
	}
	return out
}

func TestLinesNextGap(t *testing.T) {
	for _, name := range []string{"io_waits.trc", "basic_binds.trc", "stats_basic.trc"} { // stats_basic: WAIT lines with tim=0
		e := newLineEnv(t, []string{traces + name})
		for _, min := range []int64{1, 100, 1000, 10000, 1_000_000} {
			want := e.gapRef(min)
			url := func(from, dir int) string {
				return fmt.Sprintf("file=0&from=%d&what=gap&min=%d&dir=%d", from, min, dir)
			}
			// the walk forward from 0 visits exactly the reference lines
			var got []int
			for from := 0; ; {
				code, b := e.both(t, "/api/lines/next?"+url(from, 1))
				if code == 404 {
					break
				}
				var r struct{ Line int }
				if err := json.Unmarshal(b, &r); err != nil || code != 200 || r.Line <= from {
					t.Fatalf("%s min %d from %d: %d %s", name, min, from, code, b)
				}
				got = append(got, r.Line)
				from = r.Line
			}
			if fmt.Sprint(got) != fmt.Sprint(want) {
				t.Fatalf("%s min %d forward: got %v, want %v", name, min, got, want)
			}
			// and backward from past the end, in reverse
			var back []int
			for from := e.lis[0].Lines() + 1; ; {
				code, b := e.both(t, "/api/lines/next?"+url(from, -1))
				if code == 404 {
					break
				}
				var r struct{ Line int }
				if err := json.Unmarshal(b, &r); err != nil || code != 200 || r.Line >= from {
					t.Fatalf("%s min %d from %d: %d %s", name, min, from, code, b)
				}
				back = append(back, r.Line)
				from = r.Line
			}
			for i, j := 0, len(back)-1; i < j; i, j = i+1, j-1 {
				back[i], back[j] = back[j], back[i]
			}
			if fmt.Sprint(back) != fmt.Sprint(want) {
				t.Fatalf("%s min %d backward: got %v, want %v", name, min, back, want)
			}
			t.Logf("%s min %d: %v", name, min, got)
		}
	}
}

// TestLinesNextGapHandChecked pins gaps read off the fixtures by hand.
func TestLinesNextGapHandChecked(t *testing.T) {
	e := newLineEnv(t, []string{traces + "io_waits.trc"})
	next := func(e *lineEnv, q string) (int, int) {
		t.Helper()
		code, b := e.both(t, "/api/lines/next?file=0&what=gap&"+q)
		var r struct{ Line int }
		if code == 200 {
			if err := json.Unmarshal(b, &r); err != nil {
				t.Fatal(err)
			}
		}
		return code, r.Line
	}
	// line 263: WAIT 'enq: KO - fast object checkpoint' ela=2323426 tim=10807468202
	// starts at 10805144776; the row above (line 260) ends at tim 10805143671: gap 1105 µs.
	// Earlier rows: the call rows are compared with the previous call row and have
	// gaps below 1000 µs.
	if code, l := next(e, "from=0&dir=1&min=1000"); code != 200 || l != 263 {
		t.Errorf("io_waits min 1000 from 0: %d %d, want 263", code, l)
	}
	// min above the gap skips it; the next one is line 6887 ('Disk file operations I/O'
	// ela=23 tim=10807562757, the row above ends at 10807560033: gap 2701 µs)
	if code, l := next(e, "from=263&dir=1&min=1000"); code != 200 || l != 6887 {
		t.Errorf("io_waits min 1000 from 263: %d %d, want 6887", code, l)
	}
	// the boundary: 1105 is the gap, 1106 skips the row
	if code, l := next(e, "from=0&dir=1&min=1105"); code != 200 || l != 263 {
		t.Errorf("io_waits min 1105: %d %d, want 263", code, l)
	}
	if code, l := next(e, "from=0&dir=1&min=1106"); code != 200 || l != 6887 {
		t.Errorf("io_waits min 1106: %d %d, want 6887", code, l)
	}
	if code, l := next(e, "from=6887&dir=-1&min=1000"); code != 200 || l != 263 {
		t.Errorf("io_waits back from 6887: %d %d, want 263", code, l)
	}
	// the default min is one second: nothing in io_waits
	if code, _ := next(e, "from=0&dir=1"); code != 404 {
		t.Errorf("io_waits default min: %d, want 404", code)
	}
	// the ends
	if code, _ := next(e, "from=263&dir=-1&min=1000"); code != 404 {
		t.Errorf("before the first gap: %d, want 404", code)
	}
	if code, _ := next(e, "from=999999&dir=1&min=1"); code != 404 {
		t.Errorf("after the last row: %d, want 404", code)
	}
	for _, q := range []string{"min=0", "min=-5", "min=abc", "min=1.5"} {
		if code, _ := next(e, "from=0&dir=1&"+q); code != 400 {
			t.Errorf("%s: %d, want 400", q, code)
		}
	}

	// basic_binds line 89: PARSE e=278 tim=10778822085 starts at 10778821807; the
	// previous call row (line 84, tim 10778820802) leaves a gap of 1005 µs
	b := newLineEnv(t, []string{traces + "basic_binds.trc"})
	if code, l := next(b, "from=0&dir=1&min=1000"); code != 200 || l != 89 {
		t.Errorf("basic_binds min 1000 from 0: %d %d, want 89", code, l)
	}
	if code, l := next(b, "from=89&dir=1&min=1000"); code != 200 || l != 208 {
		t.Errorf("basic_binds min 1000 from 89: %d %d, want 208", code, l)
	}
	if code, _ := next(b, "from=0&dir=1"); code != 404 {
		t.Errorf("basic_binds default min: %d, want 404", code)
	}
}

type blocksAnswer struct {
	Blocks    [][2]int
	BindLines [][]int
	Texts     [][3]int
	Truncated bool
}

func (e *lineEnv) blocks(t *testing.T, file int, what string) blocksAnswer {
	t.Helper()
	code, b := e.both(t, fmt.Sprintf("/api/lines/blocks?file=%d&what=%s", file, what))
	if code != 200 {
		t.Fatalf("blocks %s: %d %s", what, code, b)
	}
	var r blocksAnswer
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestLinesBlocksBinds(t *testing.T) {
	e := newLineEnv(t, []string{traces + "basic_binds.trc"})
	got := e.blocks(t, 0, "binds")
	if got.Truncated {
		t.Error("truncated")
	}
	// BINDS #140124363561040: at line 53, bind lines up to value=1000 at line 69,
	// the WAIT at 70 is not part of it
	found := false
	for _, b := range got.Blocks {
		found = found || b == [2]int{53, 69}
	}
	if !found {
		t.Errorf("no block 53..69 in %v", got.Blocks)
	}
	// the Bind#N lines of each block: inside it, ascending, each a `Bind#` line
	if len(got.BindLines) != len(got.Blocks) {
		t.Fatalf("%d bindLines for %d blocks", len(got.BindLines), len(got.Blocks))
	}
	for i, b := range got.Blocks {
		prev := b[0]
		for _, l := range got.BindLines[i] {
			if l <= prev || l > b[1] {
				t.Fatalf("block %v: bind line %d after %d", b, l, prev)
			}
			raw, err := e.lis[0].Read(l, 1)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(strings.TrimSpace(string(splitLines(raw)[0])), "Bind#") {
				t.Fatalf("block %v: line %d is %q", b, l, raw)
			}
			prev = l
		}
	}
	// one block per BINDS header of the model, sorted, disjoint, each starting
	// at a BINDS line and ending on a non-blank line before the next record
	var hdrs []int
	for _, bs := range e.full.BindSets {
		if !bs.IsRPC {
			hdrs = append(hdrs, bs.Line)
		}
	}
	sort.Ints(hdrs)
	if len(got.Blocks) != len(hdrs) {
		t.Fatalf("%d blocks, %d bind sets", len(got.Blocks), len(hdrs))
	}
	for i, b := range got.Blocks {
		if b[0] != hdrs[i] || b[1] < b[0] || i > 0 && b[0] <= got.Blocks[i-1][1] {
			t.Fatalf("block %d: %v (header %d, previous %v)", i, b, hdrs[i], got.Blocks[max(i-1, 0)])
		}
		raw, err := e.lis[0].Read(b[0], b[1]-b[0]+2)
		if err != nil {
			t.Fatal(err)
		}
		lines := splitLines(raw)
		if k, _ := trace.Classify(lines[0], false); k != trace.KindBinds {
			t.Fatalf("block %v starts with %q", b, lines[0])
		}
		for _, l := range lines[1 : len(lines)-1] {
			if k, _ := trace.Classify(l, false); k != trace.KindBindLine && k != trace.KindUnknown && k != trace.KindBlank {
				t.Fatalf("block %v holds %q (%s)", b, l, k)
			}
		}
		if len(lines) == b[1]-b[0]+2 { // the line after the block
			if k, _ := trace.Classify(lines[len(lines)-1], false); k == trace.KindBindLine {
				t.Fatalf("block %v stops before a bind line", b)
			}
		}
	}
}

func TestLinesBlocksStat(t *testing.T) {
	e := newLineEnv(t, []string{traces + "basic_binds.trc"})
	got := e.blocks(t, 0, "stat")
	var want [][2]int
	for _, p := range e.full.Plans {
		want = append(want, [2]int{p.Line, p.Line + int(p.N) - 1})
	}
	sort.Slice(want, func(i, j int) bool { return want[i][0] < want[j][0] })
	if len(want) == 0 {
		t.Fatal("fixture has no plans")
	}
	if fmt.Sprint(got.Blocks) != fmt.Sprint(want) || got.Truncated {
		t.Fatalf("stat blocks %v, want %v", got.Blocks, want)
	}
	// every block is made of STAT lines
	for _, b := range got.Blocks {
		raw, err := e.lis[0].Read(b[0], b[1]-b[0]+1)
		if err != nil {
			t.Fatal(err)
		}
		for _, l := range splitLines(raw) {
			if k, _ := trace.Classify(l, false); k != trace.KindStat {
				t.Fatalf("stat block %v holds %q", b, l)
			}
		}
	}
	// a file without bind blocks answers an empty list, not null
	io := newLineEnv(t, []string{traces + "level_1.trc"})
	code, body := io.both(t, "/api/lines/blocks?file=0&what=binds")
	if code != 200 || string(body) != `{"blocks":[],"truncated":false}`+"\n" && string(body) != `{"blocks":[],"truncated":false}` {
		t.Errorf("empty answer: %d %q", code, body)
	}
}

func TestLinesBlocksErrors(t *testing.T) {
	e := newLineEnv(t, []string{traces + "basic_binds.trc"})
	for _, u := range []string{"/api/lines/blocks?file=0", "/api/lines/blocks?file=0&what=nope"} {
		if code, _ := e.both(t, u); code != 400 {
			t.Errorf("%s: %d, want 400", u, code)
		}
	}
	if code, _ := e.both(t, "/api/lines/blocks?file=9&what=stat"); code != 404 {
		t.Errorf("no such file: %d, want 404", code)
	}
}

// TestLinesBlocksAllFixtures: on every fixture both kinds answer sorted,
// disjoint ranges inside the file, identically from the model and the spill.
func TestLinesBlocksAllFixtures(t *testing.T) {
	for name, paths := range fixtureSets(t) {
		e := newLineEnv(t, paths)
		for file := range e.lis {
			for _, what := range []string{"binds", "stat", "frame"} {
				prev := 0
				for _, b := range e.blocks(t, file, what).Blocks {
					if b[0] <= prev || b[1] < b[0] || b[1] > e.lis[file].Lines() {
						t.Fatalf("%s file %d %s: block %v after line %d", name, file, what, b, prev)
					}
					prev = b[1]
				}
			}
		}
	}
}

// TestLinesBlocksFrame: `frame` lists the `=====` line before each PARSING IN
// CURSOR block and its END OF STMT line, each checked by classifying the lines.
func TestLinesBlocksFrame(t *testing.T) {
	e := newLineEnv(t, []string{traces + "io_waits.trc"})
	got := e.blocks(t, 0, "frame")
	if got.Truncated || len(got.Blocks) == 0 {
		t.Fatalf("frame blocks %v truncated=%v", got.Blocks, got.Truncated)
	}
	kindOf := func(line int) trace.Kind {
		k, _, err := kindAt(e.lis[0], line)
		if err != nil {
			t.Fatal(err)
		}
		return k
	}
	prev := 0
	rules, ends := 0, 0
	for _, b := range got.Blocks {
		if b[0] != b[1] || b[0] <= prev || b[1] > e.lis[0].Lines() {
			t.Fatalf("frame range %v after line %d", b, prev)
		}
		prev = b[1]
		switch kindOf(b[0]) {
		case trace.KindSeparator:
			rules++
			if kindOf(b[0]+1) != trace.KindParsingInCursor {
				t.Fatalf("rule %d is not followed by a PARSING IN CURSOR", b[0])
			}
		case trace.KindEndOfStmt:
			ends++
		default:
			t.Fatalf("frame range %v holds %v", b, kindOf(b[0]))
		}
	}
	// every PARSING IN CURSOR block of the file has both
	cursors := 0
	for _, c := range e.full.Cursors {
		if !c.Implicit {
			cursors++
		}
	}
	if rules != cursors || ends != cursors {
		t.Fatalf("%d rules and %d ends for %d cursors", rules, ends, cursors)
	}
	// io_waits.trc lines 83 (=====) and 86 (END OF STMT) frame the cursor parsed at line 84
	has := func(line int) bool {
		for _, b := range got.Blocks {
			if b[0] == line {
				return true
			}
		}
		return false
	}
	if !has(83) || !has(86) {
		t.Fatalf("frame blocks lack 83 and 86: %v", got.Blocks[:6])
	}
}

// TestLinesBlocksFrameTexts: `frame` also lists the SQL text of each statement
// that ends with an END OF STMT: the lines between its PARSING IN CURSOR line
// and that END OF STMT line (the first and last, and the statement id), whose
// text is the statement's text in the model line for line. A statement whose text
// holds an END OF STMT line of its own (nasty_sql.trc) is not listed.
func TestLinesBlocksFrameTexts(t *testing.T) {
	check := func(t *testing.T, e *lineEnv, file int) int {
		got := e.blocks(t, file, "frame")
		kindOf := func(line int) trace.Kind {
			k, _, err := kindAt(e.lis[file], line)
			if err != nil {
				t.Fatal(err)
			}
			return k
		}
		ends := map[int]bool{}
		for _, b := range got.Blocks {
			ends[b[0]] = kindOf(b[0]) == trace.KindEndOfStmt
		}
		prev := 0
		for _, x := range got.Texts {
			a, b, st := x[0], x[1], x[2]
			if a <= prev || b < a {
				t.Fatalf("text %v after line %d", x, prev)
			}
			prev = b
			if kindOf(a-1) != trace.KindParsingInCursor || !ends[b+1] {
				t.Fatalf("text %v: line %d is %v, line %d an END OF STMT range: %v", x, a-1, kindOf(a-1), b+1, ends[b+1])
			}
			for n := a; n <= b; n++ {
				if kindOf(n) != trace.KindSQLText {
					t.Fatalf("text %v: line %d is %v", x, n, kindOf(n))
				}
			}
			if st < 0 || st >= len(e.full.Statements) {
				t.Fatalf("text %v: statement %d of %d", x, st, len(e.full.Statements))
			}
			raw, err := e.lis[file].Read(a, b-a+1)
			if err != nil {
				t.Fatal(err)
			}
			if want, have := strings.TrimSuffix(string(raw), "\n"), e.full.Statements[st].Text; want != have {
				t.Fatalf("text %v: lines %q, statement %q", x, want, have)
			}
		}
		return len(got.Texts)
	}
	e := newLineEnv(t, []string{traces + "io_waits.trc"})
	if n := check(t, e, 0); n == 0 {
		t.Fatal("io_waits.trc: no texts")
	}
	got := e.blocks(t, 0, "frame")
	// line 84 is the PARSING IN CURSOR line, 85 its one text line, 86 the END OF STMT
	found := false
	for _, x := range got.Texts {
		found = found || (x[0] == 85 && x[1] == 85)
	}
	if !found {
		t.Fatalf("no text 85..85 in %v", got.Texts)
	}
	// the statement of nasty_sql.trc whose text holds a PARSING IN CURSOR and an END OF STMT line of its own: its lines 75..81 are not its text
	ne := newLineEnv(t, []string{traces + "nasty_sql.trc"})
	for _, x := range ne.blocks(t, 0, "frame").Texts {
		if x[0] == 75 {
			t.Fatalf("nasty_sql.trc: the text %v of the statement at line 74 is listed", x)
		}
	}
	for name, paths := range fixtureSets(t) {
		fe := newLineEnv(t, paths)
		for file := range fe.lis {
			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Fatalf("%s file %d: %v", name, file, r)
					}
				}()
				check(t, fe, file)
			}()
		}
	}
}
