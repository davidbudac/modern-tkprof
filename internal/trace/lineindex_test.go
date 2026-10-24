package trace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLineIndex(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		lines      int
	}{
		{"terminated", "one\ntwo\nthree\n", 3},
		{"unterminated", "one\ntwo\nthree", 3},
		{"blank", "a\n\n\nb\n", 4},
		{"empty", "", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "x.trc")
			if err := os.WriteFile(p, []byte(tc.body), 0o644); err != nil {
				t.Fatal(err)
			}
			li, err := OpenLineIndex(p)
			if err != nil {
				t.Fatal(err)
			}
			defer li.Close()
			if li.Lines() != tc.lines {
				t.Fatalf("Lines = %d, want %d", li.Lines(), tc.lines)
			}
			all, _ := li.Read(1, 100)
			if string(all) != tc.body {
				t.Errorf("Read(1,100) = %q, want %q", all, tc.body)
			}
			if got, _ := li.Read(li.Lines()+1, 5); len(got) != 0 {
				t.Errorf("past end = %q", got)
			}
			if got, _ := li.Read(0, 1); tc.lines > 0 && string(got) != strings.SplitAfter(tc.body, "\n")[0] {
				t.Errorf("from 0 should clamp to line 1, got %q", got)
			}
		})
	}
	p := filepath.Join(t.TempDir(), "y.trc")
	os.WriteFile(p, []byte("one\ntwo\nthree"), 0o644)
	li, _ := OpenLineIndex(p)
	defer li.Close()
	if b, _ := li.Read(1, 1); string(b) != "one\n" {
		t.Errorf("first = %q", b)
	}
	if b, _ := li.Read(3, 1); string(b) != "three" {
		t.Errorf("last = %q", b)
	}
	if b, _ := li.Read(2, 10); string(b) != "two\nthree" {
		t.Errorf("tail = %q", b)
	}
}

// The index must agree with the parser's own line count on a real fixture.
func TestLineIndexMatchesParser(t *testing.T) {
	const p = "../../testdata/traces/19c/io_waits.trc"
	st, err := ParseFile(p, NopHandler{})
	if err != nil {
		t.Skip(err)
	}
	li, err := OpenLineIndex(p)
	if err != nil {
		t.Fatal(err)
	}
	defer li.Close()
	if li.Lines() != st.Lines {
		t.Errorf("index lines %d, parser lines %d", li.Lines(), st.Lines)
	}
}
