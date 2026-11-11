package model_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// Fuzz target: `go test` runs the seeds (real fixtures), and
//
//	go test ./internal/model -run '^$' -fuzz '^FuzzBuild$' -fuzztime 1m
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

func FuzzBuild(f *testing.F) {
	seedTraces(f)
	f.Fuzz(func(t *testing.T, data []byte) {
		path := filepath.Join(t.TempDir(), "f.trc")
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		// Build reads this one file only: a TRACE CONTINUES IN FILE marker in data is not followed
		m, err := model.Build(path, model.Options{})
		if err == nil && m == nil {
			t.Fatal("no model and no error")
		}
	})
}
