package cut_test

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/cut"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Fuzz target: `go test` runs the seeds (real fixtures), and
//
//	go test ./internal/cut -run '^$' -fuzz '^FuzzCutWrite$' -fuzztime 1m
//
// searches from them.

func seedTraces(f *testing.F) {
	f.Helper()
	for _, name := range []string{"level_1.trc", "parallel_slave.trc", "midtrace_start_part1.trc", "bind_types.trc", "nasty_sql.trc"} {
		b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "traces", "19c", name))
		if err != nil {
			f.Fatal(err)
		}
		f.Add(b)
	}
}

func FuzzCutWrite(f *testing.F) {
	seedTraces(f)
	f.Fuzz(func(t *testing.T, data []byte) {
		path := filepath.Join(t.TempDir(), "f.trc")
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		m, err := model.Build(path, model.Options{})
		if err != nil {
			return
		}
		li, err := trace.OpenLineIndex(path)
		if err != nil {
			t.Fatal(err)
		}
		defer li.Close()
		c := cut.New(m, slice.MemSource(m), []*trace.LineIndex{li})
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = c.Write(ctx, cut.Selection{}, io.Discard) // an error is an answer; a panic is not
	})
}
