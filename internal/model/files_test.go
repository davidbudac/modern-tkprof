package model

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

const fixtures = "../../testdata/traces/19c/"

func buildFiles(t *testing.T, opts Options, names ...string) *Model {
	t.Helper()
	var paths []string
	for _, n := range names {
		paths = append(paths, fixtures+n)
	}
	m, err := BuildFiles(paths, opts)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

type totals struct{ Calls, C, E, P, CR, CU, R int64 }

func sumCalls(m *Model) totals { return totals{Calls: int64(len(m.Calls))} }

// A single file with no chain behaves exactly like the plain parse.
func TestBuildFilesSingleIsIdentical(t *testing.T) {
	for _, n := range []string{"basic_binds.trc", "plsql_recursive.trc", "parallel_slave.trc", "midtrace_start.trc"} {
		a, err := Build(fixtures+n, Options{})
		if err != nil {
			t.Fatal(err)
		}
		b, err := BuildFiles([]string{fixtures + n}, Options{NoFollow: true})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(a, b) {
			t.Errorf("%s: BuildFiles(NoFollow) differs from Build", n)
		}
	}
	// following finds nothing to follow in a file without chain markers
	a, _ := Build(fixtures+"basic_binds.trc", Options{})
	b, _ := BuildFiles([]string{fixtures + "basic_binds.trc"}, Options{})
	if !reflect.DeepEqual(a, b) {
		t.Errorf("basic_binds: BuildFiles differs from Build")
	}
}

func TestChainFollowedFromEitherEnd(t *testing.T) {
	for _, in := range []string{"midtrace_start_part1.trc", "midtrace_start.trc"} {
		m := buildFiles(t, Options{}, in)
		if len(m.File.Files) != 2 {
			t.Fatalf("%s: %d files, want 2", in, len(m.File.Files))
		}
		f0, f1 := m.File.Files[0], m.File.Files[1]
		if f0.Name != "midtrace_start_part1.trc" || f1.Name != "midtrace_start.trc" {
			t.Errorf("%s: order %s, %s", in, f0.Name, f1.Name)
		}
		if f0.Chain != f1.Chain || f0.Followed == f1.Followed {
			t.Errorf("%s: chain/followed: %+v %+v", in, f0, f1)
		}
	}
	// both named, in the wrong order, and a directory: still one chain in order
	m := buildFiles(t, Options{}, "midtrace_start.trc", "midtrace_start_part1.trc")
	if len(m.File.Files) != 2 || m.File.Files[0].Name != "midtrace_start_part1.trc" || m.File.Files[0].Followed || m.File.Files[1].Followed {
		t.Errorf("explicit pair: %+v", m.File.Files)
	}
	// -no-follow keeps just the named file
	m = buildFiles(t, Options{NoFollow: true}, "midtrace_start_part1.trc")
	if len(m.File.Files) != 1 {
		t.Errorf("no-follow: %d files", len(m.File.Files))
	}
}

// Calls after the split keep attributing to cursors opened before it.
func TestChainKeepsCursorsAcrossSplit(t *testing.T) {
	chain := buildFiles(t, Options{}, "midtrace_start_part1.trc")
	p1 := buildFiles(t, Options{NoFollow: true}, "midtrace_start_part1.trc")
	p2 := buildFiles(t, Options{NoFollow: true}, "midtrace_start.trc")

	if p2.Diag.AssumedCursors == 0 {
		t.Fatalf("fixture changed: part 2 alone should have assumed cursors")
	}
	if chain.Diag.AssumedCursors != 0 {
		t.Errorf("chain has %d assumed cursors, want 0", chain.Diag.AssumedCursors)
	}
	for i := range chain.Cursors {
		c := &chain.Cursors[i]
		if c.Assumed {
			t.Errorf("cursor %d (#%d) is assumed", c.ID, c.Number)
		}
		// only cursors open before tracing started (used in part 1, never parsed) stay implicit
		if c.Implicit && chain.Contexts[c.Context].FileIdx != 0 {
			t.Errorf("cursor %d (#%d) is implicit but first used after the split", c.ID, c.Number)
		}
	}
	if chain.Diag.OrphanCalls != 0 {
		t.Errorf("%d orphan calls across the split (part 1 alone: %d)", chain.Diag.OrphanCalls, p1.Diag.OrphanCalls)
	}
	if want := sumCalls(p1).Calls + sumCalls(p2).Calls; sumCalls(chain).Calls != want {
		t.Errorf("calls %d, want %d", sumCalls(chain).Calls, want)
	}
	// inclusive numbers do not depend on how the file was split
	incl := func(m *Model) (e, cpu, rows int64) {
		for i := range m.Calls {
			e += m.Calls[i].E
			cpu += m.Calls[i].C
			rows += m.Calls[i].R
		}
		return
	}
	e1, c1, r1 := incl(p1)
	e2, c2, r2 := incl(p2)
	e, cc, r := incl(chain)
	if e != e1+e2 || cc != c1+c2 || r != r1+r2 {
		t.Errorf("inclusive totals chain %d/%d/%d, parts %d/%d/%d", e, cc, r, e1+e2, c1+c2, r1+r2)
	}
	// one Context per file at least, each knowing its file
	seen := map[int]bool{}
	for _, c := range chain.Contexts {
		seen[c.FileIdx] = true
	}
	if !seen[0] || !seen[1] {
		t.Errorf("contexts do not cover both files: %v", seen)
	}
	// diagnostics are summed
	if chain.Diag.Lines != p1.Diag.Lines+p2.Diag.Lines || chain.Diag.Bytes != p1.Diag.Bytes+p2.Diag.Bytes {
		t.Errorf("lines/bytes %d/%d, want %d/%d", chain.Diag.Lines, chain.Diag.Bytes, p1.Diag.Lines+p2.Diag.Lines, p1.Diag.Bytes+p2.Diag.Bytes)
	}
}

func TestDirectoryInput(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"b.trc", "a.trc", "c.txt"} {
		src := "multisession_a.trc"
		if n == "b.trc" {
			src = "multisession_b.trc"
		}
		data, err := os.ReadFile(fixtures + src)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, n), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	files, err := ExpandInputs([]string{dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || filepath.Base(files[0]) != "a.trc" || filepath.Base(files[1]) != "b.trc" {
		t.Fatalf("expanded: %v", files)
	}
	m, err := BuildFiles([]string{dir}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.File.Files) != 2 || m.File.Files[0].Name != "a.trc" || m.File.Files[1].Chain == m.File.Files[0].Chain {
		t.Errorf("files: %+v", m.File.Files)
	}
	// the same file named twice (directly and through the directory) is read once
	m, err = BuildFiles([]string{filepath.Join(dir, "a.trc"), dir}, Options{})
	if err != nil || len(m.File.Files) != 2 {
		t.Errorf("dedupe: %v, %d files", err, len(m.File.Files))
	}
	if _, err := ExpandInputs([]string{t.TempDir()}); err == nil {
		t.Errorf("empty directory should be an error")
	}
}

// trcsess merged multisession_a and multisession_b into multisession.trc:
// building the two files gives the same statement totals.
func TestMultisessionEquivalence(t *testing.T) {
	two := buildFiles(t, Options{}, "multisession_a.trc", "multisession_b.trc")
	one := buildFiles(t, Options{}, "multisession.trc")
	if len(two.File.Files) != 2 || two.File.Files[0].Chain == two.File.Files[1].Chain {
		t.Fatalf("files: %+v", two.File.Files)
	}
	type key struct {
		kind        StatementKind
		sqlid, text string
	}
	agg := func(m *Model) map[key]totals {
		out := map[key]totals{}
		for i := range m.Calls {
			c := &m.Calls[i]
			st := &m.Statements[c.Statement]
			k := key{st.Kind, st.SQLID, st.Text}
			t := out[k]
			t.Calls++
			t.C += c.C
			t.E += c.E
			t.P += c.P
			t.CR += c.CR
			t.CU += c.CU
			t.R += c.R
			out[k] = t
		}
		return out
	}
	a, b := agg(two), agg(one)
	if len(a) != len(b) {
		t.Errorf("statements with calls: %d vs %d", len(a), len(b))
	}
	for k, v := range b {
		if a[k] != v {
			t.Errorf("%s %s: two files %+v, merged %+v", k.kind, k.sqlid, a[k], v)
		}
	}
	if len(two.Waits) != len(one.Waits) || len(two.Binds) != len(one.Binds) || len(two.PlanLines) != len(one.PlanLines) {
		t.Errorf("waits/binds/planlines %d/%d/%d vs %d/%d/%d", len(two.Waits), len(two.Binds), len(two.PlanLines), len(one.Waits), len(one.Binds), len(one.PlanLines))
	}
	// each file's process and session became a context
	sessions := map[string]string{}
	for _, c := range two.Contexts {
		sessions[c.Process] = c.SessionID
		if c.Process == "" || c.SessionID == "" {
			t.Errorf("context without process/session: %+v", c)
		}
	}
	if len(sessions) != 2 {
		t.Errorf("sessions by process: %v", sessions)
	}
	procs := map[string]bool{}
	for _, c := range one.Contexts {
		procs[c.Process] = true
	}
	for p := range sessions {
		if !procs[p] {
			t.Errorf("process %s not in trcsess output", p)
		}
	}
	// same wall-clock span
	if two.Span.FirstTim != one.Span.FirstTim || two.Span.LastTim != one.Span.LastTim || two.Span.FirstWallUs != one.Span.FirstWallUs {
		t.Errorf("span %+v vs %+v", two.Span, one.Span)
	}
	// diagnostics: lines and bytes of both files
	if two.Diag.Lines != 263+230 {
		t.Errorf("lines %d", two.Diag.Lines)
	}
	var ln []int
	for _, f := range two.File.Files {
		ln = append(ln, f.Lines)
	}
	sort.Ints(ln)
	if !reflect.DeepEqual(ln, []int{230, 263}) {
		t.Errorf("per-file lines %v", ln)
	}
}

func TestPXSlaveAttachesToCoordinator(t *testing.T) {
	m := buildFiles(t, Options{}, "parallel.trc", "parallel_slave.trc")
	if !m.File.Files[1].PX || m.File.Files[0].PX {
		t.Fatalf("PX detection: %+v", m.File.Files)
	}
	var slaves, matched int
	for i := range m.Contexts {
		c := &m.Contexts[i]
		if !c.PX {
			if c.Parent != None {
				t.Errorf("coordinator context %d has a parent", i)
			}
			continue
		}
		slaves++
		if c.Parent == None {
			t.Errorf("slave context %d (action %s) not attached", i, c.Action)
			continue
		}
		matched++
		q := &m.Contexts[c.Parent]
		if q.PX || q.FileIdx != 0 || q.ClientID != c.ClientID || q.Module != c.Module || q.Action != c.Action {
			t.Errorf("slave %d attached to %d: %+v vs %+v", i, c.Parent, c, q)
		}
		if !m.PXChild(ID(i)) {
			t.Errorf("PXChild(%d) false", i)
		}
	}
	if slaves != 2 || matched != 2 {
		t.Errorf("slave contexts %d, matched %d", slaves, matched)
	}
	// the slave file alone: flagged as PX but nothing to attach to
	alone := buildFiles(t, Options{}, "parallel_slave.trc")
	for _, c := range alone.Contexts {
		if !c.PX || c.Parent != None {
			t.Errorf("slave alone: %+v", c)
		}
	}
	// a coordinator and an unrelated slave (different client id) do not attach
	other := buildFiles(t, Options{}, "basic_binds.trc", "parallel_slave.trc")
	for _, c := range other.Contexts {
		if c.PX && c.Parent != None {
			t.Errorf("slave attached to an unrelated session: %+v", c)
		}
	}
}
