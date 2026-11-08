package model

import (
	"path/filepath"
	"reflect"
	"testing"
)

// waitRec records every wait an aggregate build hands its sink, with the call
// it was attached to.
type waitRec struct {
	waits map[ID]waitAt
}

type waitAt struct {
	W    Wait
	Call ID
}

func (r *waitRec) Call(*Call)             {}
func (r *waitRec) Child(*ChildRec, *Call) {}
func (r *waitRec) Adopt(ID, ID)           {}
func (r *waitRec) Finish()                {}
func (r *waitRec) Wait(w *Wait, c *Call) {
	call := None
	if c != nil {
		call = c.ID
	}
	r.waits[w.ID] = waitAt{*w, call}
}

// Compacting the pending waits of an aggregate build (compactWaits) changes
// nothing its sink gets: with a compaction at every wait, every fixture's
// waits arrive as they do without one.
func TestCompactWaitsKeepsWhatTheSinkGets(t *testing.T) {
	ms, _ := filepath.Glob("../../testdata/traces/*/*.trc")
	if len(ms) == 0 {
		t.Fatal("no fixtures")
	}
	build := func(path string, min int) map[ID]waitAt {
		t.Helper()
		defer func(m int) { minWaitCompact = m }(minWaitCompact)
		minWaitCompact = min
		r := &waitRec{waits: map[ID]waitAt{}}
		if _, err := Build(path, Options{Aggregate: true, NewSink: func(*Model) Sink { return r }}); err != nil {
			t.Fatal(err)
		}
		return r.waits
	}
	compactions := 0
	onCompact = func() { compactions++ }
	defer func() { onCompact = nil }()
	for _, p := range ms {
		want := build(p, 1<<62)
		got := build(p, 1)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %d waits with compaction, %d without, or they differ", p, len(got), len(want))
		}
	}
	if compactions == 0 {
		t.Fatal("no fixture compacted its pending waits: the test proves nothing")
	}
	t.Logf("%d fixtures, %d compactions", len(ms), compactions)
}
