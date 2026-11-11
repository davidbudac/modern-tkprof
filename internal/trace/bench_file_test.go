package trace

import (
	"os"
	"testing"
)

// BenchmarkParseFile parses the file named by MTK_BENCH_FILE with a no-op
// handler: the throughput of the parser itself (go test -bench ParseFile).
func BenchmarkParseFile(b *testing.B) {
	path := os.Getenv("MTK_BENCH_FILE")
	if path == "" {
		b.Skip("MTK_BENCH_FILE not set")
	}
	fi, err := os.Stat(path)
	if err != nil {
		b.Fatal(err)
	}
	b.SetBytes(fi.Size())
	for i := 0; i < b.N; i++ {
		if _, err := ParseFile(path, NopHandler{}); err != nil {
			b.Fatal(err)
		}
	}
}
