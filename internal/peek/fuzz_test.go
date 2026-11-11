package peek

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

// Fuzz target: `go test` runs the seeds (real fixtures), and
//
//	go test ./internal/peek -run '^$' -fuzz '^FuzzPeek$' -fuzztime 1m
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

func FuzzPeek(f *testing.F) {
	seedTraces(f)
	f.Fuzz(func(t *testing.T, data []byte) {
		var s Summary
		_ = Read(context.Background(), bytes.NewReader(data), int64(len(data)), &s) // an error is an answer; a panic is not
	})
}
