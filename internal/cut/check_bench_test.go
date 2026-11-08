package cut_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"runtime/metrics"
	"sync/atomic"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/cut"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// The F13 measurement: a re-parse check of the whole largest 19c fixture.
//
//	go test -run NONE -bench 'CheckWhole|ParseCut' -benchmem ./internal/cut
//	MTKPROF_CHECK_TRACE=/path/big.trc go test -run NONE -bench ParseCut -benchtime 3x ./internal/cut
//
// BenchmarkCheckWhole is the whole check (write, parse back, compare); the
// ParseCut pair is the parse back alone, full build (the check before F13)
// against the aggregation-only build with the check's sink, with the heap
// its result keeps alive (live-B: what the comparison holds while it runs)
// and the peak of the heap's objects while it parses (peak-B, sampled every
// 20 µs, above the heap before it).

// largest19c is the biggest 19c fixture, or the trace MTKPROF_CHECK_TRACE
// names (a bigger one, to see how the two builds scale).
func largest19c(tb testing.TB) string {
	tb.Helper()
	if p := os.Getenv("MTKPROF_CHECK_TRACE"); p != "" {
		return p
	}
	ms, _ := filepath.Glob(filepath.Join("..", "..", "testdata", "traces", "19c", "*.trc"))
	best, size := "", int64(-1)
	for _, p := range ms {
		if fi, err := os.Stat(p); err == nil && fi.Size() > size {
			best, size = p, fi.Size()
		}
	}
	if best == "" {
		tb.Fatal("no 19c fixture")
	}
	return best
}

func BenchmarkCheckWhole(b *testing.B) {
	path := largest19c(b)
	_, c := open(&testing.T{}, path)
	dir := b.TempDir()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ck, err := c.Check(context.Background(), cut.Selection{}, dir)
		if err != nil || !ck.OK {
			b.Fatalf("%s: %+v %v", path, ck, err)
		}
	}
}

// writeWholeCut writes the cut of the whole of the largest 19c fixture to a file.
func writeWholeCut(b *testing.B) string {
	_, c := open(&testing.T{}, largest19c(b))
	f, err := os.Create(filepath.Join(b.TempDir(), "whole-cut.trc"))
	if err != nil {
		b.Fatal(err)
	}
	if _, err := c.Write(context.Background(), cut.Selection{}, f); err != nil {
		b.Fatal(err)
	}
	if err := f.Close(); err != nil {
		b.Fatal(err)
	}
	return f.Name()
}

// liveAfter is the heap in use after a GC while keep is reachable.
func liveAfter(keep any) uint64 {
	var ms runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&ms)
	runtime.KeepAlive(keep)
	return ms.HeapAlloc
}

// heapObjects is the heap's live and not yet swept objects (runtime/metrics: no stop of the world).
func heapObjects() uint64 {
	s := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
	metrics.Read(s)
	return s[0].Value.Uint64()
}

// peakDuring is the most the heap's objects grew over their level before fn while fn ran.
func peakDuring(fn func()) uint64 {
	runtime.GC()
	base := heapObjects()
	var peak atomic.Uint64
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if h := heapObjects(); h > peak.Load() {
				peak.Store(h)
			}
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Microsecond):
			}
		}
	}()
	fn()
	close(stop)
	<-done
	if p := peak.Load(); p > base {
		return p - base
	}
	return 0
}

func benchParse(b *testing.B, opts func() model.Options) {
	path := writeWholeCut(b)
	base := liveAfter(nil)
	var live, peak uint64
	peak = peakDuring(func() {
		m, err := model.Build(path, opts())
		if err != nil {
			b.Fatal(err)
		}
		if l := liveAfter(m); l > base {
			live = l - base
		}
	})
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := model.Build(path, opts()); err != nil {
			b.Fatal(err)
		}
	}
	b.ReportMetric(float64(live), "live-B")
	b.ReportMetric(float64(peak), "peak-B")
}

func BenchmarkParseCutFull(b *testing.B) {
	benchParse(b, func() model.Options { return model.Options{} })
}

func BenchmarkParseCutAggregate(b *testing.B) {
	benchParse(b, func() model.Options {
		return model.Options{Aggregate: true, SpillBinds: true, NewTee: cut.NewCheckSink}
	})
}
