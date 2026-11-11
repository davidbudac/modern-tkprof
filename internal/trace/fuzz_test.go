package trace

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// Fuzz targets: `go test` runs the seeds (real fixtures), and
//
//	go test ./internal/trace -run '^$' -fuzz '^FuzzParse$' -fuzztime 1m
//
// searches from them. A trace is a file from somewhere else: whatever is in
// it, reading it must not panic.

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

func FuzzParse(f *testing.F) {
	seedTraces(f)
	f.Fuzz(func(t *testing.T, data []byte) {
		st, err := Parse(bytes.NewReader(data), NopHandler{})
		if err != nil {
			t.Fatalf("Parse of a byte slice: %v", err)
		}
		if st.Bytes != int64(len(data)) {
			t.Fatalf("%d bytes read of %d", st.Bytes, len(data))
		}
	})
}

func FuzzLineIndex(f *testing.F) {
	seedTraces(f)
	f.Fuzz(func(t *testing.T, data []byte) {
		path := filepath.Join(t.TempDir(), "f.trc")
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		li, err := OpenLineIndex(path)
		if err != nil {
			t.Fatal(err)
		}
		defer li.Close()
		want := bytes.Count(data, []byte("\n"))
		if len(data) > 0 && data[len(data)-1] != '\n' {
			want++
		}
		if li.Lines() != want || li.Size() != int64(len(data)) {
			t.Fatalf("%d lines, %d bytes; want %d, %d", li.Lines(), li.Size(), want, len(data))
		}
		all, err := li.Read(1, li.Lines())
		if err != nil || !bytes.Equal(all, data) {
			t.Fatalf("Read(1, all): %v, %d bytes of %d", err, len(all), len(data))
		}
		if n := li.Lines(); n > 0 { // the last line alone, through the checkpoints
			last, err := li.Read(n, 1)
			if err != nil || !bytes.HasSuffix(data, last) || len(last) == 0 {
				t.Fatalf("Read(%d, 1): %v, %q", n, err, last)
			}
		}
		var buf bytes.Buffer
		if err := li.Save(&buf); err != nil {
			t.Fatal(err)
		}
		back, err := LoadLineIndex(path, &buf)
		if err != nil {
			t.Fatalf("LoadLineIndex of what Save wrote: %v", err)
		}
		defer back.Close()
		if back.Lines() != li.Lines() || back.Size() != li.Size() {
			t.Fatalf("after Save and Load: %d lines, %d bytes; want %d, %d", back.Lines(), back.Size(), li.Lines(), li.Size())
		}
	})
}
