package diag

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// repeat reads data n times.
type repeat struct {
	data []byte
	n    int
	pos  int
}

func (r *repeat) Read(p []byte) (int, error) {
	if r.n == 0 {
		return 0, io.EOF
	}
	c := copy(p, r.data[r.pos:])
	r.pos += c
	if r.pos == len(r.data) {
		r.pos, r.n = 0, r.n-1
	}
	return c, nil
}

// mixed is every committed fixture one after the other: heap dumps, process and system states, errorstacks.
func mixed(t testing.TB) []byte {
	var b bytes.Buffer
	for _, fx := range fixtures(t) {
		data, err := os.ReadFile(fx)
		if err != nil {
			t.Fatal(err)
		}
		b.Write(data)
		if !bytes.HasSuffix(data, []byte("\n")) {
			b.WriteByte('\n')
		}
	}
	return b.Bytes()
}

func BenchmarkScanMixed(b *testing.B) {
	data := mixed(b)
	b.SetBytes(int64(len(data)))
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := ScanReader(bytes.NewReader(data), "mixed.trc"); err != nil {
			b.Fatal(err)
		}
	}
}

func timeScan(t testing.TB, mk func() io.Reader, size int64, name string) (mbps float64, sc *Scan) {
	best := time.Duration(1 << 62)
	for i := 0; i < 3; i++ {
		t0 := time.Now()
		s, err := ScanReader(mk(), name)
		if err != nil {
			t.Fatal(err)
		}
		if d := time.Since(t0); d < best {
			best, sc = d, s
		}
	}
	return float64(size) / 1e6 / best.Seconds(), sc
}

// heapInUse is the live heap after a collection.
func heapInUse() uint64 {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}

// TestThroughput scans the fixtures one after the other, 12 times over (about 115 MB), and requires 200 MB/s, the plan's budget;
func TestThroughput(t *testing.T) {
	if testing.Short() || raceOn {
		t.Skip("short, or under the race detector")
	}
	data := mixed(t)
	const reps = 12
	mbps, sc := timeScan(t, func() io.Reader { return &repeat{data: data, n: reps} }, int64(len(data))*reps, "mixed.trc")
	t.Logf("mixed fixtures, %d MB, %d lines, %d top-level nodes: %.0f MB/s", len(data)*reps/1e6, sc.File.Lines, len(sc.Top), mbps)
	if mbps < 200 {
		t.Errorf("scan speed %.0f MB/s, want at least 200", mbps)
	}
}

// TestBigFixtures: the uncommitted traces of testdata/big/diag: invariants on all of them, the scan speed and
// the memory the scan holds, and the time of the children of the largest node.
func TestBigFixtures(t *testing.T) {
	files := bigFixtures()
	if len(files) == 0 {
		t.Skip("testdata/big/diag is not here (it is not in git)")
	}
	for _, p := range files {
		p := p
		t.Run(fixtureName(p), func(t *testing.T) {
			fi, err := os.Stat(p)
			if err != nil {
				t.Fatal(err)
			}
			before := heapInUse()
			var sc *Scan
			var mbps float64
			if !testing.Short() && !raceOn {
				mbps, sc = timeScan(t, func() io.Reader { f, _ := os.Open(p); return f }, fi.Size(), p)
			} else {
				sc, _ = ScanFile(p)
			}
			held := max(0, int64(heapInUse())-int64(before))
			runtime.KeepAlive(sc)
			var ms0, ms1 runtime.MemStats
			runtime.ReadMemStats(&ms0)
			if _, err := ScanFile(p); err != nil {
				t.Fatal(err)
			}
			runtime.ReadMemStats(&ms1)
			alloc := ms1.TotalAlloc - ms0.TotalAlloc
			r, err := OpenFile(p)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			checkTiling(t, fixtureName(p), r.Scan)
			checkNodes(t, fixtureName(p), r, 2)
			// the largest node with children, and what its children cost
			var big Node
			for _, n := range r.Scan.Top {
				if n.HasChildren && n.Lines > big.Lines {
					big = n
				}
			}
			var dur time.Duration
			if big.ID != "" {
				t0 := time.Now()
				if _, err := r.scanChildren(big.ID, 0, Cap); err != nil {
					t.Fatal(err)
				}
				dur = time.Since(t0)
			}
			t.Logf("%s: %.1f MB, %d lines, %d top-level nodes; scan %.0f MB/s, %.1f MB allocated, %.2f MB kept; children of the largest node (%d lines): %v",
				fixtureName(p), float64(fi.Size())/1e6, sc.File.Lines, len(sc.Top), mbps, float64(alloc)/1e6, float64(held)/1e6, big.Lines, dur.Round(time.Millisecond))
			if mbps > 0 && fi.Size() > 1<<20 && mbps < 200 {
				t.Errorf("scan speed %.0f MB/s, want at least 200", mbps)
			}
			if held > fi.Size()/4+(1<<20) {
				t.Errorf("the scan holds %d bytes of a file of %d", held, fi.Size())
			}
		})
	}
}

// TestChildrenSpeed: the children of a node of 100,000 lines cost under 50 ms (the plan's budget).
func TestChildrenSpeed(t *testing.T) {
	if testing.Short() || raceOn {
		t.Skip("short, or under the race detector")
	}
	// a system state of 100,000 lines: the PROCESS 2 block of the fixture, repeated
	data, err := os.ReadFile(filepath.Join(diagDir, "diag_sysstate_l1.trc"))
	if err != nil {
		t.Fatal(err)
	}
	ls := strings.Split(string(data), "\n")
	block := ls[2293:2576] // PROCESS 2: PMON
	var b strings.Builder
	b.WriteString("Trace file x.trc\nOracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production\nVersion 19.27.0.0.0\n\n")
	b.WriteString("===================================================\nSYSTEM STATE (level=10, with short stacks)\n------------\n")
	for b.Len() < 100000*45 {
		for _, l := range block {
			b.WriteString(l)
			b.WriteByte('\n')
		}
	}
	b.WriteString("END OF SYSTEM STATE\n")
	r := readerOfBytes(t, []byte(b.String()))
	var ss Node
	for _, n := range r.Scan.Top {
		if n.Kind == "sysstate" {
			ss = n
		}
	}
	if ss.Lines < 100000 {
		t.Fatalf("the synthetic system state has %d lines", ss.Lines)
	}
	best := time.Duration(1 << 62)
	for i := 0; i < 5; i++ {
		t0 := time.Now()
		o, err := r.scanChildren(ss.ID, 0, Cap)
		if err != nil || len(o.Children) == 0 {
			t.Fatal(err, o)
		}
		if d := time.Since(t0); d < best {
			best = d
		}
	}
	t.Logf("children of a node of %d lines: %v", ss.Lines, best.Round(time.Millisecond))
	if best > 50*time.Millisecond {
		t.Errorf("children of %d lines took %v", ss.Lines, best)
	}
	_ = fmt.Sprint
}
