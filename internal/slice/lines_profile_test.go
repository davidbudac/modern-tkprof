package slice

import (
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// bruteProfile counts the profile of one file straight from the model rows.
func bruteProfile(m *model.Model, file, total, buckets int) linesProfile {
	b := min(buckets, total)
	p := linesProfile{Total: total, Buckets: b, Size: (total + b - 1) / b}
	p.Calls, p.Waits, p.Cursors, p.Errors, p.Commits = make([]int, b), make([]int, b), make([]int, b), make([]int, b), make([]int, b)
	in := func(ctx model.ID) bool {
		return ctx >= 0 && int(ctx) < len(m.Contexts) && m.Contexts[ctx].FileIdx == file
	}
	add := func(dst []int, line int) {
		if line >= 1 && line <= total {
			dst[(line-1)/p.Size]++
		}
	}
	for i := range m.Calls {
		if in(m.Calls[i].Context) {
			add(p.Calls, int(m.Calls[i].Line))
		}
	}
	for i := range m.Waits {
		if in(m.Waits[i].Context) {
			add(p.Waits, int(m.Waits[i].Line))
		}
	}
	for i := range m.Cursors {
		if c := &m.Cursors[i]; in(c.Context) && !c.Implicit {
			add(p.Cursors, c.Line)
		}
	}
	for i := range m.Errors {
		if in(m.Errors[i].Context) {
			add(p.Errors, m.Errors[i].Line)
		}
	}
	for i := range m.Transactions {
		if in(m.Transactions[i].Context) {
			add(p.Commits, m.Transactions[i].Line)
		}
	}
	p.MaxCalls, p.MaxWaits = slices.Max(p.Calls), slices.Max(p.Waits)
	return p
}

func sum(x []int) (n int) {
	for _, v := range x {
		n += v
	}
	return
}

func TestLinesProfile(t *testing.T) {
	for name, paths := range fixtureSets(t) {
		t.Run(name, func(t *testing.T) {
			e := newLineEnv(t, paths)
			infos := New(e.full).WithLines(e.lis).files()
			for file, li := range e.lis {
				total := li.Lines()
				f := infos[file]
				for _, buckets := range []int{1, 7, 200, 2000} {
					code, body := e.both(t, fmt.Sprintf("/api/lines/profile?file=%d&buckets=%d", file, buckets))
					if code != 200 {
						t.Fatalf("file %d buckets %d: %d %s", file, buckets, code, body)
					}
					var got linesProfile
					if err := json.Unmarshal(body, &got); err != nil {
						t.Fatal(err)
					}
					if total == 0 {
						if got.Total != 0 || got.Buckets != 0 || got.Size != 0 || len(got.Calls) != 0 {
							t.Fatalf("empty file: %+v", got)
						}
						continue
					}
					wantB := min(buckets, total)
					if got.Total != total || got.Buckets != wantB || got.Size != (total+wantB-1)/wantB {
						t.Fatalf("file %d buckets %d: total/buckets/size = %d/%d/%d, file has %d lines", file, buckets, got.Total, got.Buckets, got.Size, total)
					}
					for _, a := range [][]int{got.Calls, got.Waits, got.Cursors, got.Errors, got.Commits} {
						if len(a) != wantB {
							t.Fatalf("file %d buckets %d: array of %d, want %d", file, buckets, len(a), wantB)
						}
					}
					// the sums: one count per fact row of the file, per listed element
					if n, want := sum(got.Calls), int(f.calls.hi-f.calls.lo); n != want {
						t.Fatalf("file %d buckets %d: %d calls, file has %d", file, buckets, n, want)
					}
					if n, want := sum(got.Waits), int(f.waits.hi-f.waits.lo); n != want {
						t.Fatalf("file %d buckets %d: %d waits, file has %d", file, buckets, n, want)
					}
					if sum(got.Cursors) != len(f.cursors) || sum(got.Errors) != len(f.errors) || sum(got.Commits) != len(f.commits) {
						t.Fatalf("file %d buckets %d: cursors/errors/commits %d/%d/%d, want %d/%d/%d", file, buckets,
							sum(got.Cursors), sum(got.Errors), sum(got.Commits), len(f.cursors), len(f.errors), len(f.commits))
					}
					if got.MaxCalls != slices.Max(got.Calls) || got.MaxWaits != slices.Max(got.Waits) {
						t.Fatalf("file %d buckets %d: max %d/%d", file, buckets, got.MaxCalls, got.MaxWaits)
					}
					// every bucket against a count over the model rows
					want := bruteProfile(e.full, file, total, buckets)
					if !slices.Equal(got.Calls, want.Calls) || !slices.Equal(got.Waits, want.Waits) || !slices.Equal(got.Cursors, want.Cursors) ||
						!slices.Equal(got.Errors, want.Errors) || !slices.Equal(got.Commits, want.Commits) {
						t.Fatalf("file %d buckets %d: buckets differ from the model\n got  %+v\n want %+v", file, buckets, got, want)
					}
				}
			}
			// 400s and 404s
			for _, u := range []string{"/api/lines/profile?buckets=0", "/api/lines/profile?buckets=2001", "/api/lines/profile?buckets=x"} {
				if code, b := e.both(t, u); code != 400 {
					t.Fatalf("%s: %d %s, want 400", u, code, b)
				}
			}
			if code, b := e.both(t, fmt.Sprintf("/api/lines/profile?file=%d", len(e.lis))); code != 404 {
				t.Fatalf("bad file: %d %s, want 404", code, b)
			}
		})
	}
}

// TestLinesProfileContent makes sure the fixtures that matter really have
// something to count, so the comparison above is not vacuous.
func TestLinesProfileContent(t *testing.T) {
	for _, name := range []string{"basic_binds.trc", "io_waits.trc"} {
		e := newLineEnv(t, []string{traces + name})
		code, body := e.both(t, "/api/lines/profile?file=0&buckets=50")
		var p linesProfile
		if code != 200 || json.Unmarshal(body, &p) != nil {
			t.Fatalf("%s: %d %s", name, code, body)
		}
		if sum(p.Calls) == 0 || p.MaxCalls == 0 {
			t.Fatalf("%s: no calls in %+v", name, p)
		}
		if name == "io_waits.trc" && (sum(p.Waits) == 0 || p.MaxWaits == 0) {
			t.Fatalf("%s: no waits in %+v", name, p)
		}
	}
}
