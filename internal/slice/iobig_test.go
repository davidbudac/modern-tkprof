package slice

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestIOBig times the I/O map routes on the big local traces (testdata/big,
// gitignored) in spill mode, as the engine serves them. Skipped unless
// MTK_BIG is set: MTK_BIG=1 go test ./internal/slice -run IOBig -v
// (MTK_BIG=name.trc for one trace; MTK_BIG_DIR for another directory, e.g.
// the main checkout's from a worktree).
func TestIOBig(t *testing.T) {
	sel := os.Getenv("MTK_BIG")
	if sel == "" {
		t.Skip("MTK_BIG not set")
	}
	dir := os.Getenv("MTK_BIG_DIR")
	if dir == "" {
		dir = "../../testdata/big"
	}
	paths, _ := filepath.Glob(filepath.Join(dir, "*.trc"))
	for _, p := range paths {
		if sel != "1" && !strings.Contains(p, sel) {
			continue
		}
		t.Run(filepath.Base(p), func(t *testing.T) {
			m, sp := buildSpilled(t, []string{p}, t.TempDir())
			defer sp.Close()
			src, err := sp.Source()
			if err != nil {
				t.Fatal(err)
			}
			h := NewServer(m, src).Handler()
			for _, q := range bigIOQueries {
				var ms runtime.MemStats
				runtime.GC()
				runtime.ReadMemStats(&ms)
				before := ms.TotalAlloc
				t0 := time.Now()
				code, body := fetch(h, q)
				d := time.Since(t0)
				runtime.ReadMemStats(&ms)
				if code != http.StatusOK {
					t.Errorf("%s: %d %s", q, code, body)
					continue
				}
				var top map[string]json.RawMessage
				sizes := ""
				if json.Unmarshal(body, &top) == nil {
					for k, v := range top {
						if len(v) > 20000 {
							sizes += fmt.Sprintf(" %s %d KB", k, len(v)/1024)
						}
					}
				}
				t.Logf("%-60s%s", q, sizes)
				t.Logf("%-60s %7.1f ms  %8d bytes  %6.1f MB allocated", q, float64(d.Microseconds())/1000, len(body), float64(ms.TotalAlloc-before)/(1<<20))
			}
		})
	}
}

var bigIOQueries = []string{
	"/api/io/map?limit=20000",
	"/api/io/map?limit=5000",
	"/api/io/map?limit=100000",
	"/api/io/map?limit=20000&reads=1",
	"/api/io/hot",
	"/api/io/hot?sort=max&limit=500",
	"/api/io/density",
	"/api/io/density?x=time&xbins=300&ybins=80",
	"/api/io/density?xbins=300&ybins=80",
}
