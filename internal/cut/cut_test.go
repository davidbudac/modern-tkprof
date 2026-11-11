package cut_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/cut"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

func fixtures(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, v := range []string{"19c", "21c", "23ai"} {
		ms, _ := filepath.Glob(filepath.Join("..", "..", "testdata", "traces", v, "*.trc"))
		out = append(out, ms...)
	}
	if len(out) == 0 {
		t.Fatal("no fixtures")
	}
	return out
}

// openOne opens one file without following its TRACE CONTINUES chain.
func openOne(t *testing.T, path string) (*model.Model, *cut.Cutter) {
	t.Helper()
	return openWith(t, model.Options{NoFollow: true}, path)
}

func open(t *testing.T, paths ...string) (*model.Model, *cut.Cutter) {
	t.Helper()
	return openWith(t, model.Options{}, paths...)
}

func openWith(t *testing.T, o model.Options, paths ...string) (*model.Model, *cut.Cutter) {
	t.Helper()
	m, err := model.BuildFiles(paths, o)
	if err != nil {
		t.Fatal(err)
	}
	var lis []*trace.LineIndex
	for _, f := range m.File.Files {
		li, err := trace.OpenLineIndex(f.Path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { li.Close() })
		lis = append(lis, li)
	}
	return m, cut.New(m, slice.MemSource(m), lis)
}

// selections are the cuts every fixture is checked with.
func selections(m *model.Model) map[string]cut.Selection {
	out := map[string]cut.Selection{
		"whole":        {},
		"whole-mask":   {Binds: cut.BindsMask},
		"whole-nobind": {Binds: cut.BindsNone, NoPlans: true, NoProvenance: true},
	}
	for i := range m.Contexts {
		if i >= 6 {
			break
		}
		out["ctx-"+itoa(i)] = cut.Selection{Contexts: []model.ID{model.ID(i)}}
	}
	if a, b := m.Span.FirstTim, m.Span.LastTim; b > a {
		q := (b - a) / 4
		for i := int64(0); i < 4; i++ {
			out["quarter-"+itoa(int(i))] = cut.Selection{From: a + i*q, To: a + (i+1)*q}
		}
		out["middle-exec"] = cut.Selection{From: a + q, To: a + 3*q, Executions: true}
	}
	// the statements with the most calls
	type sc struct {
		id model.ID
		n  int
	}
	var ss []sc
	n := map[model.ID]int{}
	for i := range m.Calls {
		n[m.Calls[i].Statement]++
	}
	for id, c := range n {
		ss = append(ss, sc{id, c})
	}
	sort.Slice(ss, func(i, j int) bool { return ss[i].n > ss[j].n || ss[i].n == ss[j].n && ss[i].id < ss[j].id })
	for i := 0; i < len(ss) && i < 4; i++ {
		id := ss[i].id
		out["stmt-"+itoa(int(id))] = cut.Selection{Statement: &id}
	}
	return out
}

func itoa(i int) string { return strconv.Itoa(i) }

func checkAll(t *testing.T, name string, m *model.Model, c *cut.Cutter) {
	dir := t.TempDir()
	for sname, sel := range selections(m) {
		ck, err := c.Check(context.Background(), sel, dir)
		if err != nil {
			t.Errorf("%s %s: %v", name, sname, err)
			continue
		}
		if !ck.OK {
			t.Errorf("%s %s: check failed: calls %d/%d waits %d/%d (%d/%d µs) wall %v newUnknown %d\n  %s",
				name, sname, ck.Calls, ck.CallsWant, ck.Waits, ck.WaitsWant, ck.WaitUs, ck.WaitUsWant, ck.WallOK, ck.NewUnknown, strings.Join(ck.Mismatches, "\n  "))
		}
		if ck.UnknownLines > m.Diag.UnknownLines {
			t.Errorf("%s %s: %d unknown lines in the cut, %d in the source", name, sname, ck.UnknownLines, m.Diag.UnknownLines)
		}
	}
}

func TestCutFixtures(t *testing.T) {
	for _, path := range fixtures(t) {
		m, c := open(t, path)
		checkAll(t, filepath.Base(filepath.Dir(path))+"/"+filepath.Base(path), m, c)
	}
}

func TestCutSets(t *testing.T) {
	d := filepath.Join("..", "..", "testdata", "traces", "19c")
	sets := map[string][]string{
		"multisession": {filepath.Join(d, "multisession_a.trc"), filepath.Join(d, "multisession_b.trc")},
		"parallel":     {filepath.Join(d, "parallel.trc"), filepath.Join(d, "parallel_slave.trc")},
	}
	if ms, _ := filepath.Glob(filepath.Join("..", "..", "testdata", "sets", "workload", "*.trc")); len(ms) > 0 {
		sets["workload"] = ms
	}
	for name, paths := range sets {
		m, c := open(t, paths...)
		checkAll(t, name, m, c)
	}
}

// A cut of everything is the source with the provenance lines in its header.
func TestCutWholeIsSource(t *testing.T) {
	for _, path := range fixtures(t) {
		m, c := openOne(t, path)
		var buf bytes.Buffer
		if _, err := c.Write(context.Background(), cut.Selection{}, &buf); err != nil {
			t.Fatal(err)
		}
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, l := range strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n") {
			if !strings.HasPrefix(l, "mtkprof cut: ") {
				got = append(got, l)
			}
		}
		// a \r before the \n is the line's own unless the file's lines end in \r\n (its first line does)
		text := string(src)
		if first, _, _ := strings.Cut(text, "\n"); strings.HasSuffix(first, "\r") {
			text = strings.ReplaceAll(text, "\r\n", "\n")
		}
		want := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
		if len(got) != len(want) {
			t.Errorf("%s: %d lines, source %d", path, len(got), len(want))
		}
		for i := 0; i < len(got) && i < len(want); i++ {
			if got[i] != want[i] {
				t.Errorf("%s line %d:\n got  %q\n want %q", path, i+1, got[i], want[i])
				break
			}
		}
		_ = m
	}
}

// The window cut of io_waits.trc the mock-up was drawn from: the hash join's
// recursive cursors parsed 10,000 lines earlier are restated, its plan comes
// from after the cut, and the brush end widens to keep the FETCH whole.
func TestCutWindowIOWaits(t *testing.T) {
	m, c := open(t, filepath.Join("..", "..", "testdata", "traces", "19c", "io_waits.trc"))
	from, to := tim(m, 1792668934880000), tim(m, 1792668935300000)
	p, err := c.Plan(context.Background(), cut.Selection{From: from, To: to})
	if err != nil {
		t.Fatal(err)
	}
	var titles []string
	for _, pc := range p.Pieces {
		if pc.Kind != "kept" {
			titles = append(titles, pc.Kind+" "+pc.Title)
		}
	}
	got := strings.Join(titles, "; ")
	for _, want := range []string{"before Cursor 52nzchs09dgn1", "before Cursor 10gywwmwk6xfy", "before Cursor dbvj6jc977hqh",
		"after Plan of 7r10y07tqpg98", "before Session markers", "generated Timestamp", "generated Provenance"} {
		if !strings.Contains(got, want) {
			t.Errorf("no %q in %s", want, got)
		}
	}
	if p.KeptTo <= to {
		t.Errorf("kept to %d, the brush ends at %d: the hash join's FETCH should widen it", p.KeptTo, to)
	}
	ck, err := c.Check(context.Background(), cut.Selection{From: from, To: to}, t.TempDir())
	if err != nil || !ck.OK {
		t.Fatalf("check: %+v %v", ck, err)
	}
}

// tim of a wall clock (µs since the epoch) in m.
func tim(m *model.Model, wall int64) int64 { return m.Span.FirstTim + wall - m.Span.FirstWallUs }
