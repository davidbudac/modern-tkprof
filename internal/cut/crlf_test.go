package cut_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/cut"
)

// crlfText rewrites the first statement text of at least minLines lines in an
// LF trace as Oracle writes it when the client sent the statement with CRLF
// line ends: every text line but the last ends in \r, and len= grows by the
// bytes added. It returns nil when the trace has no such statement.
func crlfText(src []byte, minLines int) []byte {
	lines := strings.Split(string(src), "\n")
	for i := 0; i < len(lines); i++ {
		h := lines[i]
		at := strings.Index(h, " len=")
		if !strings.HasPrefix(h, "PARSING IN CURSOR #") || at < 0 {
			continue
		}
		rest := h[at+5:]
		sp := strings.IndexByte(rest, ' ')
		if sp < 0 {
			continue
		}
		n, err := strconv.Atoi(rest[:sp])
		if err != nil {
			continue
		}
		end := i + 1
		for end < len(lines) && lines[end] != "END OF STMT" {
			end++
		}
		text := lines[i+1 : end]
		if end == len(lines) || len(text) < minLines || len(strings.Join(text, "\n")) != n || strings.Contains(strings.Join(text, ""), "\r") {
			continue
		}
		for j := i + 1; j < end-1; j++ {
			lines[j] += "\r"
		}
		lines[i] = h[:at+5] + strconv.Itoa(n+len(text)-1) + rest[sp:]
		return []byte(strings.Join(lines, "\n"))
	}
	return nil
}

// A statement sent with CRLF line ends in a trace with LF line ends: the \r
// are part of the statement text and count towards len=, so the cut must keep
// them as the parser does (it strips \r only in a file whose first line ends
// in \r\n).
func TestCutCRLFStatementText(t *testing.T) {
	var src []byte
	var from string
	for _, p := range fixtures(t) {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(b, []byte("\r")) {
			continue
		}
		if out := crlfText(b, 8); out != nil {
			src, from = out, p
			break
		}
	}
	if src == nil {
		t.Fatal("no fixture has a statement of 8 lines")
	}
	path := filepath.Join(t.TempDir(), "crlf_text.trc")
	if err := os.WriteFile(path, src, 0o644); err != nil {
		t.Fatal(err)
	}
	m, c := open(t, path)
	if m.Diag.UnknownLines != 0 {
		t.Fatalf("%s rewritten: %d unknown lines in the source", from, m.Diag.UnknownLines)
	}
	checkAll(t, "crlf_text", m, c)
	var buf bytes.Buffer
	if _, err := c.Write(context.Background(), cut.Selection{}, &buf); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, l := range strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n") {
		if !strings.HasPrefix(l, "mtkprof cut: ") {
			got = append(got, l)
		}
	}
	want := strings.Split(strings.TrimSuffix(string(src), "\n"), "\n")
	if len(got) != len(want) {
		t.Fatalf("%d lines, source %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("line %d:\n got  %q\n want %q", i+1, got[i], want[i])
		}
	}
}
