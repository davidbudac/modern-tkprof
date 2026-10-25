package trace

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// parserKinds parses path and returns the kind the parser counted for each
// line (index = 1-based line; KindCount-ish sentinel -1 for lines it counted
// nothing for) and the raw lines as the parser saw them.
func parserKinds(t *testing.T, path string) (kinds []int, lines [][]byte, st Stats) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	p := New(NopHandler{})
	kinds = []int{-1}
	p.kindHook = func(line int, k Kind) {
		for len(kinds) <= line {
			kinds = append(kinds, -1)
		}
		kinds[line] = int(k)
	}
	st, err = p.Run(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	lines = [][]byte{nil}
	crlf := false
	for i, l := range bytes.SplitAfter(b, []byte("\n")) {
		if len(l) == 0 {
			continue
		}
		l = bytes.TrimSuffix(l, []byte("\n"))
		if i == 0 {
			crlf = bytes.HasSuffix(l, []byte("\r"))
		}
		if crlf {
			l = trimCR(l)
		}
		lines = append(lines, l)
	}
	for len(kinds) < len(lines) {
		kinds = append(kinds, -1)
	}
	return kinds, lines, st
}

// TestClassifyMatchesParser feeds Classify the same lines in order and
// compares it with what the parser counted for every line of every fixture.
// The parser's own SQL-text state seeds Classify (so one literal "END OF STMT"
// inside a statement does not cascade); apart from that the two must agree on
// every line except the documented ones: bind value continuation lines
// (Classify: unknown), blank lines inside BINDS blocks (the parser counts
// nothing), PARSE ERROR statement text, a literal END OF STMT inside SQL text
// (the parser checks len=), and the prologue (Classify: unknown).
func TestClassifyMatchesParser(t *testing.T) {
	files, _ := filepath.Glob("../../testdata/traces/*/*.trc")
	if len(files) == 0 {
		t.Skip("no fixtures")
	}
	for _, f := range files {
		kinds, lines, st := parserKinds(t, f)
		var got [kindCount]int
		inSQL := false
		inHeader := true
		diffs := map[string]int{}
		for i := 1; i < len(lines); i++ {
			var k Kind
			k, _ = Classify(lines[i], inSQL)
			pk := kinds[i]
			// the parser's state decides whether the next line is SQL text
			// (not Classify's: a literal END OF STMT inside a statement
			// would cascade); PARSE ERROR text is counted as sql-text too
			// but Classify never enters SQL text for it
			inSQL = pk == int(KindParsingInCursor) || (pk == int(KindSQLText) && inSQL)
			if pk == int(KindMarker) || pk == int(KindSeparator) {
				inHeader = false
			}
			if inHeader && pk == int(KindHeader) {
				if k != KindUnknown {
					t.Errorf("%s:%d header line classified %s", f, i, k)
				}
				continue
			}
			got[k]++
			if pk == int(k) {
				continue
			}
			name := "parser=none"
			if pk >= 0 {
				name = "parser=" + Kind(pk).String()
			}
			diffs[name+" classify="+k.String()]++
			switch {
			case pk == -1 && k == KindBlank, // blank inside a BINDS block
				pk == int(KindBindLine) && k == KindUnknown, // value continuation
				pk == int(KindSQLText) && k != KindSQLText:  // PARSE ERROR text, or a literal END OF STMT inside SQL text
			default:
				t.Errorf("%s:%d %q: parser %v, Classify %s", f, i, lines[i], pk, k)
			}
		}
		// record kinds other than the ones that carry the exceptions must
		// have identical totals
		for _, k := range []Kind{KindMarker, KindSeparator, KindParsingInCursor, KindCall, KindWait, KindStat, KindBinds, KindXctend, KindError, KindParseError, KindLob, KindRPC} {
			if got[k] != st.Kinds[k] {
				t.Errorf("%s: %s: Classify %d, parser %d", f, k, got[k], st.Kinds[k])
			}
		}
		if testing.Verbose() && len(diffs) > 0 {
			t.Logf("%s: %v", strings.TrimPrefix(f, "../../testdata/traces/"), diffs)
		}
	}
}

func TestClassifyLines(t *testing.T) {
	for _, c := range []struct {
		in    string
		inSQL bool
		k     Kind
		next  bool
	}{
		{"", false, KindBlank, false},
		{"   ", false, KindBlank, false},
		{"*** 2024-01-01 10:00:00.000", false, KindMarker, false},
		{"=====================", false, KindSeparator, false},
		{"PARSING IN CURSOR #1 len=10 dep=0", false, KindParsingInCursor, true},
		{"PARSING IN CURSOR #x", false, KindUnknown, false},
		{"select 1", true, KindSQLText, true},
		{"WAIT #1: nam='x' ela= 3", true, KindSQLText, true},
		{"END OF STMT", true, KindEndOfStmt, false},
		{"END OF STMT", false, KindUnknown, false},
		{"EXEC #1:c=0,e=0", false, KindCall, false},
		{"EXEC #:c=0", false, KindUnknown, false},
		{"WAIT #1: nam='x' ela= 3 p1=1", false, KindWait, false},
		{"WAIT #1: foo", false, KindUnknown, false},
		{"STAT #1 id=1 cnt=1 op='X'", false, KindStat, false},
		{"STAT #1 id=1", false, KindUnknown, false},
		{"BINDS #1:", false, KindBinds, false},
		{" Bind#0", false, KindBindLine, false},
		{"  value=5", false, KindBindLine, false},
		{"XCTEND rlbk=0, rd_only=1", false, KindXctend, false},
		{"LOBREAD: type=1", false, KindLob, false},
		{"RPC CALL: x", false, KindRPC, false},
		{"UNMAP #1:c=0", false, KindCall, false},
		{"SORT UNMAP #1:c=0", false, KindCall, false},
		{"ERROR #1:err=1", false, KindError, false},
		{"PARSE ERROR #1:len=3", false, KindParseError, false},
		{"hello", false, KindUnknown, false},
	} {
		k, next := Classify([]byte(c.in), c.inSQL)
		if k != c.k || next != c.next {
			t.Errorf("Classify(%q, %v) = %s,%v; want %s,%v", c.in, c.inSQL, k, next, c.k, c.next)
		}
	}
}
