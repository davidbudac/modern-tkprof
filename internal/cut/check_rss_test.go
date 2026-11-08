//go:build unix

package cut_test

import (
	"context"
	"os"
	"runtime"
	"syscall"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/cut"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// The F13 RSS measurement: the peak resident set of the parse back alone, one
// process per build, so that nothing else in the process sets the peak.
//
//	MTKPROF_CHECK_TRACE=/path/big.trc MTKPROF_CUT_OUT=/tmp/whole-cut.trc go test -count=1 -run TestWriteWholeCut -v ./internal/cut
//	MTKPROF_CUT_FILE=/tmp/whole-cut.trc MTKPROF_PARSE=full go test -count=1 -run TestParseCutRSS -v ./internal/cut
//	MTKPROF_CUT_FILE=/tmp/whole-cut.trc MTKPROF_PARSE=agg  go test -count=1 -run TestParseCutRSS -v ./internal/cut

func TestWriteWholeCut(t *testing.T) {
	out := os.Getenv("MTKPROF_CUT_OUT")
	if out == "" {
		t.Skip("MTKPROF_CUT_OUT not set")
	}
	_, c := open(t, largest19c(t))
	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	p, err := c.Write(context.Background(), cut.Selection{}, f)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	t.Logf("%s: %d lines, %d bytes, %d calls, %d waits", out, p.Lines, p.Bytes, p.Calls, p.Waits)
}

func TestParseCutRSS(t *testing.T) {
	path := os.Getenv("MTKPROF_CUT_FILE")
	if path == "" {
		t.Skip("MTKPROF_CUT_FILE not set")
	}
	var o model.Options
	switch os.Getenv("MTKPROF_PARSE") {
	case "full":
	case "agg":
		o = model.Options{Aggregate: true, SpillBinds: true, NewTee: cut.NewCheckSink}
	default:
		t.Fatal("MTKPROF_PARSE: full|agg")
	}
	before := maxRSS(t)
	m, err := model.Build(path, o)
	if err != nil {
		t.Fatal(err)
	}
	var ms runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&ms)
	runtime.KeepAlive(m)
	t.Logf("%s parse: max RSS %d MiB (before the parse %d MiB), heap kept %d MiB, %d MiB allocated",
		os.Getenv("MTKPROF_PARSE"), maxRSS(t)>>20, before>>20, ms.HeapAlloc>>20, ms.TotalAlloc>>20)
}

// maxRSS is the process's peak resident set in bytes (ru_maxrss: bytes on
// darwin, KiB elsewhere).
func maxRSS(t *testing.T) int64 {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "darwin" {
		return int64(ru.Maxrss)
	}
	return int64(ru.Maxrss) << 10
}
