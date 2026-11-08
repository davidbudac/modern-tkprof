package model

import (
	"context"
	"errors"
	"io"
	"testing"
)

// A build with a cancelled Options.Ctx returns the context's error instead
// of a model; one with a live context is the build without it.
func TestBuildCtx(t *testing.T) {
	const path = "../../testdata/traces/19c/io_waits.trc"
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, o := range []Options{{Ctx: ctx}, {Ctx: ctx, Aggregate: true}} {
		if m, err := Build(path, o); !errors.Is(err, context.Canceled) || m != nil {
			t.Fatalf("aggregate=%v: %v, %v; want context.Canceled", o.Aggregate, m != nil, err)
		}
	}
	want, err := Build(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := Build(path, Options{Ctx: context.Background()})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Calls) != len(want.Calls) || len(got.Waits) != len(want.Waits) || got.Diag.Bytes != want.Diag.Bytes || got.Diag.Lines != want.Diag.Lines {
		t.Fatalf("with a context: %d calls %d waits %d bytes, without %d %d %d", len(got.Calls), len(got.Waits), got.Diag.Bytes, len(want.Calls), len(want.Waits), want.Diag.Bytes)
	}
}

// chunks is an endless reader of 64 KiB chunks that counts its reads.
type chunks struct{ reads int }

func (c *chunks) Read(p []byte) (int, error) {
	c.reads++
	n := min(len(p), 64<<10)
	for i := range p[:n] {
		p[i] = 'x'
	}
	p[n-1] = '\n'
	return n, nil
}

// The reader stops at the first read after the context is done: a build
// cancelled mid-parse reads at most one more buffer.
func TestProgressReaderCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	src := &chunks{}
	r := progressReader{src, &progress{ctx: ctx}}
	buf := make([]byte, 1<<20)
	for i := 0; i < 3; i++ {
		if _, err := r.Read(buf); err != nil {
			t.Fatal(err)
		}
	}
	cancel()
	if n, err := r.Read(buf); n != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("after cancel: %d, %v", n, err)
	}
	if src.reads != 3 {
		t.Fatalf("%d reads of the source, want 3", src.reads)
	}
	var _ io.Reader = r
}
