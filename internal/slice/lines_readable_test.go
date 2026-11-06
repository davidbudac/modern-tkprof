package slice

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"sort"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// rdRow is a call or wait row of a file as the brute-force checks see it.
type rdRow struct {
	line         int
	wait, idle   bool
	fetch        bool
	cursor       model.ID
	event        model.ID
	us           int64 // a call's e, a wait's ela
	tim          int64
	rows, cr, pp int64
}

// rdRows are the call and wait rows of one file, straight from the model, in
// line order.
func rdRows(m *model.Model, file int) []rdRow {
	in := func(ctx model.ID) bool {
		return ctx >= 0 && int(ctx) < len(m.Contexts) && m.Contexts[ctx].FileIdx == file
	}
	var rows []rdRow
	for i := range m.Calls {
		c := &m.Calls[i]
		if in(c.Context) {
			rows = append(rows, rdRow{line: int(c.Line), fetch: c.Kind == trace.CallFetch, cursor: c.Cursor, us: c.E, tim: c.Tim, rows: c.R, cr: c.CR, pp: c.P})
		}
	}
	for i := range m.Waits {
		w := &m.Waits[i]
		if in(w.Context) {
			rows = append(rows, rdRow{line: int(w.Line), wait: true, idle: w.Idle, cursor: w.Cursor, event: w.Event, us: w.Ela, tim: w.Tim})
		}
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].line < rows[j].line })
	return rows
}

// bruteHot is the answer of lines/hot computed by sorting every row.
func bruteHot(rows []rdRow, minUs int64, limit int) (hot []hotRow, mx int64, truncated bool) {
	var all []hotRow
	for _, r := range rows {
		mx = max(mx, r.us)
		if r.us >= minUs {
			all = append(all, hotRow{Line: r.line, Us: r.us, Wait: r.wait})
		}
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].Us != all[j].Us {
			return all[i].Us > all[j].Us
		}
		return all[i].Line < all[j].Line
	})
	if len(all) > limit {
		all, truncated = all[:limit], true
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Line < all[j].Line })
	return append([]hotRow{}, all...), mx, truncated
}

// bruteRepeats applies the fold rules to the materialised rows: wait blocks and
// their runs first, then the fetch loops, then the wait folds inside a loop go.
func bruteRepeats(m *model.Model, rows []rdRow, small int64) []repeatFold {
	if small == 0 && len(rows) > 0 {
		// the first and the last row of each table (calls, waits), the earliest and the latest in line order, an end with tim=0 left out
		l0, l1, t0, t1 := math.MaxInt, -1, int64(0), int64(0)
		for _, wait := range []bool{false, true} {
			first, last := -1, -1
			for i, r := range rows {
				if r.wait == wait {
					if first < 0 {
						first = i
					}
					last = i
				}
			}
			if first < 0 {
				continue
			}
			if r := rows[first]; r.line < l0 && r.tim != 0 {
				l0, t0 = r.line, r.tim
			}
			if r := rows[last]; r.line > l1 && r.tim != 0 {
				l1, t1 = r.line, r.tim
			}
		}
		small = max(1, (t1-t0)/100)
	}
	name := func(ev model.ID) string {
		if ev >= 0 && int(ev) < len(m.Events) {
			return m.Events[ev].Name
		}
		return ""
	}
	var waitFolds, fetchFolds []repeatFold

	for i := 0; i < len(rows); {
		if !rows[i].wait || rows[i].idle {
			i++
			continue
		}
		j := i + 1
		for j < len(rows) && rows[j].wait && !rows[j].idle && rows[j].cursor == rows[i].cursor {
			j++
		}
		blk := rows[i:j]
		i = j
		// runs of one event
		type span struct{ a, b int }
		var runs []span
		for a := 0; a < len(blk); {
			b := a + 1
			for b < len(blk) && blk[b].event == blk[a].event {
				b++
			}
			runs = append(runs, span{a, b})
			a = b
		}
		items := 0
		for _, r := range runs {
			if r.b-r.a >= 3 {
				items++
			} else {
				items += r.b - r.a
			}
		}
		if items > 10 {
			f := repeatFold{From: blk[0].line, To: blk[len(blk)-1].line, Kind: "block", N: len(blk)}
			per := map[model.ID]*repeatBy{}
			for _, w := range blk {
				f.Us += w.us
				f.Max = max(f.Max, w.us)
				if per[w.event] == nil {
					per[w.event] = &repeatBy{Event: name(w.event)}
				}
				per[w.event].N++
				per[w.event].Us += w.us
			}
			for _, b := range per {
				f.By = append(f.By, *b)
			}
			sort.Slice(f.By, func(i, j int) bool {
				if f.By[i].Us != f.By[j].Us {
					return f.By[i].Us > f.By[j].Us
				}
				return f.By[i].Event < f.By[j].Event
			})
			waitFolds = append(waitFolds, f)
			continue
		}
		for _, r := range runs {
			if r.b-r.a < 3 {
				continue
			}
			ev := name(blk[r.a].event)
			f := repeatFold{From: blk[r.a].line, To: blk[r.b-1].line, Kind: "run", N: r.b - r.a, Event: &ev}
			for _, w := range blk[r.a:r.b] {
				f.Us += w.us
				f.Max = max(f.Max, w.us)
			}
			waitFolds = append(waitFolds, f)
		}
	}

	cheap := func(r rdRow) bool { return !r.wait && r.fetch && r.us < small }
	for i := 0; i < len(rows); i++ {
		if !cheap(rows[i]) {
			continue
		}
		last := i
		for {
			k, ok := last+1, true
			for ; k < len(rows) && rows[k].wait; k++ {
				if rows[k].cursor != rows[i].cursor || rows[k].us >= small {
					ok = false
				}
			}
			if !ok || k >= len(rows) || !cheap(rows[k]) || rows[k].cursor != rows[i].cursor {
				break
			}
			last = k
		}
		f := repeatFold{From: rows[i].line, To: rows[last].line, Kind: "fetches"}
		var nrows, ncr, np, nidle int64
		for _, r := range rows[i : last+1] {
			switch {
			case !r.wait:
				f.N++
				f.Us += r.us
				f.Max = max(f.Max, r.us)
				nrows, ncr, np = nrows+r.rows, ncr+r.cr, np+r.pp
			case r.idle:
				nidle += r.us
			}
		}
		f.Rows, f.CR, f.P, f.Idle = &nrows, &ncr, &np, &nidle
		if f.N >= 6 {
			fetchFolds = append(fetchFolds, f)
		}
		i = last
	}

	out := append([]repeatFold{}, fetchFolds...)
	for _, w := range waitFolds {
		inside := false
		for _, f := range fetchFolds {
			if w.From >= f.From && w.To <= f.To {
				inside = true
			}
		}
		if !inside {
			out = append(out, w)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].From < out[j].From })
	return out
}

type repeatsAnswer struct {
	Folds     []repeatFold `json:"folds"`
	Truncated bool         `json:"truncated"`
}

type hotAnswer struct {
	Hot       []hotRow `json:"hot"`
	Max       int64    `json:"max"`
	Truncated bool     `json:"truncated"`
}

// checkFolds are the invariants of any answer, whatever the rows: sorted,
// disjoint, and the shape of each kind.
func checkFolds(t *testing.T, what string, folds []repeatFold) {
	t.Helper()
	for i, f := range folds {
		if f.From > f.To || (i > 0 && f.From <= folds[i-1].To) {
			t.Fatalf("%s: fold %d %+v not after %+v", what, i, f, folds[max(i-1, 0)])
		}
		if f.Max > f.Us || f.N < 1 {
			t.Fatalf("%s: fold %d %+v: n/us/max", what, i, f)
		}
		switch f.Kind {
		case "run":
			if f.N < 3 || f.Event == nil || f.By != nil || f.Rows != nil || f.Idle != nil {
				t.Fatalf("%s: run %+v", what, f)
			}
		case "block":
			var n int
			var us int64
			for j, b := range f.By {
				n, us = n+b.N, us+b.Us
				if j > 0 && f.By[j-1].Us < b.Us {
					t.Fatalf("%s: block %+v: by not sorted", what, f)
				}
			}
			if f.N < 11 || n != f.N || us != f.Us || f.Event != nil || f.Rows != nil {
				t.Fatalf("%s: block %+v", what, f)
			}
		case "fetches":
			if f.N < 6 || f.Rows == nil || f.CR == nil || f.P == nil || f.Idle == nil || f.Event != nil || f.By != nil {
				t.Fatalf("%s: fetches %+v", what, f)
			}
		default:
			t.Fatalf("%s: kind %q", what, f.Kind)
		}
	}
}

func TestLinesHot(t *testing.T) {
	for name, paths := range fixtureSets(t) {
		t.Run(name, func(t *testing.T) {
			e := newLineEnv(t, paths)
			for file := range e.lis {
				rows := rdRows(e.full, file)
				for _, minUs := range []int64{0, 1, 500, 1000, 100000, 1 << 40} {
					for _, limit := range []int{1, 3, 50, 2000, 20000} {
						code, body := e.both(t, fmt.Sprintf("/api/lines/hot?file=%d&min=%d&limit=%d", file, minUs, limit))
						if code != 200 {
							t.Fatalf("file %d min %d limit %d: %d %s", file, minUs, limit, code, body)
						}
						var got hotAnswer
						if err := json.Unmarshal(body, &got); err != nil {
							t.Fatal(err)
						}
						hot, mx, trunc := bruteHot(rows, minUs, limit)
						if !reflect.DeepEqual(got.Hot, hot) || got.Max != mx || got.Truncated != trunc {
							t.Fatalf("file %d min %d limit %d:\n got  %+v\n want %+v max %d truncated %v", file, minUs, limit, got, hot, mx, trunc)
						}
						if got.Hot == nil {
							t.Fatalf("file %d: hot is null, want []", file)
						}
					}
				}
				// the defaults: min 1000, limit 2000
				code, body := e.both(t, fmt.Sprintf("/api/lines/hot?file=%d", file))
				var got hotAnswer
				if code != 200 || json.Unmarshal(body, &got) != nil {
					t.Fatalf("defaults: %d %s", code, body)
				}
				if hot, mx, trunc := bruteHot(rows, 1000, 2000); !reflect.DeepEqual(got.Hot, hot) || got.Max != mx || got.Truncated != trunc {
					t.Fatalf("file %d defaults: got %+v", file, got)
				}
			}
			for _, u := range []string{
				"/api/lines/hot?min=-1", "/api/lines/hot?min=x", "/api/lines/hot?limit=0",
				"/api/lines/hot?limit=20001", "/api/lines/hot?limit=x",
			} {
				if code, b := e.both(t, u); code != 400 {
					t.Fatalf("%s: %d %s, want 400", u, code, b)
				}
			}
			if code, b := e.both(t, fmt.Sprintf("/api/lines/hot?file=%d", len(e.lis))); code != 404 {
				t.Fatalf("bad file: %d %s, want 404", code, b)
			}
		})
	}
}

func TestLinesRepeats(t *testing.T) {
	for name, paths := range fixtureSets(t) {
		t.Run(name, func(t *testing.T) {
			e := newLineEnv(t, paths)
			for file := range e.lis {
				rows := rdRows(e.full, file)
				// plus the elapsed times of some rows: "cheaper than small" is strict
				smalls := append([]int64{0, 1, 50, 1000, 20000, 1000000, 1 << 40}, edgeValues(rows, 8)...)
				for _, small := range smalls {
					code, body := e.both(t, fmt.Sprintf("/api/lines/repeats?file=%d&small=%d", file, small))
					if code != 200 {
						t.Fatalf("file %d small %d: %d %s", file, small, code, body)
					}
					var got repeatsAnswer
					if err := json.Unmarshal(body, &got); err != nil {
						t.Fatal(err)
					}
					want := bruteRepeats(e.full, rows, small)
					if got.Folds == nil || got.Truncated {
						t.Fatalf("file %d small %d: folds %v truncated %v", file, small, got.Folds, got.Truncated)
					}
					if !reflect.DeepEqual(got.Folds, want) {
						t.Fatalf("file %d small %d: folds differ from the model\n got  %s\n want %s", file, small, show(got.Folds), show(want))
					}
					checkFolds(t, fmt.Sprintf("file %d small %d", file, small), got.Folds)
				}
				// no small: the default is the same as asking for 1% of the span
				code, body := e.both(t, fmt.Sprintf("/api/lines/repeats?file=%d", file))
				var got repeatsAnswer
				if code != 200 || json.Unmarshal(body, &got) != nil || !reflect.DeepEqual(got.Folds, bruteRepeats(e.full, rows, 0)) {
					t.Fatalf("file %d defaults: %d %s", file, code, body)
				}
			}
			for _, u := range []string{"/api/lines/repeats?small=-1", "/api/lines/repeats?small=x"} {
				if code, b := e.both(t, u); code != 400 {
					t.Fatalf("%s: %d %s, want 400", u, code, b)
				}
			}
			if code, b := e.both(t, fmt.Sprintf("/api/lines/repeats?file=%d", len(e.lis))); code != 404 {
				t.Fatalf("bad file: %d %s, want 404", code, b)
			}
		})
	}
}

// edgeValues are up to n distinct elapsed times of the rows (positive), spread
// over the sorted values.
func edgeValues(rows []rdRow, n int) []int64 {
	seen := map[int64]bool{}
	var vals []int64
	for _, r := range rows {
		if r.us > 0 && !seen[r.us] {
			seen[r.us] = true
			vals = append(vals, r.us)
		}
	}
	sort.Slice(vals, func(i, j int) bool { return vals[i] < vals[j] })
	return sample(vals, n)
}

func show(folds []repeatFold) string {
	b, _ := json.Marshal(folds)
	return string(b)
}

// TestLinesRepeatsTruncated cuts the answer at a few folds: the first ones of
// the full answer come back and truncated is set exactly when more existed.
func TestLinesRepeatsTruncated(t *testing.T) {
	e := newLineEnv(t, []string{traces + "io_waits.trc"})
	srv := New(e.full).WithLines(e.lis)
	f := &srv.files()[0]
	all, trunc, err := srv.repeatsOf(context.Background(), f, 1<<40, maxFolds)
	if err != nil || trunc {
		t.Fatalf("all: %v %v", err, trunc)
	}
	if len(all) < 3 {
		t.Fatalf("io_waits.trc: %d folds, too few to cut", len(all))
	}
	for _, limit := range []int{1, 2, len(all) - 1, len(all), len(all) + 1} {
		got, trunc, err := srv.repeatsOf(context.Background(), f, 1<<40, limit)
		if err != nil {
			t.Fatal(err)
		}
		want := all[:min(limit, len(all))]
		if !reflect.DeepEqual(got, want) || trunc != (limit < len(all)) {
			t.Fatalf("limit %d: %d folds truncated %v, want %d folds truncated %v", limit, len(got), trunc, len(want), limit < len(all))
		}
	}
}

// TestLinesReadableContent makes sure the fixtures have something of each kind
// to fold or to rank, so the comparisons above are not vacuous.
func TestLinesReadableContent(t *testing.T) {
	kinds := map[string]int{}
	var hotN, hotWaits int
	for name, paths := range fixtureSets(t) {
		e := newLineEnv(t, paths)
		for file := range e.lis {
			for _, small := range []int64{0, 1000, 1 << 40} {
				_, body := e.both(t, fmt.Sprintf("/api/lines/repeats?file=%d&small=%d", file, small))
				var got repeatsAnswer
				if err := json.Unmarshal(body, &got); err != nil {
					t.Fatalf("%s: %v", name, err)
				}
				for _, f := range got.Folds {
					kinds[f.Kind]++
				}
			}
			_, body := e.both(t, fmt.Sprintf("/api/lines/hot?file=%d&min=0", file))
			var got hotAnswer
			if err := json.Unmarshal(body, &got); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			for _, h := range got.Hot {
				hotN++
				if h.Wait {
					hotWaits++
				}
			}
		}
	}
	for _, k := range []string{"run", "block", "fetches"} {
		if kinds[k] == 0 {
			t.Errorf("no %q fold in any fixture (%v)", k, kinds)
		}
	}
	if hotN == 0 || hotWaits == 0 {
		t.Errorf("hot rows %d, of waits %d", hotN, hotWaits)
	}
	t.Logf("folds by kind over the fixtures: %v; hot rows %d (waits %d)", kinds, hotN, hotWaits)
}
