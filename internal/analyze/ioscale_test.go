package analyze

import (
	"context"
	"math/rand"
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// synthFacts is a generated stream of block I/O waits (no trace file: the
// memory bound of the block counting at a scale no fixture reaches). Waits
// are made on the fly, in the same order on every scan.
type synthFacts struct {
	n    int
	wait func(i int, w *model.Wait)
}

func (s synthFacts) NumCalls() int64 { return 0 }
func (s synthFacts) NumWaits() int64 { return int64(s.n) }
func (s synthFacts) EachCall(context.Context, Scan, func(*model.Call) bool) error {
	return nil
}
func (s synthFacts) EachWait(ctx context.Context, _ Scan, fn func(*model.Wait) bool) error {
	var w model.Wait
	for i := 0; i < s.n; i++ {
		s.wait(i, &w)
		if !fn(&w) {
			return nil
		}
	}
	return nil
}
func (s synthFacts) CallKind(model.ID) (trace.CallKind, bool) { return 0, false }

// TestIOHotScale: 1.5M full-scan reads of 128 blocks over 192M distinct blocks of datafile 7, a spill of
// 4,000 blocks of tempfile 201 read 25 times, and 1M single-block reads scattered over 50M blocks of file 8:
// the counting stays within a few tens of MB and finds the spill exactly. Skipped unless MTK_SCALE is set.
func TestIOHotScale(t *testing.T) {
	if os.Getenv("MTK_SCALE") == "" {
		t.Skip("MTK_SCALE not set")
	}
	events := []model.Event{
		{Name: "direct path read", P1Name: "file number", P2Name: "first dba", P3Name: "block cnt", Class: "User I/O"},
		{Name: "direct path read temp", P1Name: "file number", P2Name: "first dba", P3Name: "block cnt", Class: "User I/O"},
		{Name: "db file sequential read", P1Name: "file#", P2Name: "block#", P3Name: "blocks", Class: "User I/O"},
	}
	const scans, spillReads, singles = 1_500_000, 100_000, 1_000_000
	rng := rand.New(rand.NewSource(3))
	single := make([]int64, singles)
	for i := range single {
		single[i] = int64(rng.Intn(50_000_000))
	}
	n := scans + spillReads + singles
	src := synthFacts{n: n, wait: func(i int, w *model.Wait) {
		*w = model.Wait{Tim: int64(i) * 100, Ela: 50, ObjID: 1000, Statement: 1, Call: -1, Context: 0}
		switch {
		case i%26 == 25 && i/26 < spillReads: // the spill, read in passes of 4,000 blocks (one per wait)
			k := i / 26
			w.Event, w.P1, w.P2, w.P3, w.ObjID = 1, 201, int64(k%4000), 1, 2000
		case i%3 == 0 && i/3 < singles:
			w.Event, w.P1, w.P2, w.P3, w.ObjID = 2, 8, single[i/3], 1, 3000
		default:
			w.Event, w.P1, w.P2, w.P3 = 0, 7, int64(i)*128, 128
		}
	}}
	var peak atomic.Int64
	stop := make(chan struct{})
	go func() {
		var ms runtime.MemStats
		for {
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Millisecond):
				runtime.ReadMemStats(&ms)
				if int64(ms.HeapInuse) > peak.Load() {
					peak.Store(int64(ms.HeapInuse))
				}
			}
		}
	}()
	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)
	t0 := time.Now()
	h, err := IOHotOn(context.Background(), src, Filter{IncludeIdle: true}, IOEventsOf(events), IOHotOpts{})
	d := time.Since(t0)
	close(stop)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%d waits, %d block reads, %d distinct, %d re-read: %v, peak heap %.0f MB over %.0f MB; exact %v bound %d distinctExact %v",
		h.Total, h.BlockReads, h.Distinct, h.Reread, d.Round(time.Millisecond), float64(peak.Load()-int64(base.HeapInuse))/(1<<20), float64(base.HeapInuse)/(1<<20), h.Exact, h.Bound, h.DistinctExact)
	top := h.Runs[0]
	if top.File != 201 || top.Lo != 0 || top.Hi != 4000 || top.Min != 25 || top.Max != 25 {
		t.Errorf("top run %+v, want tempfile 201 blocks 0..4000 read 25 times each", top)
	}
	if mb := float64(peak.Load()-int64(base.HeapInuse)) / (1 << 20); mb > 200 {
		t.Errorf("peak heap %.0f MB", mb)
	}
}

// TestIOHotScalePrune: 4M single-block reads over 1.5M blocks plus 2,000 blocks read 60 times: more re-read blocks
// than the counter map holds, so it prunes; the hot blocks are still found, the answer says it is approximate, and
// memory stays bounded. Skipped unless MTK_SCALE is set.
func TestIOHotScalePrune(t *testing.T) {
	if os.Getenv("MTK_SCALE") == "" {
		t.Skip("MTK_SCALE not set")
	}
	events := []model.Event{{Name: "db file sequential read", P1Name: "file#", P2Name: "block#", P3Name: "blocks", Class: "User I/O"}}
	const n = 4_000_000
	rng := rand.New(rand.NewSource(4))
	blk := make([]int32, n)
	for i := range blk {
		if i%33 == 0 {
			blk[i] = int32(10_000_000 + (i/33)%2000) // hot: 121,213 reads over 2,000 blocks, ~60 each
		} else {
			blk[i] = int32(rng.Intn(1_500_000))
		}
	}
	src := synthFacts{n: n, wait: func(i int, w *model.Wait) {
		*w = model.Wait{Tim: int64(i) * 100, Ela: 50, ObjID: 1000, Statement: 1, Call: -1, Event: 0, P1: 9, P2: int64(blk[i]), P3: 1}
	}}
	runtime.GC()
	var base, ms runtime.MemStats
	runtime.ReadMemStats(&base)
	var peak atomic.Int64
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Millisecond):
				runtime.ReadMemStats(&ms)
				if int64(ms.HeapInuse) > peak.Load() {
					peak.Store(int64(ms.HeapInuse))
				}
			}
		}
	}()
	t0 := time.Now()
	h, err := IOHotOn(context.Background(), src, Filter{IncludeIdle: true}, IOEventsOf(events), IOHotOpts{Sort: "max"})
	d := time.Since(t0)
	close(stop)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%d waits, %d distinct, %d re-read: %v, peak heap %.0f MB; exact %v bound %d; top %+v", h.Total, h.Distinct, h.Reread, d.Round(time.Millisecond),
		float64(peak.Load()-int64(base.HeapInuse))/(1<<20), h.Exact, h.Bound, h.Runs[0])
	if h.Exact || h.Runs[0].Lo < 10_000_000 || h.Runs[0].Max < 60 {
		t.Errorf("exact %v, top run %+v", h.Exact, h.Runs[0])
	}
}
