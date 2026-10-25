package trace

import (
	"bytes"
	"errors"
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

// Reads across checkpoints, chunk boundaries and the unterminated tail must
// give the same bytes as splitting the file in memory.
func TestLineIndexSparse(t *testing.T) {
	for _, tail := range []string{"", "x"} {
		var sb strings.Builder
		var lines []string
		for i := 1; i <= 5*lineStride+17; i++ {
			l := strings.Repeat("ab", i%700) + "\n" // some lines longer than the read chunk
			if i%11 == 0 {
				l = "\n"
			}
			lines = append(lines, l)
			sb.WriteString(l)
		}
		if tail == "x" {
			lines = append(lines, tail)
			sb.WriteString(tail)
		}
		p := filepath.Join(t.TempDir(), "s.trc")
		os.WriteFile(p, []byte(sb.String()), 0o644)
		li, err := OpenLineIndex(p)
		if err != nil {
			t.Fatal(err)
		}
		if li.Lines() != len(lines) {
			t.Fatalf("tail %q: %d lines, want %d", tail, li.Lines(), len(lines))
		}
		for _, from := range []int{1, 2, lineStride - 1, lineStride, lineStride + 1, 2*lineStride + 5, len(lines) - 1, len(lines)} {
			for _, n := range []int{1, 3, lineStride, 100, 1000} {
				end := min(from-1+n, len(lines))
				want := strings.Join(lines[from-1:end], "")
				if got, _ := li.Read(from, n); string(got) != want {
					t.Fatalf("tail %q: Read(%d,%d) = %d bytes, want %d", tail, from, n, len(got), len(want))
				}
			}
		}
		li.Close()
	}
}

// A saved and loaded index reads the same lines as a fresh one.
func TestLineIndexSaveLoad(t *testing.T) {
	p := "../../testdata/traces/19c/io_waits.trc"
	fresh, err := OpenLineIndex(p)
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	var buf bytes.Buffer
	if err := fresh.Save(&buf); err != nil {
		t.Fatal(err)
	}
	saved := buf.Bytes()
	li, err := LoadLineIndex(p, bytes.NewReader(saved))
	if err != nil {
		t.Fatal(err)
	}
	defer li.Close()
	if li.Lines() != fresh.Lines() {
		t.Fatalf("Lines = %d, want %d", li.Lines(), fresh.Lines())
	}
	for _, r := range [][2]int{{1, 1}, {1, 2000}, {63, 3}, {64, 1}, {65, 130}, {fresh.Lines() - 5, 10}, {fresh.Lines() + 1, 3}} {
		a, _ := fresh.Read(r[0], r[1])
		b, _ := li.Read(r[0], r[1])
		if !bytes.Equal(a, b) {
			t.Errorf("Read(%d, %d) differs", r[0], r[1])
		}
	}
	bad := append([]byte(nil), saved...)
	bad[len(lineIndexMagic)+8]++ // stride
	if _, err := LoadLineIndex(p, bytes.NewReader(bad)); !errors.Is(err, ErrLineIndexFormat) {
		t.Errorf("other stride: %v", err)
	}
	if _, err := LoadLineIndex("../../testdata/traces/19c/errors.trc", bytes.NewReader(saved)); !errors.Is(err, ErrLineIndexFormat) {
		t.Errorf("other file: %v", err)
	}
	if _, err := LoadLineIndex(p, bytes.NewReader(saved[:len(saved)-3])); !errors.Is(err, ErrLineIndexFormat) {
		t.Errorf("truncated: %v", err)
	}
}
