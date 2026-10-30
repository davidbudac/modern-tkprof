package model

import (
	"bytes"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

func TestFileStatusStaysWithItsInput(t *testing.T) {
	b := NewBuilder("complete.trc", Options{})
	st, err := trace.Parse(strings.NewReader(sample), b)
	if err != nil {
		t.Fatal(err)
	}
	b.EndFile(st)
	b.NextFile("incomplete.trc", false)
	st, err = trace.Parse(strings.NewReader("*** TRACE CONTINUED FROM FILE earlier.trc ***\n*** DUMP FILE SIZE IS LIMITED TO 307200 BYTES ***\n"), b)
	if err != nil {
		t.Fatal(err)
	}
	b.EndFile(st)
	m := b.Finish(st)
	check := func(m *Model) {
		t.Helper()
		if m.File.Files[0].Truncated || len(m.File.Files[0].ContinuedFrom) != 0 {
			t.Fatal("status leaked onto the complete file")
		}
		f := m.File.Files[1]
		if !f.Truncated || len(f.ContinuedFrom) != 1 || f.ContinuedFrom[0] != "earlier.trc" {
			t.Fatalf("incomplete file lost its status: %+v", f)
		}
	}
	check(m)
	// Cached dimensions must retain the same file attribution.
	m.Calls, m.Waits, m.Binds, m.BindSets = nil, nil, nil, nil
	var buf bytes.Buffer
	if err := Encode(&buf, m); err != nil {
		t.Fatal(err)
	}
	restored, err := Decode(&buf)
	if err != nil {
		t.Fatal(err)
	}
	check(restored)
}
