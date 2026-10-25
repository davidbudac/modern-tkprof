package model

import (
	"os"
	"testing"
)

func TestOnProgressBigTrace(t *testing.T) {
	const path = "../../testdata/big/big_loop.trc"
	if _, err := os.Stat(path); err != nil {
		t.Skip("no big fixture: ", err)
	}
	type call struct{ b, l, s int64 }
	var calls []call
	m, err := Build(path, Options{Aggregate: true, OnProgress: func(b, l, s int64) { calls = append(calls, call{b, l, s}) }})
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) < 2 {
		t.Fatalf("%d progress calls, want ≥ 2", len(calls))
	}
	for i := 1; i < len(calls); i++ {
		p, c := calls[i-1], calls[i]
		if c.b < p.b || c.l < p.l || c.s < p.s {
			t.Fatalf("call %d not monotonic: %v after %v", i, c, p)
		}
	}
	last := calls[len(calls)-1]
	if last.b != m.Diag.Bytes || last.l != int64(m.Diag.Lines) || last.s != int64(len(m.Statements)) {
		t.Fatalf("final %v, model bytes=%d lines=%d statements=%d", last, m.Diag.Bytes, m.Diag.Lines, len(m.Statements))
	}
	t.Logf("%d calls, final %v", len(calls), last)
}

// A small input reports once, at the end, with the totals.
func TestOnProgressSmallTrace(t *testing.T) {
	var n int
	var last [3]int64
	m, err := Build("../../testdata/traces/19c/basic_binds.trc", Options{OnProgress: func(b, l, s int64) { n++; last = [3]int64{b, l, s} }})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || last != [3]int64{m.Diag.Bytes, int64(m.Diag.Lines), int64(len(m.Statements))} {
		t.Fatalf("calls %d, last %v", n, last)
	}
}
