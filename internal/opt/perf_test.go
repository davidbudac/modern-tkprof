package opt

import (
	"bufio"
	"bytes"
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

// BenchmarkScan: one pass over the 27,963-line two-dump fixture. The target is 100 MB/s.
func BenchmarkScan(b *testing.B) {
	data, err := os.ReadFile(filepath.Join(optDir, "opt_two.trc"))
	if err != nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(len(data)))
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		sc, err := ScanReader(bytes.NewReader(data), "opt_two.trc")
		if err != nil || len(sc.Dumps) != 2 {
			b.Fatal(err, len(sc.Dumps))
		}
	}
}

// BenchmarkScanJoin8: the join-heavy fixture, where the lines are mostly costing detail.
func BenchmarkScanJoin8(b *testing.B) {
	data, err := os.ReadFile(filepath.Join(optDir, "opt_join8.trc"))
	if err != nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(len(data)))
	for i := 0; i < b.N; i++ {
		if _, err := ScanReader(bytes.NewReader(data), "opt_join8.trc"); err != nil {
			b.Fatal(err)
		}
	}
}

// TestThroughput scans 100 copies of a fixture (a 130 MB file of 200 dumps) and requires 100 MB/s.
func TestThroughput(t *testing.T) {
	if testing.Short() || raceOn {
		t.Skip("short, or under the race detector")
	}
	data, err := os.ReadFile(filepath.Join(optDir, "opt_two.trc"))
	if err != nil {
		t.Fatal(err)
	}
	const reps = 100
	var best time.Duration
	var sc *Scan
	for i := 0; i < 3; i++ {
		t0 := time.Now()
		sc, err = ScanReader(&repeat{data: data, n: reps}, "big.trc")
		if err != nil {
			t.Fatal(err)
		}
		if el := time.Since(t0); best == 0 || el < best {
			best = el
		}
	}
	mb := float64(len(data)) * reps / 1e6
	t.Logf("%d dumps, %.0f MB, %d lines: %v = %.0f MB/s", len(sc.Dumps), mb, sc.File.Lines, best, mb/best.Seconds())
	if len(sc.Dumps) != 2*reps {
		t.Errorf("%d dumps, want %d", len(sc.Dumps), 2*reps)
	}
	if rate := mb / best.Seconds(); rate < 100 {
		t.Errorf("%.0f MB/s, want at least 100", rate)
	}
}

// TestHugeDump: one dump of more than two million lines (the costing of a statement with a 120 s parse is
// reported at that size) scans in one pass, with memory that is the model's, not the file's.
func TestHugeDump(t *testing.T) {
	if testing.Short() || raceOn {
		t.Skip("short, or under the race detector")
	}
	src, err := os.ReadFile(filepath.Join(optDir, "opt_join8.trc"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.SplitAfter(string(src), "\n")
	find := func(prefix string, from int) int {
		for i := from; i < len(lines); i++ {
			if strings.HasPrefix(lines[i], prefix) {
				return i
			}
		}
		t.Fatalf("no line %q", prefix)
		return -1
	}
	a := find("Join order[2]:", 0)
	b := find("Join order[3]:", a)
	block := strings.Join(lines[a:b], "")
	nblock := b - a
	copies := 2_000_000/nblock + 1
	pr, pw := io.Pipe()
	go func() {
		bw := bufio.NewWriterSize(pw, 1<<20)
		bw.WriteString(strings.Join(lines[:b], ""))
		for i := 0; i < copies; i++ {
			bw.WriteString(block)
		}
		bw.WriteString(strings.Join(lines[b:], ""))
		bw.Flush()
		pw.Close()
	}()
	var m0, m1 runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&m0)
	t0 := time.Now()
	sc, err := ScanReader(pr, "huge.trc")
	if err != nil {
		t.Fatal(err)
	}
	el := time.Since(t0)
	runtime.GC()
	runtime.ReadMemStats(&m1)
	size := float64(len(src)-len(strings.Join(lines[a:b], "")))/1e6 + float64(copies)*float64(len(block))/1e6
	if len(sc.Dumps) != 1 || sc.File.Lines < 2_000_000 {
		t.Fatalf("%d dumps, %d lines", len(sc.Dumps), sc.File.Lines)
	}
	d := sc.Dumps[0]
	nodes := 0
	walk(d.Tree, func(n, _ *Node) { nodes++ })
	heap := float64(int64(m1.HeapAlloc)-int64(m0.HeapAlloc)) / 1e6
	t.Logf("%d lines (%.0f MB) in %v = %.0f MB/s; %d nodes, %d landmarks, %d roles, digest %d ranges; heap held by the model %.0f MB",
		sc.File.Lines, size, el, size/el.Seconds(), nodes, len(d.Landmarks), len(d.Roles), len(d.Digest), heap)
	checkInvariants(t, "huge", sc)
	if d.Truncated || d.Plan == nil || d.PlanHash == "" || d.RunCount != 1 {
		t.Errorf("truncated %v, plan %v, hash %q, runs %d", d.Truncated, d.Plan != nil, d.PlanHash, d.RunCount)
	}
	if el > 30*time.Second {
		t.Errorf("took %v", el)
	}
	if heap > size/2 {
		t.Errorf("the model holds %.0f MB for a %.0f MB file", heap, size)
	}
	var out bytes.Buffer
	t0 = time.Now()
	if err := WriteDigest(&out, sc, nil, TextOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Logf("digest: %d bytes in %v", out.Len(), time.Since(t0))
}
