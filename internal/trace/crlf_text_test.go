package trace

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// windowsTrace rewrites an LF trace with CRLF line ends. With countCR it also
// raises each len= of a PARSING IN CURSOR by the line breaks of the statement,
// as Oracle writes it on Windows for a statement sent with CRLF line ends
// (12.2 and 19c count every one; 11.2 traces count only some).
func windowsTrace(src []byte, texts []string, countCR bool) []byte {
	lines := strings.Split(string(src), "\n")
	n := 0
	for i, l := range lines {
		at := strings.Index(l, " len=")
		if countCR && strings.HasPrefix(l, "PARSING IN CURSOR #") && at > 0 && isHeaderOf(l, lines, i, texts, n) {
			end := at + 5 + strings.IndexByte(l[at+5:], ' ')
			v, _ := strconv.Atoi(l[at+5 : end])
			lines[i] = l[:at+5] + strconv.Itoa(v+strings.Count(texts[n], "\n")) + l[end:]
			n++
		}
	}
	return []byte(strings.Join(lines, "\r\n"))
}

// isHeaderOf: line i opens the n-th statement the parser read (a statement
// text can hold lines that look like a header).
func isHeaderOf(l string, lines []string, i int, texts []string, n int) bool {
	if n >= len(texts) {
		return false
	}
	want := strings.Split(texts[n], "\n")
	end := i + 1 + len(want)
	return end < len(lines) && lines[end] == "END OF STMT" && slices.Equal(lines[i+1:end], want)
}

// A Windows trace reads as the same trace with LF line ends: every statement
// text ends at its END OF STMT, whether len= counts the \r of its line breaks
// or not.
func TestCRLFStatementText(t *testing.T) {
	paths, err := filepath.Glob("../../testdata/traces/*/*.trc")
	if err != nil || len(paths) == 0 {
		t.Fatal("no fixtures", err)
	}
	long := 0 // statements whose len= grows by more than the parser's slack
	for _, path := range paths {
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(src, []byte("\r")) {
			continue
		}
		var want recorder
		wantStats, err := Parse(bytes.NewReader(src), &want)
		if err != nil {
			t.Fatal(err)
		}
		var texts []string
		for _, c := range want.cursors {
			texts = append(texts, c.Text)
			if strings.Count(c.Text, "\n") > lenSlack {
				long++
			}
		}
		for _, countCR := range []bool{true, false} {
			name := filepath.Base(filepath.Dir(path)) + "/" + filepath.Base(path) + " countCR=" + strconv.FormatBool(countCR)
			var got recorder
			st, err := Parse(bytes.NewReader(windowsTrace(src, texts, countCR)), &got)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.cursors) != len(want.cursors) || len(got.calls) != len(want.calls) || len(got.waits) != len(want.waits) || st.Unknown != wantStats.Unknown {
				t.Errorf("%s: %d statements, %d calls, %d waits, %d unknown lines; with LF %d, %d, %d, %d", name,
					len(got.cursors), len(got.calls), len(got.waits), st.Unknown, len(want.cursors), len(want.calls), len(want.waits), wantStats.Unknown)
				continue
			}
			for i, c := range got.cursors {
				if c.Text != want.cursors[i].Text {
					t.Errorf("%s line %d: text %q, with LF %q", name, c.Line, c.Text, want.cursors[i].Text)
					break
				}
			}
		}
	}
	if long == 0 {
		t.Fatal("no fixture has a statement long enough to matter")
	}
}
