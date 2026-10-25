package model_test

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// cutReader hands data to the parser in pieces that end at the cuts and
// calls at(cut) when the parser asks for more after a cut: every line
// before it has been delivered then.
type cutReader struct {
	data []byte
	off  int
	cuts []int
	at   func(int)
}

func (r *cutReader) Read(p []byte) (int, error) {
	for len(r.cuts) > 0 && r.cuts[0] <= r.off {
		r.at(r.cuts[0])
		r.cuts = r.cuts[1:]
	}
	if r.off == len(r.data) {
		return 0, io.EOF
	}
	end := len(r.data)
	if len(r.cuts) > 0 {
		end = r.cuts[0]
	}
	n := copy(p, r.data[r.off:end])
	r.off += n
	return n, nil
}

var generatedRe = regexp.MustCompile(`"generated":"[^"]*"`)

func aggOptions() model.Options {
	th := analyze.DefaultThresholds()
	return model.Options{NoFacts: true, Aggregate: true,
		NewSink: func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, th) }}
}

func docOf(t *testing.T, m *model.Model) []byte {
	t.Helper()
	d, err := report.DocumentBytes(m, report.DocOptions{Packed: true})
	if err != nil {
		t.Fatal(err)
	}
	return generatedRe.ReplaceAll(d, nil)
}

// TestSnapshotEqualsPrefixBuild: a snapshot taken between any two lines is
// the model of a build of the lines so far (compared as documents), and
// snapshots do not change the build that goes on.
func TestSnapshotEqualsPrefixBuild(t *testing.T) {
	for _, name := range []string{"errors", "bind_types", "nasty_sql", "lobs", "plsql_recursive", "parallel", "cursor_cache", "basic_binds"} {
		t.Run(name, func(t *testing.T) {
			src := "../../testdata/traces/19c/" + name + ".trc"
			data, err := os.ReadFile(src)
			if err != nil {
				t.Fatal(err)
			}
			var ends []int
			for i, c := range data {
				if c == '\n' {
					ends = append(ends, i+1)
				}
			}
			stride := max(1, len(ends)/150)
			var cuts []int
			for i := 0; i < len(ends); i += stride {
				cuts = append(cuts, ends[i])
			}
			dir := t.TempDir()
			b := model.NewLiveBuilder(src, aggOptions())
			p := trace.New(b)
			n := 0
			r := &cutReader{data: data, cuts: cuts, at: func(off int) {
				m := b.Snapshot(p.Stats(), p.Stats(), p.Pending, nil)
				pre := filepath.Join(dir, name+".trc")
				os.WriteFile(pre, data[:off], 0o644)
				want, err := model.BuildFiles([]string{pre}, aggOptions())
				if err != nil {
					t.Fatal(err)
				}
				m.File.Path, m.File.Files[0].Path = pre, pre
				if a, b := docOf(t, want), docOf(t, m); !bytes.Equal(a, b) {
					t.Fatalf("snapshot at byte %d differs from the build of the prefix (%d vs %d bytes)", off, len(b), len(a))
				}
				n++
			}}
			st, err := p.Run(r)
			if err != nil {
				t.Fatal(err)
			}
			b.EndFile(st)
			got := b.Finish(st)
			want, err := model.BuildFiles([]string{src}, aggOptions())
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(docOf(t, want), docOf(t, got)) {
				t.Errorf("the build after %d snapshots differs from a plain build", n)
			}
			t.Logf("%d snapshots equal", n)
		})
	}
}

// TestSnapshotOfChain: a live build that moves on to the next file of a
// TRACE CONTINUES IN chain (ContinueLive) snapshots, at cuts in both files,
// the model BuildFiles makes of the first file and the prefix of the next
// one (found by its header name, as a chain is followed), and ends equal to
// the build of the whole chain. Backwards (the second file is the one
// followed, the first one is complete and read first, MarkFollowed): the
// snapshots in the second file, from its TRACE CONTINUED FROM marker on,
// equal BuildFiles of the second file, which pulls in the first.
func TestSnapshotOfChain(t *testing.T) {
	part1, err := os.ReadFile("../../testdata/traces/19c/midtrace_start_part1.trc")
	if err != nil {
		t.Fatal(err)
	}
	part2, err := os.ReadFile("../../testdata/traces/19c/midtrace_start.trc")
	if err != nil {
		t.Fatal(err)
	}
	for _, backward := range []bool{false, true} {
		dir := t.TempDir()
		p1, p2 := filepath.Join(dir, "part1.trc"), filepath.Join(dir, "part2.trc")
		named := p1
		if backward {
			named = p2
			os.WriteFile(p1, part1, 0o644)
		}
		b := model.NewLiveBuilder(p1, aggOptions())
		if backward {
			b.MarkFollowed()
		}
		var done trace.Stats
		n := 0
		cutsOf := func(data []byte, from int) []int {
			var cuts []int
			for i := from; i < len(data); i++ {
				if data[i] == '\n' && (len(cuts) == 0 || i+1-cuts[len(cuts)-1] > len(data)/12) {
					cuts = append(cuts, i+1)
				}
			}
			return cuts
		}
		parse := func(data []byte, file string, from int, written func(int)) trace.Stats {
			p := trace.New(b)
			var cuts []int
			if from >= 0 { // else no snapshots
				cuts = cutsOf(data, from)
			}
			r := &cutReader{data: data, cuts: cuts, at: func(off int) {
				written(off)
				st := p.Stats()
				total := done
				total.Add(st)
				m := b.Snapshot(st, total, p.Pending, nil)
				want, err := model.BuildFiles([]string{named}, aggOptions())
				if err != nil {
					t.Fatal(err)
				}
				if a, b := docOf(t, want), docOf(t, m); !bytes.Equal(a, b) {
					t.Fatalf("backward %v, %s: snapshot at byte %d differs from the build of the chain so far (%d vs %d bytes)\n%s\n%s", backward, file, off, len(b), len(a), a, b)
				}
				n++
			}}
			st, err := p.Run(r)
			if err != nil {
				t.Fatal(err)
			}
			return st
		}
		first := bytes.IndexByte(part1, '\n') + 1 // the header line names the file
		if backward {
			first = -1
		}
		st := parse(part1, "part 1", first, func(off int) { os.WriteFile(p1, part1[:off], 0o644) })
		os.WriteFile(p1, part1, 0o644)
		if got := b.ContinuesIn(); !strings.HasSuffix(got, "_mtk_midtrace_start.trc") {
			t.Fatalf("ContinuesIn %q", got)
		}
		b.EndFile(st)
		done.Add(st)
		b.ContinueLive(p2, !backward)
		first = bytes.IndexByte(part2, '\n') + 1
		if backward { // the live build reads the earlier file once the marker is there
			const key = "TRACE CONTINUED FROM FILE "
			i := bytes.Index(part2, []byte(key))
			first = i + bytes.IndexByte(part2[i:], '\n') + 1
			if !model.HeadSettled(part2[:first]) || model.HeadSettled(part2[:i]) {
				t.Errorf("HeadSettled: not at the marker")
			}
		}
		st = parse(part2, "part 2", first, func(off int) { os.WriteFile(p2, part2[:off], 0o644) })
		b.EndFile(st)
		done.Add(st)
		os.WriteFile(p2, part2, 0o644)
		got := b.Snapshot(st, done, nil, nil)
		want, err := model.BuildFiles([]string{named}, aggOptions())
		if err != nil {
			t.Fatal(err)
		}
		if len(want.File.Files) != 2 {
			t.Fatalf("BuildFiles did not follow the chain: %d files", len(want.File.Files))
		}
		if !bytes.Equal(docOf(t, want), docOf(t, got)) {
			t.Errorf("backward %v: the live build of the chain differs from BuildFiles", backward)
		}
		t.Logf("backward %v: %d snapshots equal", backward, n)
	}
}
