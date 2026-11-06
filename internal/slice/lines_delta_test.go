package slice

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"testing"
)

type deltaAnswer struct {
	Lines     [][2]int64 `json:"lines"`
	Truncated bool       `json:"truncated"`
}

// bruteDelta is lines/delta computed from the model: every timed line of the
// file (calls, waits, cursor parses, XCTENDs) sorted by line, one per line.
func bruteDelta(e *lineEnv, file int, minUs int64, limit int) ([][2]int64, bool) {
	m := e.full
	in := func(ctx int32) bool { return ctx >= 0 && int(ctx) < len(m.Contexts) && m.Contexts[ctx].FileIdx == file }
	type lt struct {
		line int
		tim  int64
	}
	var all []lt
	for i := range m.Calls {
		if c := &m.Calls[i]; in(int32(c.Context)) {
			all = append(all, lt{int(c.Line), c.Tim})
		}
	}
	for i := range m.Waits {
		if w := &m.Waits[i]; in(int32(w.Context)) {
			all = append(all, lt{int(w.Line), w.Tim})
		}
	}
	for i := range m.Cursors {
		if c := &m.Cursors[i]; in(int32(c.Context)) && !c.Implicit {
			all = append(all, lt{c.Line, c.Tim})
		}
	}
	for i := range m.Transactions {
		if x := &m.Transactions[i]; in(int32(x.Context)) {
			all = append(all, lt{x.Line, x.Tim})
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].line < all[j].line })
	var got [][2]int64
	last, prev := -1, int64(0)
	for _, r := range all {
		if r.line == last || r.tim == 0 {
			continue
		}
		last = r.line
		if prev != 0 && r.tim-prev >= minUs {
			got = append(got, [2]int64{int64(r.line), r.tim - prev})
		}
		prev = r.tim
	}
	truncated := false
	if len(got) > limit {
		sort.SliceStable(got, func(i, j int) bool { return got[i][1] > got[j][1] })
		got, truncated = got[:limit], true
		sort.Slice(got, func(i, j int) bool { return got[i][0] < got[j][0] })
	}
	return append([][2]int64{}, got...), truncated
}

func TestLinesDelta(t *testing.T) {
	for name, paths := range fixtureSets(t) {
		t.Run(name, func(t *testing.T) {
			e := newLineEnv(t, paths)
			for file := range e.lis {
				for _, minUs := range []int64{0, 1, 500, 1000, 100000, 1 << 40} {
					for _, limit := range []int{1, 3, 50, 20000} {
						code, body := e.both(t, fmt.Sprintf("/api/lines/delta?file=%d&min=%d&limit=%d", file, minUs, limit))
						if code != 200 {
							t.Fatalf("file %d min %d limit %d: %d %s", file, minUs, limit, code, body)
						}
						var got deltaAnswer
						if err := json.Unmarshal(body, &got); err != nil {
							t.Fatal(err)
						}
						if got.Lines == nil {
							t.Fatalf("file %d: lines is null, want []", file)
						}
						want, trunc := bruteDelta(e, file, minUs, limit)
						if !reflect.DeepEqual(got.Lines, want) || got.Truncated != trunc {
							t.Fatalf("file %d min %d limit %d:\n got  %v %v\n want %v %v", file, minUs, limit, got.Lines, got.Truncated, want, trunc)
						}
					}
				}
				code, body := e.both(t, fmt.Sprintf("/api/lines/delta?file=%d", file))
				var got deltaAnswer
				if code != 200 || json.Unmarshal(body, &got) != nil {
					t.Fatalf("defaults: %d %s", code, body)
				}
				if want, trunc := bruteDelta(e, file, 1000, 20000); !reflect.DeepEqual(got.Lines, want) || got.Truncated != trunc {
					t.Fatalf("file %d defaults: got %v", file, got)
				}
			}
			for _, u := range []string{"/api/lines/delta?min=-1", "/api/lines/delta?min=x", "/api/lines/delta?limit=0", "/api/lines/delta?limit=100001"} {
				if code, b := e.both(t, u); code != 400 {
					t.Fatalf("%s: %d %s, want 400", u, code, b)
				}
			}
			if code, b := e.both(t, fmt.Sprintf("/api/lines/delta?file=%d", len(e.lis))); code != 404 {
				t.Fatalf("bad file: %d %s, want 404", code, b)
			}
		})
	}
}
