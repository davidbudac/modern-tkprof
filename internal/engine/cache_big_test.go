package engine

import (
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/report"
)

// TestCacheBigTiming measures a fresh build into the cache and a reopen of a
// large trace: MTKPROF_BIG=/path/to/big_loop.trc go test ./internal/engine -run Big -v
func TestCacheBigTiming(t *testing.T) {
	p := os.Getenv("MTKPROF_BIG")
	if p == "" {
		t.Skip("MTKPROF_BIG not set")
	}
	c := openCache(t, t.TempDir(), 0)
	start := time.Now()
	op := openTrace(t, c, []string{p}, CacheOpenOptions{})
	build := time.Since(start)
	op.Close()
	bytes, _, _ := c.Stats()
	runtime.GC()
	for i := 0; i < 3; i++ {
		start = time.Now()
		op = openTrace(t, c, []string{p}, CacheOpenOptions{})
		reopen := time.Since(start)
		if !op.Hit {
			t.Fatal("not a hit")
		}
		start = time.Now()
		doc, err := report.DocumentBytes(op.Model, report.DocOptions{Packed: true, Slice: true})
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("reopen %v (+ document %v, %.1f MB)", reopen.Round(time.Millisecond), time.Since(start).Round(time.Millisecond), float64(len(doc))/1e6)
		op.Close()
	}
	t.Logf("fresh build + persist %v; entry %.1f MB", build.Round(time.Millisecond), float64(bytes)/1e6)
	for _, e := range c.Entries() {
		t.Logf("sources %v", e.Sources)
	}
}
