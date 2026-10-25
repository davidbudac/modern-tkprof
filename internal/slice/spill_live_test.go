package slice

import (
	"context"
	"io"
	"os"
	"slices"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// cutReader hands data to the parser in pieces that end at the cuts and
// calls at() when the parser asks for more after a cut (every line before
// it has been delivered then).
type cutReader struct {
	data []byte
	off  int
	cuts []int
	at   func()
}

func (r *cutReader) Read(p []byte) (int, error) {
	for len(r.cuts) > 0 && r.cuts[0] <= r.off {
		r.at()
		r.cuts = r.cuts[1:]
	}
	if r.off == len(r.data) {
		return 0, io.EOF
	}
	end := len(r.data)
	if len(r.cuts) > 0 {
		end = r.cuts[0]
	}
	n := copy(p, r.data[r.off:end])
	r.off += n
	return n, nil
}

// TestLivePostings: at snapshots between lines, the statement postings of
// a live spill (cursor index + the overlay's rows) are never nil, hold
// every row of the statement a full scan finds and nothing at or past the
// snapshot's row count, and a statement scan answers what a filtered full
// scan answers. Tiny buffers make the index write many blocks.
func TestLivePostings(t *testing.T) {
	defer func(a, b int) { curTailMax, curBufMax = a, b }(curTailMax, curBufMax)
	curTailMax, curBufMax = 3, 40
	for _, name := range []string{"io_waits", "plsql_recursive", "cursor_cache", "errors", "multisession", "midtrace_start"} {
		t.Run(name, func(t *testing.T) {
			src := traces + name + ".trc"
			data, err := os.ReadFile(src)
			if err != nil {
				t.Fatal(err)
			}
			var cuts []int
			for i, c := range data {
				if c == '\n' && (len(cuts) == 0 || i+1-cuts[len(cuts)-1] > len(data)/25) {
					cuts = append(cuts, i+1)
				}
			}
			sp, err := NewSpill(SpillOptions{Dir: t.TempDir(), Key: "live", Live: true})
			if err != nil {
				t.Fatal(err)
			}
			defer sp.Close()
			th := analyze.DefaultThresholds()
			b := model.NewLiveBuilder(src, model.Options{NoFacts: true, Aggregate: true, SpillBinds: true,
				NewSink: func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, th) },
				NewTee:  sp.Attach})
			p := trace.New(b)
			snaps := 0
			check := func() {
				ov := sp.Overlay()
				m := b.Snapshot(p.Stats(), p.Pending, ov)
				fs, err := ov.Source(m)
				if err != nil {
					t.Fatal(err)
				}
				d := fs.(liveSource).diskSource
				ctx := context.Background()
				for s := range m.Statements {
					sid := model.ID(s)
					for _, tab := range []struct {
						name string
						lr   *liveRows
						n    int64
						each func(analyze.Scan, func(id model.ID, st model.ID)) error
					}{
						{"calls", d.lcalls, d.nCalls, func(sc analyze.Scan, fn func(model.ID, model.ID)) error {
							return d.EachCall(ctx, sc, func(c *model.Call) bool { fn(c.ID, c.Statement); return true })
						}},
						{"waits", d.lwaits, d.nWaits, func(sc analyze.Scan, fn func(model.ID, model.ID)) error {
							return d.EachWait(ctx, sc, func(w *model.Wait) bool { fn(w.ID, w.Statement); return true })
						}},
					} {
						ids, err := d.livePostings(tab.lr, []model.ID{sid}, tab.n)
						if err != nil || ids == nil {
							t.Fatalf("%s postings of statement %d: %v %v", tab.name, s, ids, err)
						}
						post := ids.mem
						if len(post) > 0 && int64(post[len(post)-1]) >= tab.n {
							t.Fatalf("%s posting %d past the %d rows", tab.name, post[len(post)-1], tab.n)
						}
						var full, scoped []model.ID
						tab.each(analyze.Scan{}, func(id, st model.ID) {
							if st == sid {
								full = append(full, id)
							}
						})
						tab.each(analyze.Scan{Statements: []model.ID{sid}}, func(id, st model.ID) {
							if st == sid {
								scoped = append(scoped, id)
							}
						})
						for _, id := range full {
							if _, ok := slices.BinarySearch(post, uint32(id)); !ok {
								t.Fatalf("snapshot %d: %s row %d of statement %d not in its postings", snaps, tab.name, id, s)
							}
						}
						if !slices.Equal(full, scoped) {
							t.Fatalf("snapshot %d: %s of statement %d: scoped scan %v, full scan %v", snaps, tab.name, s, scoped, full)
						}
					}
				}
				snaps++
			}
			r := &cutReader{data: data, cuts: cuts, at: check}
			if _, err := p.Run(r); err != nil {
				t.Fatal(err)
			}
			check()
			if sp.lcalls.end == 0 {
				t.Errorf("no index block written")
			}
			t.Logf("%d snapshots", snaps)
		})
	}
}
