package diag

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// callStacks gives the call stack readings of a file: every node whose reading is "callstack".
func callStacks(t testing.TB, r *Reader) []*CallStack {
	t.Helper()
	var out []*CallStack
	for _, n := range readingNodes(t, r) {
		if n.Reading != ReadingCallStack {
			continue
		}
		rd, err := r.Reading(n.ID)
		if err != nil {
			t.Fatalf("Reading(%s): %v", n.ID, err)
		}
		out = append(out, rd.(*CallStack))
	}
	return out
}

// rawLine is line n of the file as it is.
func rawLine(t testing.TB, r *Reader, n int) string {
	t.Helper()
	b, err := r.src.Read(n, 1)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimRight(string(b), "\r\n")
}

// TestCallStackFixtures pins what the reading says of each fixture that holds a diagnostic dump: the start
// line, the statement, the frames and where they came from, the rule for the dump's own frames and the first
// frame that is the process's.
func TestCallStackFixtures(t *testing.T) {
	type want struct {
		level, frames, own int
		first, sqlID       string
		plsql, cursors     int
		links              int
		hasErr             bool
	}
	cases := map[string]want{
		"diag_errorstack_l1": {1, 44, 10, "kkyase", "8fdx3ffur0ddr", 3, 0, 0, false},
		"diag_errorstack_l2": {2, 44, 10, "kkyase", "86trfcf9m9n9f", 3, 15, 1, false},
		"diag_deadlock":      {1, 32, 4, "ksqdld_hdr_dump", "3rfdph8nztm6u", 0, 17, 1, false},
		"diag_in_10046":      {2, 40, 11, "qcsprfro", "faaxujvpx61wd", 0, 14, 1, true},
	}
	for name, w := range cases {
		name, w := name, w
		t.Run(name, func(t *testing.T) {
			p := filepath.Join(diagDir, name+".trc")
			if name == "diag_in_10046" {
				p = filepath.Join(tracesDir, name+".trc")
			}
			r := readerOf(t, p)
			css := callStacks(t, r)
			if len(css) != 1 {
				t.Fatalf("%d call stack readings", len(css))
			}
			cs := css[0]
			if cs.Start.Line == 0 || cs.Start.Level != w.level || cs.Start.Incident || cs.Start.Flags != "0x0" || cs.Start.Mask != "0x0" {
				t.Errorf("start %+v", cs.Start)
			}
			if !strings.HasPrefix(rawLine(t, r, cs.Start.Line), "dbkedDefDump(): Starting a non-incident diagnostic dump") {
				t.Errorf("start line %d is %q", cs.Start.Line, rawLine(t, r, cs.Start.Line))
			}
			if cs.Statement == nil || cs.Statement.SQLID != w.sqlID || cs.Statement.Text == "" {
				t.Errorf("statement %+v", cs.Statement)
			}
			if len(cs.Frames) != w.frames || cs.FramesSource != "binary" || cs.BinaryFrames != w.frames || cs.TableFrames != w.frames {
				t.Errorf("%d frames, source %s, binary %d, table %d", len(cs.Frames), cs.FramesSource, cs.BinaryFrames, cs.TableFrames)
			}
			if cs.TableAgrees == nil || !*cs.TableAgrees {
				t.Errorf("the table does not agree with the binary frames: %v", cs.TableAgrees)
			}
			if cs.Own != w.own || cs.Frames[cs.Own].Function != w.first {
				t.Errorf("own %d, first frame of the process %q; want %d, %q", cs.Own, cs.Frames[cs.Own].Function, w.own, w.first)
			}
			if len(cs.PLSQL) != w.plsql || cs.CursorsTotal != w.cursors || len(cs.Links) != w.links || (cs.Error != nil) != w.hasErr {
				t.Errorf("plsql %d, cursors %d, links %d, error %v", len(cs.PLSQL), cs.CursorsTotal, len(cs.Links), cs.Error)
			}
			// the short stack: all frames, and without the dump's own
			if n := strings.Count(cs.ShortStack, "<-") + 1; n != len(cs.Frames) {
				t.Errorf("short stack has %d entries for %d frames", n, len(cs.Frames))
			}
			if n := strings.Count(cs.ShortStackNoOwn, "<-") + 1; n != len(cs.Frames)-cs.Own {
				t.Errorf("short stack without own has %d entries for %d frames", n, len(cs.Frames)-cs.Own)
			}
			if !strings.HasPrefix(cs.ShortStack, "ksedst1()+95<-ksedst()+58<-dbkedDefDump()+24347<-ksedmp()+577<-") {
				t.Errorf("short stack starts %.100s", cs.ShortStack)
			}
			if !strings.HasSuffix(cs.ShortStack, "<-__libc_start_main()+128<-_start()+37") || !strings.HasSuffix(cs.ShortStackNoOwn, "<-_start()+37") {
				t.Errorf("short stack ends ...%s", cs.ShortStack[len(cs.ShortStack)-60:])
			}
			// the frames of the dump itself are the leading ones
			for i, f := range cs.Frames {
				if f.Own != (i < cs.Own) {
					t.Errorf("frame %d own=%v with own count %d", f.N, f.Own, cs.Own)
				}
			}
		})
	}
}

// TestCallStackErrors: what each dump says about its error, as printed.
func TestCallStackErrors(t *testing.T) {
	// diag_in_10046 is written by an event on ORA-00942: its end says so, and its statement is the one that failed
	r := readerOf(t, filepath.Join(tracesDir, "diag_in_10046.trc"))
	cs := callStacks(t, r)[0]
	if cs.Error == nil || cs.Error.Signal == nil || cs.Error.Signal.Code != 942 || cs.Error.Signal.ORA != "ORA-00942" || cs.Error.Signal.Name != "MTK_NO_SUCH_TABLE" || len(cs.Error.Lines) != 0 {
		t.Fatalf("error %+v", cs.Error)
	}
	if rawLine(t, r, cs.Error.Signal.Line) != "about to signal 942" {
		t.Errorf("signal line %d is %q", cs.Error.Signal.Line, rawLine(t, r, cs.Error.Signal.Line))
	}
	if cs.Statement.SQLID != "faaxujvpx61wd" || !strings.Contains(cs.Statement.Text, "mtk_no_such_table") {
		t.Errorf("statement %+v", cs.Statement)
	}
	if len(cs.Barriers) != 1 || !strings.HasPrefix(cs.Barriers[0].Text, "<error barrier> at 0x") {
		t.Errorf("barriers %+v", cs.Barriers)
	}
	// the frame that raised it: the first of the process's frames is in the SQL parser
	if f := cs.Frames[cs.Own]; f.Function != "qcsprfro" || f.Component != "SQL_Parser" {
		t.Errorf("first frame %+v", f)
	}
	// a dump taken on request names no error, and the reading says so by having none
	for _, name := range []string{"diag_errorstack_l1", "diag_errorstack_l2", "diag_deadlock"} {
		c := callStacks(t, readerOf(t, filepath.Join(diagDir, name+".trc")))[0]
		if c.Error != nil {
			t.Errorf("%s: error %+v", name, c.Error)
		}
	}
	// the digest says it
	var b bytes.Buffer
	WriteDigest(&b, readerOf(t, filepath.Join(diagDir, "diag_errorstack_l2.trc")))
	if !strings.Contains(b.String(), "error: none named in the dump") {
		t.Errorf("the digest does not say the dump names no error")
	}
}

// TestCallStackLines: every line number of a reading is a line of its node, points at the line it names,
// and the frames are in file order.
func TestCallStackLines(t *testing.T) {
	files := append(fixtures(t), bigFixtures()...)
	n := 0
	for _, fx := range files {
		r := readerOf(t, fx)
		for _, cs := range callStacks(t, r) {
			n++
			in := func(what string, line int) {
				if line != 0 && (line < cs.From || line > cs.To) {
					t.Errorf("%s: %s line %d outside the node %d-%d", fixtureName(fx), what, line, cs.From, cs.To)
				}
			}
			in("start", cs.Start.Line)
			in("plsql title", cs.PLSQLLine)
			in("frames title", cs.FramesLine)
			for _, l := range cs.Barriers {
				in("barrier", l.Line)
				if !strings.Contains(rawLine(t, r, l.Line), "<error barrier>") {
					t.Errorf("%s: barrier line %d is %q", fixtureName(fx), l.Line, rawLine(t, r, l.Line))
				}
			}
			if e := cs.Error; e != nil {
				for _, l := range e.Lines {
					in("error", l.Line)
					if !strings.Contains(rawLine(t, r, l.Line), strings.TrimSpace(l.Text)) {
						t.Errorf("%s: error line %d", fixtureName(fx), l.Line)
					}
				}
				if e.Signal != nil {
					in("signal", e.Signal.Line)
				}
			}
			if s := cs.Statement; s != nil {
				in("statement", s.Title)
				if !strings.Contains(rawLine(t, r, s.Title), "Current SQL Statement") || !strings.Contains(rawLine(t, r, s.Title), s.SQLID) {
					t.Errorf("%s: statement title line %d is %q", fixtureName(fx), s.Title, rawLine(t, r, s.Title))
				}
				if s.From != s.Title+1 || s.To < s.From-1 || s.To > cs.To {
					t.Errorf("%s: statement lines %d-%d, title %d", fixtureName(fx), s.From, s.To, s.Title)
				}
				if first := strings.SplitN(s.Text, "\n", 2)[0]; first != rawLine(t, r, s.From) {
					t.Errorf("%s: statement text starts %q, line %d is %q", fixtureName(fx), first, s.From, rawLine(t, r, s.From))
				}
			}
			prev := 0
			for i, p := range cs.PLSQL {
				in("plsql row", p.At)
				if p.N != i+1 || p.At <= prev || !strings.HasPrefix(rawLine(t, r, p.At), p.Handle) {
					t.Errorf("%s: plsql row %+v at line %q", fixtureName(fx), p, rawLine(t, r, p.At))
				}
				prev = p.At
			}
			prev = 0
			for i, f := range cs.Frames {
				in("frame", f.Line)
				in("table row", f.TableLine)
				if f.N != i+1 {
					t.Errorf("%s: frame %d has n=%d", fixtureName(fx), i+1, f.N)
				}
				if f.Line <= prev {
					t.Errorf("%s: frame %d at line %d after %d", fixtureName(fx), f.N, f.Line, prev)
				}
				prev = f.Line
				if cs.FramesSource == "binary" && !strings.HasPrefix(rawLine(t, r, f.Line), "========== FRAME ["+strconv.Itoa(f.N)+"] ("+f.Text+" -> "+f.Callee+")") {
					t.Errorf("%s: frame %d line %d is %q", fixtureName(fx), f.N, f.Line, rawLine(t, r, f.Line))
				}
				if f.TableLine != 0 && !strings.HasPrefix(rawLine(t, r, f.TableLine), f.Text[:min(len(f.Text), 15)]) {
					t.Errorf("%s: frame %d table line %d is %q", fixtureName(fx), f.N, f.TableLine, rawLine(t, r, f.TableLine))
				}
			}
			if cs.Own > len(cs.Frames) {
				t.Errorf("%s: own %d of %d frames", fixtureName(fx), cs.Own, len(cs.Frames))
			}
			prev = 0
			for _, c := range cs.Cursors {
				in("cursor", c.From)
				in("cursor end", c.To)
				if c.From <= prev || c.To < c.From {
					t.Errorf("%s: cursor %s at %d-%d after %d", fixtureName(fx), c.SQLID, c.From, c.To, prev)
				}
				prev = c.To
				if !strings.Contains(rawLine(t, r, c.From), "Dump Cursor sql_id="+c.SQLID+" ") {
					t.Errorf("%s: cursor line %d is %q", fixtureName(fx), c.From, rawLine(t, r, c.From))
				}
				if c.Group != "open" && c.Group != "cached" {
					t.Errorf("%s: cursor group %q", fixtureName(fx), c.Group)
				}
				if len(c.Binds) > c.BindCount || (c.BindCount <= BindCap && len(c.Binds) != c.BindCount) {
					t.Errorf("%s: cursor %s: %d binds listed of %d", fixtureName(fx), c.SQLID, len(c.Binds), c.BindCount)
				}
				for j, b := range c.Binds {
					if b.Pos != j {
						t.Errorf("%s: cursor %s bind %d has pos %d", fixtureName(fx), c.SQLID, j, b.Pos)
					}
					if b.Line != 0 {
						in("bind value", b.Line)
						if !strings.HasPrefix(strings.TrimSpace(rawLine(t, r, b.Line)), "value="+b.Value[:min(len(b.Value), 20)]) && b.LineTo == 0 {
							t.Errorf("%s: bind value line %d is %q for %q", fixtureName(fx), b.Line, rawLine(t, r, b.Line), b.Value)
						}
					}
					if b.Dty != 0 && b.Type == "" {
						t.Errorf("%s: bind with dty %d and no type", fixtureName(fx), b.Dty)
					}
				}
			}
			if cs.CursorsTotal < len(cs.Cursors) {
				t.Errorf("%s: %d cursors listed of %d", fixtureName(fx), len(cs.Cursors), cs.CursorsTotal)
			}
			for _, l := range cs.Links {
				in("link", l.From)
				if l.To > cs.To {
					t.Errorf("%s: link %s past the dump", fixtureName(fx), l.Node)
				}
				if _, err := r.Reading(l.Node); err != nil {
					t.Errorf("%s: link %s has no reading: %v", fixtureName(fx), l.Node, err)
				}
			}
			// JSON: no null, the lists are lists
			b, err := json.Marshal(cs)
			if err != nil {
				t.Fatal(err)
			}
			if m := jsonNull.FindIndex(b); m != nil {
				t.Errorf("%s: null in the JSON: ...%s", fixtureName(fx), string(b)[max(0, m[0]-60):m[1]+10])
			}
		}
	}
	// the committed fixtures give four (the two errorstacks, the dump after the deadlock graph, the one inside
	// the 10046 trace); testdata/big/diag, where present, adds more
	if n < 4 {
		t.Errorf("only %d call stack readings seen", n)
	}
}

// TestFrameSources: where the table is the only source (a dump cut before its binary stack dump, a dump
// without one), the frames are the table's and join the names the table wraps; they equal the binary
// frames' functions and callees of the whole dump.
func TestFrameSources(t *testing.T) {
	for _, name := range []string{"diag_errorstack_l1.trc", "diag_errorstack_l2.trc", "diag_deadlock.trc"} {
		data, err := os.ReadFile(filepath.Join(diagDir, name))
		if err != nil {
			t.Fatal(err)
		}
		full := callStacks(t, readerOfBytes(t, data))
		var cs *CallStack
		for _, c := range full {
			cs = c
		}
		// the lines of the dump up to its Binary Stack Dump title: the table is complete, the dump has no frame headers
		lines := strings.SplitAfter(string(data), "\n")
		cut := 0
		for i, l := range lines {
			if strings.Contains(l, "Binary Stack Dump ----") && cut == 0 {
				cut = i
			}
		}
		if cut == 0 {
			t.Fatalf("%s: no Binary Stack Dump", name)
		}
		pre := callStacks(t, readerOfBytes(t, []byte(strings.Join(lines[:cut], ""))))
		if len(pre) != 1 {
			t.Fatalf("%s: %d readings of the prefix", name, len(pre))
		}
		p := pre[len(pre)-1]
		if p.FramesSource != "table" || p.BinaryFrames != 0 || p.TableAgrees != nil {
			t.Errorf("%s: prefix source %s, binary %d", name, p.FramesSource, p.BinaryFrames)
		}
		if len(p.Frames) != len(cs.Frames) {
			t.Fatalf("%s: %d frames from the table, %d from the headers", name, len(p.Frames), len(cs.Frames))
		}
		for i := range p.Frames {
			a, b := p.Frames[i], cs.Frames[i]
			if a.Text != b.Text || a.Function != b.Function || a.Callee != b.Callee || (a.Offset == nil) != (b.Offset == nil) || (a.Offset != nil && *a.Offset != *b.Offset) {
				t.Errorf("%s: frame %d from the table %+v, from the header %+v", name, i+1, a, b)
			}
		}
		if p.Own != cs.Own || p.ShortStack != cs.ShortStack || p.ShortStackNoOwn != cs.ShortStackNoOwn {
			t.Errorf("%s: own %d/%d, the short stacks differ", name, p.Own, cs.Own)
		}
		found := false
		for _, n := range p.Notes {
			found = found || strings.Contains(n, "read from the Call Stack Trace table")
		}
		if !found {
			t.Errorf("%s: the reading does not say the frames come from the table: %v", name, p.Notes)
		}
	}
	// the wrapped names of the table (diag_errorstack_l2:60-61, :63-64) are joined
	data, _ := os.ReadFile(filepath.Join(diagDir, "diag_errorstack_l2.trc"))
	lines := strings.SplitAfter(string(data), "\n")
	pre := callStacks(t, readerOfBytes(t, []byte(strings.Join(lines[:187], ""))))
	if len(pre) != 1 {
		t.Fatal("no reading of the prefix")
	}
	got := map[string]bool{}
	for _, f := range pre[0].Frames {
		got[f.Text] = true
		got[f.Callee] = true
	}
	for _, w := range []string{"dbkedDefDump()+24347", "dbkdaKsdActDriver()+2492", "dbgdaExecuteAction()+354", "dbgdaExecuteAction()", "__libc_start_call_main()+128", "__libc_start_call_main()"} {
		if !got[w] {
			t.Errorf("the wrapped name %q is not among the table's frames", w)
		}
	}
}

// TestOwnFrameRule: the rule keeps what the process was doing out of the dump's own frames on every stack of
// the fixtures, and the table in stackrules.go names a fixture for each case.
func TestOwnFrameRule(t *testing.T) {
	for fn, own := range map[string]bool{
		"ksedst1": true, "ksedst": true, "dbkedDefDump": true, "ksedmp": true, "dbkdaKsdActDriver": true, "dbgdaExecuteAction": true,
		"dbgdaRunAction": true, "dbgdRunActions": true, "dbgdParseCmd": true, "dbkdParseCmd": true, "dbgdProcessEventActions": true,
		"dbgdChkEventKgErr": true, "dbkdChkEventRdbmsErr": true, "dbgexPhaseII": true, "dbgexProcessError": true,
		"dbgePostErrorDirectVaList_int": true, "dbgePostErrorDirect": true,
		"kkyase": false, "qcsprfro": false, "ksqdld_hdr_dump": false, "pevm_peruws_callback": false, "opiexe": false, "main": false, "ksqcmi": false,
	} {
		if ownFrame(fn) != own {
			t.Errorf("ownFrame(%q) = %v", fn, !own)
		}
	}
	if ownShortStack([]string{"ksedsts", "ksdxfstk", "ksdxcb", "sspuser", "__sighandler", "semtimedop", "sskgpwwait"}) != 5 {
		t.Error("the signal handler path of a short stack is 5 entries")
	}
	if ownShortStack([]string{"semtimedop", "sskgpwwait"}) != 0 {
		t.Error("a short stack without the handler path has no own entries")
	}
}

// TestCursorBinds: the cursors of the errorstack, their binds, as printed.
func TestCursorBinds(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_errorstack_l2.trc"))
	cs := callStacks(t, r)[0]
	if cs.CursorsTotal != 15 || len(cs.Cursors) != 15 {
		t.Fatalf("%d cursors", cs.CursorsTotal)
	}
	open, cached := 0, 0
	for _, c := range cs.Cursors {
		if c.Group == "open" {
			open++
		} else {
			cached++
		}
	}
	if open != 5 || cached != 10 {
		t.Errorf("%d open, %d cached", open, cached)
	}
	var c *DumpCursor
	for i := range cs.Cursors {
		if cs.Cursors[i].SQLID == "f3j90cdzgg7d2" {
			c = &cs.Cursors[i]
		}
	}
	if c == nil || c.Number != 2 || c.State != "BOUND" || c.Text != "begin mtk_diag_outer(:ev, :cid); end;" || c.BindCount != 2 || len(c.Binds) != 2 {
		t.Fatalf("cursor %+v", c)
	}
	b0, b1 := c.Binds[0], c.Binds[1]
	if b0.Dty != 1 || b0.Type != "VARCHAR2" || b0.Value != `"alter session set events 'immediate trace name errorstack level 2'"` || b0.Line != 7762 || b0.Avl == nil || *b0.Avl != 66 {
		t.Errorf("bind 0 %+v", b0)
	}
	if b1.Dty != 2 || b1.Type != "NUMBER" || b1.Value != "11" || b1.Line != 7767 || b1.Avl == nil || *b1.Avl != 2 {
		t.Errorf("bind 1 %+v", b1)
	}
	// "No oacdef for this bind" is a bind with no type and no value
	u := cs.Cursors[0]
	if u.SQLID != "9zg9qd9bm4spu" || u.BindCount != 3 || !u.Binds[1].NoDef || u.Binds[1].Line != 0 || u.Binds[0].Type != "DATE" {
		t.Errorf("cursor %+v", u)
	}
	// PL/SQL stack
	if len(cs.PLSQL) != 3 || cs.PLSQL[0].Name != "MTK.MTK_DIAG_INNER" || cs.PLSQL[0].Type != "procedure" || cs.PLSQL[0].Line != 11 || cs.PLSQL[0].Handle != "0x7b3c9620" ||
		cs.PLSQL[2].Type != "anonymous block" || cs.PLSQL[2].Name != "" {
		t.Errorf("plsql %+v", cs.PLSQL)
	}
}

// TestCallStackBig: the incident file and the level 3 errorstack (not in git; skipped when absent).
func TestCallStackBig(t *testing.T) {
	p := filepath.Join(bigDir, "diag_oom_incident.trc")
	if _, err := os.Stat(p); err != nil {
		t.Skip("testdata/big/diag is not here")
	}
	r := readerOf(t, p)
	css := callStacks(t, r)
	if len(css) != 2 {
		t.Fatalf("%d readings in the incident file", len(css))
	}
	for _, cs := range css {
		if !cs.Start.Incident || cs.Start.Flags != "0x2" || cs.Start.Level != 3 {
			t.Errorf("start %+v", cs.Start)
		}
		e := cs.Error
		if e == nil || e.Incident == nil || e.Incident.ID != "199651" || e.Incident.Problem != "ORA 6544 [pevm_peruws_callback-1]" {
			t.Fatalf("error %+v", e)
		}
		// the file's error stack (line 36) is before the "Dump for incident" part: only the incident node sees it
		wantArgs, wantLine := "", 0
		if strings.HasPrefix(cs.Node, "incident:") {
			wantArgs, wantLine = "pevm_peruws_callback-1|27102", 36
		}
		if got := strings.Join(e.Incident.Args, "|"); got != wantArgs || e.Incident.Line != wantLine {
			t.Errorf("%s: args %q at line %d", cs.Node, got, e.Incident.Line)
		}
		var texts []string
		for _, l := range e.Lines {
			texts = append(texts, l.Text)
		}
		joined := strings.Join(texts, "\n")
		if !strings.Contains(joined, "ORA-27102: out of memory") || (wantLine != 0 && !strings.Contains(joined, "ORA-6544 [pevm_peruws_callback-1]")) {
			t.Errorf("error lines %q", joined)
		}
		if cs.Statement == nil || cs.Statement.SQLID != "gcdr7qpu1ctg0" || !strings.HasPrefix(cs.Statement.Text, "declare") || strings.Contains(cs.Statement.Text, "[TOC") {
			t.Errorf("statement %+v", cs.Statement)
		}
		if len(cs.Frames) != 45 || cs.FramesSource != "binary" || cs.Own != 8 || cs.Frames[cs.Own].Function != "pevm_peruws_callback" {
			t.Errorf("frames %d, source %s, own %d", len(cs.Frames), cs.FramesSource, cs.Own)
		}
		if len(cs.Links) != 1 || cs.Links[0].Kind != "procstate" {
			t.Errorf("links %+v", cs.Links)
		}
		if len(cs.PLSQL) != 1 || cs.PLSQL[0].Type != "anonymous block" {
			t.Errorf("plsql %+v", cs.PLSQL)
		}
	}
	// the digest prints the incident's reading once (the "Dump for incident" part reads the same lines)
	var dg bytes.Buffer
	if err := WriteDigest(&dg, r); err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(dg.String(), "error: incident 199651, problem key ORA 6544 [pevm_peruws_callback-1]"); n != 1 {
		t.Errorf("the incident's error is printed %d times in the digest", n)
	}
	// the level 3 errorstack: same unit, with the fixed areas folded
	r3 := readerOf(t, filepath.Join(bigDir, "diag_errorstack.trc"))
	c3 := callStacks(t, r3)[0]
	if c3.Start.Level != 3 || c3.Own != 10 || len(c3.Frames) != 44 || c3.TableAgrees == nil || !*c3.TableAgrees {
		t.Errorf("level 3: %+v", c3.Start)
	}
}

// TestCallStackPrefixes: a file cut anywhere reads without error and without a panic, and a reading's
// lists stay in order.
func TestCallStackPrefixes(t *testing.T) {
	for _, name := range []string{"diag_errorstack_l2.trc", "diag_deadlock.trc"} {
		data, err := os.ReadFile(filepath.Join(diagDir, name))
		if err != nil {
			t.Fatal(err)
		}
		step := max(1, len(data)/200)
		for cut := 0; cut <= len(data); cut += step {
			r := readerOfBytes(t, data[:cut])
			for _, n := range readingNodes(t, r) {
				rd, err := r.Reading(n.ID)
				if err != nil {
					t.Fatalf("%s[:%d] %s: %v", name, cut, n.ID, err)
				}
				if _, err := json.Marshal(rd); err != nil {
					t.Fatal(err)
				}
				if cs, ok := rd.(*CallStack); ok {
					prev := 0
					for _, f := range cs.Frames {
						if f.Line <= prev {
							t.Fatalf("%s[:%d]: frames out of order", name, cut)
						}
						prev = f.Line
					}
				}
			}
			var b bytes.Buffer
			if err := WriteDigest(&b, r); err != nil {
				t.Fatalf("%s[:%d]: digest: %v", name, cut, err)
			}
		}
	}
}

// TestCallStackMutations: the readings survive damaged lines (a dump is best effort).
func TestCallStackMutations(t *testing.T) {
	junk := []string{"dbkedDefDump(): Starting", "dbkedDefDump(): Starting a non-incident diagnostic dump (flags=, level=, mask=)", "----- Call Stack Trace -----", "----- Current SQL Statement for this session (sql_id=) -----",
		"----- PL/SQL Call Stack -----", "0x7b3c9620", "0x7b3c9620  x  procedure", "========== FRAME [", "========== FRAME [9] (", "========== FRAME [9] (a -> b) ==========", "CALL TYPE:", "-------------------- -------- -------------------- ------",
		"ksedst1()+95         call     kgdsdst()", "7", "about to signal ", "about to signal 99999999999999", "Name:", "<error barrier>", "ORA-", "ORA-00600: x", "----- Dump Cursor sql_id=", "----- Bind Info (kkscoacd) -----", " Bind#", " Bind#99999999999",
		"  value=\"unterminated", "  oacdty=", "  kxsbbbfp=1 avl=", "Cursor#", "Cursor#3(0x1) state=", "[TOC00001]", "[TOC00001-END]", "========= Dump for incident 5 (ORA 1 [x])", "*** 2026-01-01T00:00:00.000000+00:00", ""}
	rng := newRand(11)
	for _, name := range []string{"diag_errorstack_l2.trc", "diag_deadlock.trc", "diag_errorstack_l1.trc"} {
		data, err := os.ReadFile(filepath.Join(diagDir, name))
		if err != nil {
			t.Fatal(err)
		}
		src := strings.Split(string(data), "\n")
		for it := 0; it < 60; it++ {
			ls := append([]string(nil), src[:min(len(src), 8000)]...)
			for k := rng.Intn(40) + 1; k > 0; k-- {
				i := rng.Intn(len(ls))
				switch rng.Intn(5) {
				case 0:
					ls = append(ls[:i], ls[i+1:]...)
				case 1:
					j := rng.Intn(len(ls))
					ls[i], ls[j] = ls[j], ls[i]
				case 2, 3:
					ls[i] = junk[rng.Intn(len(junk))]
				case 4:
					ls = append(ls[:i], append([]string{junk[rng.Intn(len(junk))]}, ls[i:]...)...)
				}
			}
			r := readerOfBytes(t, []byte(strings.Join(ls, "\n")))
			for _, n := range readingNodes(t, r) {
				rd, err := r.Reading(n.ID)
				if err != nil {
					continue
				}
				if _, err := json.Marshal(rd); err != nil {
					t.Fatal(err)
				}
			}
			var b bytes.Buffer
			if err := WriteDigest(&b, r); err != nil {
				t.Fatalf("%s mutation %d: digest: %v", name, it, err)
			}
		}
	}
}

// TestCallStackSpeed: the reading of the largest dump, committed and big. Loose floors; the numbers are logged.
func TestCallStackSpeed(t *testing.T) {
	files := fixtures(t)
	files = append(files, bigFixtures()...)
	var worst time.Duration
	for _, fx := range files {
		r := readerOf(t, fx)
		for _, n := range readingNodes(t, r) {
			if n.Reading != ReadingCallStack || n.Lines < 20000 {
				continue
			}
			d := timeReading(t, r, n)
			t.Logf("%s: call stack of %d lines in %v", fixtureName(fx), n.Lines, d.Round(time.Millisecond))
			worst = max(worst, d)
			if d > 2*time.Second {
				t.Errorf("%s: the call stack reading of %d lines took %v", fixtureName(fx), n.Lines, d)
			}
		}
	}
	if worst == 0 {
		t.Error("no call stack reading timed")
	}
}

// TestStackJSONShape pins the names of the fields of the two readings (the clients read them).
func TestStackJSONShape(t *testing.T) {
	keys := func(rd Reading) string {
		b, err := json.Marshal(rd)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.HasPrefix(b, []byte(`{"kind":"`+rd.ReadingKind()+`","node":`)) {
			t.Errorf("the first fields are not kind and node: %.60s", b)
		}
		var m map[string]json.RawMessage
		json.Unmarshal(b, &m)
		var ks []string
		for k := range m {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		return strings.Join(ks, " ")
	}
	cs := callStacks(t, readerOf(t, filepath.Join(diagDir, "diag_errorstack_l2.trc")))[0]
	if got, want := keys(cs), "barriers binaryFrames cursors cursorsTotal frames framesLine framesSource from lines links node notes own plsql plsqlLine shortStack shortStackNoOwn start statement tableAgrees tableFrames to kind"; got != sortWords(want) {
		t.Errorf("call stack keys\n got %s\nwant %s", got, sortWords(want))
	}
	_, pss := procStates(t, readerOf(t, filepath.Join(diagDir, "diag_procstate.trc")))
	if got, want := keys(pss[0]), "dmlLocks dmlLocksTotal enqueues enqueuesTotal from kind lines locks locksTotal node notes objects pins pinsTotal process scope sessions sessionsTotal to transactions transactionsTotal"; got != sortWords(want) {
		t.Errorf("process state keys\n got %s\nwant %s", got, sortWords(want))
	}
	// a node of kind toc that is not the incident's dump has no reading
	if p := filepath.Join(bigDir, "diag_oom_incident.trc"); fileExists(p) {
		r := readerOf(t, p)
		var inc Node
		for _, n := range r.Scan.Top {
			if n.Kind == "incident" {
				inc = n
			}
		}
		for _, c := range allChildren(t, r, inc.ID, Cap) {
			_, err := r.Reading(c.ID)
			if (c.Reading == "") != (err != nil) {
				t.Errorf("toc %q: reading %q, error %v", c.Title, c.Reading, err)
			}
			if c.Reading == "" && err != ErrNoReading {
				t.Errorf("toc %q: %v", c.Title, err)
			}
		}
	}
}

func sortWords(s string) string {
	w := strings.Fields(s)
	sort.Strings(w)
	return strings.Join(w, " ")
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }
