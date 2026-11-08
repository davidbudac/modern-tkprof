package cut_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/cut"
)

// The check parses the cut back with an aggregation-only build (F13): its
// numbers equal those of the full build it replaced, on every cut of every
// fixture and set.
func TestCheckAggregateEqualsFull(t *testing.T) {
	type set struct {
		name  string
		paths []string
	}
	var sets []set
	for _, p := range fixtures(t) {
		sets = append(sets, set{filepath.Base(filepath.Dir(p)) + "/" + filepath.Base(p), []string{p}})
	}
	d := filepath.Join("..", "..", "testdata", "traces", "19c")
	sets = append(sets, set{"multisession", []string{filepath.Join(d, "multisession_a.trc"), filepath.Join(d, "multisession_b.trc")}},
		set{"parallel", []string{filepath.Join(d, "parallel.trc"), filepath.Join(d, "parallel_slave.trc")}})
	if ms, _ := filepath.Glob(filepath.Join("..", "..", "testdata", "sets", "workload", "*.trc")); len(ms) > 0 {
		sets = append(sets, set{"workload", ms})
	}
	dir := t.TempDir()
	n := 0
	for _, st := range sets {
		m, c := open(t, st.paths...)
		for sname, sel := range selections(m) {
			agg, err := c.Check(context.Background(), sel, dir)
			if err != nil {
				t.Errorf("%s %s: %v", st.name, sname, err)
				continue
			}
			full, err := c.CheckFull(context.Background(), sel, dir)
			if err != nil {
				t.Errorf("%s %s full: %v", st.name, sname, err)
				continue
			}
			if !reflect.DeepEqual(agg, full) {
				t.Errorf("%s %s: aggregate check %+v\n  full check %+v", st.name, sname, *agg, *full)
			}
			n++
		}
	}
	t.Logf("%d cuts compared", n)
}

// A check cancelled while it parses the cut back stops (the parse reads at
// most one more buffer) and leaves no temporary file.
func TestCheckCancelledMidParse(t *testing.T) {
	_, c := open(t, filepath.Join("..", "..", "testdata", "traces", "19c", "io_waits.trc"))
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	calls, at := 0, 0
	cut.SetCheckHook(func() {
		calls++
		if calls == 10 {
			at = calls
			cancel()
		}
	})
	t.Cleanup(func() { cut.SetCheckHook(nil) })
	ck, err := c.Check(ctx, cut.Selection{}, dir)
	if !errors.Is(err, context.Canceled) || ck != nil {
		t.Fatalf("cancelled check: %+v, %v; want context.Canceled", ck, err)
	}
	if at != 10 {
		t.Fatalf("the parse never reached the 10th call (%d calls)", calls)
	}
	if left, _ := os.ReadDir(dir); len(left) != 0 {
		t.Fatalf("temporary files left: %v", left)
	}
	// the uncancelled check of the same cut sees every call: the cancelled one did not run to the end of a big file
	cut.SetCheckHook(nil)
	full, err := c.Check(context.Background(), cut.Selection{}, dir)
	if err != nil || !full.OK {
		t.Fatalf("check: %+v %v", full, err)
	}
	if int64(calls) >= full.Calls {
		t.Fatalf("the cancelled parse delivered %d calls, all of the %d: it did not stop", calls, full.Calls)
	}
	t.Logf("cancelled after call 10, the parse had delivered %d of %d calls (the cut is %d bytes, one read buffer is 1 MiB)", calls, full.Calls, full.Bytes)
}

// A cut bigger than the limit is not checked: the write stops at the limit,
// the temporary file goes.
func TestCheckMax(t *testing.T) {
	_, c := open(t, filepath.Join("..", "..", "testdata", "traces", "19c", "io_waits.trc"))
	dir := t.TempDir()
	_, err := c.CheckMax(context.Background(), cut.Selection{}, dir, 64<<10)
	var tb *cut.TooBigError
	if !errors.As(err, &tb) || tb.Max != 64<<10 {
		t.Fatalf("over the limit: %v", err)
	}
	if left, _ := os.ReadDir(dir); len(left) != 0 {
		t.Fatalf("temporary files left: %v", left)
	}
	if ck, err := c.CheckMax(context.Background(), cut.Selection{}, dir, 1<<30); err != nil || !ck.OK {
		t.Fatalf("under the limit: %+v %v", ck, err)
	}
}
