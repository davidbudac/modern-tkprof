package slice

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/cut"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// blockingRun is a check that waits until it is released or cancelled, and
// says how many runs overlap.
type blockingRun struct {
	started, inFlight, maxInFlight atomic.Int32
	release                        chan struct{}
}

func newBlockingRun() *blockingRun { return &blockingRun{release: make(chan struct{})} }

func (b *blockingRun) run(ctx context.Context) (*cut.Check, error) {
	b.started.Add(1)
	n := b.inFlight.Add(1)
	defer b.inFlight.Add(-1)
	for {
		m := b.maxInFlight.Load()
		if n <= m || b.maxInFlight.CompareAndSwap(m, n) {
			break
		}
	}
	select {
	case <-b.release:
		return &cut.Check{OK: true}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); !cond(); {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// Requests for the selection being checked wait for that one check.
func TestRunCheckSameSelectionShares(t *testing.T) {
	s := &Server{}
	b := newBlockingRun()
	var wg sync.WaitGroup
	errs := make([]error, 3)
	for i := range errs {
		wg.Add(1)
		go func() { defer wg.Done(); _, errs[i] = s.runCheck(context.Background(), "from=1", b.run) }()
	}
	waitFor(t, "the check to start", func() bool { return b.started.Load() == 1 })
	waitFor(t, "three waiters", func() bool { s.checkMu.Lock(); defer s.checkMu.Unlock(); return s.check != nil && s.check.waiters == 3 })
	close(b.release)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("waiter %d: %v", i, err)
		}
	}
	if n := b.started.Load(); n != 1 {
		t.Fatalf("%d checks ran, want 1", n)
	}
}

// A request for another selection cancels the running check (its waiter
// gets errSuperseded) and starts once that one has stopped: never two at once.
func TestRunCheckOtherSelectionCancels(t *testing.T) {
	s := &Server{}
	b := newBlockingRun()
	first := make(chan error, 1)
	go func() { _, err := s.runCheck(context.Background(), "from=1", b.run); first <- err }()
	waitFor(t, "the first check", func() bool { return b.started.Load() == 1 })
	second := make(chan error, 1)
	go func() { _, err := s.runCheck(context.Background(), "from=2", b.run); second <- err }()
	if err := <-first; !errors.Is(err, errSuperseded) {
		t.Fatalf("first: %v, want errSuperseded", err)
	}
	waitFor(t, "the second check", func() bool { return b.started.Load() == 2 })
	close(b.release)
	if err := <-second; err != nil {
		t.Fatalf("second: %v", err)
	}
	if m := b.maxInFlight.Load(); m != 1 {
		t.Fatalf("%d checks at once, want 1", m)
	}
}

// A check nobody waits for any more (the client aborted) is cancelled; the
// next request for that selection runs it again.
func TestRunCheckAbandonedIsCancelled(t *testing.T) {
	s := &Server{}
	b := newBlockingRun()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := s.runCheck(ctx, "from=1", b.run); done <- err }()
	waitFor(t, "the check", func() bool { return b.started.Load() == 1 })
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("abandoned: %v", err)
	}
	waitFor(t, "the check to stop", func() bool { return b.inFlight.Load() == 0 })
	close(b.release)
	if ck, err := s.runCheck(context.Background(), "from=1", b.run); err != nil || !ck.OK || b.started.Load() != 2 {
		t.Fatalf("again: %+v %v, %d runs", ck, err, b.started.Load())
	}
}

// /api/cut/check refuses a new file over MaxCheckBytes unless force=1.
func TestCutCheckLimit(t *testing.T) {
	path := "../../testdata/traces/19c/io_waits.trc"
	m, err := model.Build(path, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	li, err := trace.OpenLineIndex(path)
	if err != nil {
		t.Fatal(err)
	}
	defer li.Close()
	s := New(m).WithLines([]*trace.LineIndex{li})
	s.CutDir = t.TempDir()
	s.MaxCheckBytes = 64 << 10
	h := s.Handler()
	get := func(url string) (int, string) {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, url, nil))
		return rr.Code, rr.Body.String()
	}
	if code, body := get("/api/cut/check"); code != http.StatusBadRequest || !strings.Contains(body, "force=1") {
		t.Fatalf("over the limit: %d %s", code, body)
	}
	if code, body := get("/api/cut/check?force=2"); code != http.StatusBadRequest {
		t.Fatalf("force=2: %d %s", code, body)
	}
	code, body := get("/api/cut/check?force=1")
	var ck cut.Check
	if code != http.StatusOK || json.Unmarshal([]byte(body), &ck) != nil || !ck.OK {
		t.Fatalf("force=1: %d %s", code, body)
	}
	s.MaxCheckBytes = 0 // the default, 1 GiB
	if code, body := get("/api/cut/check?from=1"); code != http.StatusOK {
		t.Fatalf("under the default limit: %d %s", code, body)
	}
}
