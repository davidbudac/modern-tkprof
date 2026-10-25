package model_test

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"regexp"
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
				m := b.Snapshot(p.Stats(), p.Pending, nil)
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
