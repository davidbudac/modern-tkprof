package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// TestCompareLinesMarkDumps: the line server of `compare` knows each side's optimizer (10053) dumps, as `serve` does, so the dump lines of an
// interleaved trace are optimizer lines and not unknown ones.
func TestCompareLinesMarkDumps(t *testing.T) {
	const plain = "../../testdata/traces/19c/basic_binds.trc"
	a, err := buildTrace("nothing to compare", []string{optInterleaved}, false)
	if err != nil {
		t.Fatal(err)
	}
	b, err := buildTrace("nothing to compare", []string{plain}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(a.File.Files) == 0 || len(a.File.Files[0].Dumps) == 0 {
		t.Fatalf("the interleaved fixture has no dumps in its model")
	}
	var lis [2]*trace.LineIndex
	for i, f := range []string{optInterleaved, plain} {
		if lis[i], err = trace.OpenLineIndex(f); err != nil {
			t.Fatal(err)
		}
		defer lis[i].Close()
	}
	h := compareLines(a, b, lis)
	kinds := func(side string, from, n int) map[string]int {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/lines?file=0&annot=1&side="+side+"&from="+strconv.Itoa(from)+"&n="+strconv.Itoa(n), nil))
		if rec.Code != 200 {
			t.Fatalf("side %s: %d %s", side, rec.Code, rec.Body.String())
		}
		var r struct {
			Lines []struct{ K string } `json:"lines"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &r); err != nil {
			t.Fatal(err)
		}
		m := map[string]int{}
		for _, l := range r.Lines {
			m[l.K]++
		}
		return m
	}
	d := a.File.Files[0].Dumps[0]
	in := kinds("a", d.First+10, 50)
	if in["optimizer"] == 0 || in["unknown"] != 0 {
		t.Errorf("lines %d-%d of the interleaved side: %v (want optimizer lines, no unknown ones)", d.First+10, d.First+59, in)
	}
	if out := kinds("b", 1, 200); out["optimizer"] != 0 {
		t.Errorf("the plain side has optimizer lines: %v", out)
	}
}
