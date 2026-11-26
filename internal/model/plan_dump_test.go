package model

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// In every fixture a plan is one STAT dump: it starts at id=1 (or is a dump
// the file starts or breaks off in), no id twice, and each line is the STAT
// line of its cursor and id at the trace line the plan line names.
func TestPlansAreWholeDumps(t *testing.T) {
	paths, err := filepath.Glob("../../testdata/traces/*/*.trc")
	if err != nil || len(paths) == 0 {
		t.Fatal("no fixtures", err)
	}
	split := 0 // dumps with other lines between their STAT lines
	for _, path := range paths {
		m, err := Build(path, Options{})
		if err != nil {
			t.Fatal(err)
		}
		name := filepath.Base(filepath.Dir(path)) + "/" + filepath.Base(path)
		f, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		var text []string
		sc := bufio.NewScanner(f)
		sc.Buffer(nil, 1<<24)
		for sc.Scan() {
			text = append(text, sc.Text())
		}
		f.Close()
		planned := 0
		for _, p := range m.Plans {
			lines := m.PlanLines[p.First : p.First+p.N]
			planned += len(lines)
			if lines[0].ID != 1 {
				t.Errorf("%s line %d: a plan starts at id=%d", name, p.Line, lines[0].ID)
			}
			seen := map[int]bool{}
			gap := false
			for i, l := range lines {
				want := "STAT #" + strconv.FormatUint(m.Cursors[p.Cursor].Number, 10) + " id=" + strconv.Itoa(l.ID) + " "
				if l.Line < 1 || l.Line > len(text) || !strings.HasPrefix(text[l.Line-1], want) {
					t.Fatalf("%s plan at line %d: line %d is not %q", name, p.Line, l.Line, want)
				}
				if seen[l.ID] || (i == 0 && l.Line != p.Line) {
					t.Errorf("%s plan at line %d: id %d twice, or the plan does not start at its first line", name, p.Line, l.ID)
				}
				seen[l.ID] = true
				gap = gap || (i > 0 && l.Line != lines[i-1].Line+1)
			}
			if gap {
				split++
			}
		}
		// (nasty_sql has lines that look like STAT inside a statement: the parser's count)
		if stats := m.Diag.LineKinds[trace.KindStat.String()]; planned != stats {
			t.Errorf("%s: %d STAT lines, %d in plans", name, stats, planned)
		}
	}
	if split == 0 {
		t.Fatal("no fixture has a dump with other lines between its STAT lines")
	}
}
