package slice

import (
	"context"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// pinx_worker_w01 commits some 1,200 times inside nested PL/SQL (a COMMIT at
// dep=2 under a procedure at dep=1). An XCTEND line prints no depth.
const nestedCommits = "../../testdata/traces/19c/pinx_worker_w01.trc"

func TestCommitInNestedPLSQL(t *testing.T) {
	m, err := model.Build(nestedCommits, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	var commits, nested int
	children := make(map[model.ID]int64) // parent -> Σ e of its children
	var self, top int64
	for i := range m.Calls {
		c := &m.Calls[i]
		if !c.Synthetic {
			self += c.SelfE
		}
		if c.Parent == model.None {
			if !c.Synthetic {
				top += c.E
			}
			continue
		}
		p := &m.Calls[c.Parent]
		if p.Kind == trace.CallXctend {
			t.Fatalf("line %d: parent of the call is the XCTEND of line %d", c.Line, p.Line)
		}
		if c.Dep <= p.Dep {
			t.Fatalf("line %d: dep %d under a parent of dep %d (line %d)", c.Line, c.Dep, p.Dep, p.Line)
		}
		children[c.Parent] += c.E
		if c.Kind == trace.CallXctend {
			commits++
			// the commit happened while its parent ran
			if c.Tim < p.Tim-p.E || c.Tim > p.Tim {
				t.Errorf("line %d: XCTEND outside the time of its parent (line %d)", c.Line, p.Line)
			}
			if c.Dep > 1 {
				nested++
			}
		}
	}
	if commits < 1000 || nested < 1000 {
		t.Fatalf("commits with a parent: %d, nested: %d", commits, nested)
	}
	// every recursive call's time is taken off exactly one self time
	for id, sum := range children {
		if p := &m.Calls[id]; p.SelfE != max(p.E-sum, 0) {
			t.Errorf("line %d: self %d, want e %d - children %d", p.Line, p.SelfE, p.E, sum)
		}
	}
	// ... so the self times add up to the top-level elapsed time (the clock's
	// microsecond rounding leaves a little over)
	if over := self - top; over < -top/100 || over > top/100 {
		t.Errorf("Σ self %d µs, Σ top-level e %d µs: %d counted twice", self, top, over)
	}
}

// In every fixture: no call is the child of an XCTEND, and the execution trace
// of a recursive call holds everything under it. The trace walks back from the
// call and stops at the first row of its depth or less, so an XCTEND must be
// deeper than the calls it sits among.
func TestCommitsDoNotCutTheHierarchy(t *testing.T) {
	paths, err := filepath.Glob("../../testdata/traces/*/*.trc")
	if err != nil || len(paths) == 0 {
		t.Fatal("no fixtures", err)
	}
	checked := 0
	for _, path := range paths {
		m, err := model.Build(path, model.Options{})
		if err != nil {
			t.Fatal(err)
		}
		name := filepath.Base(filepath.Dir(path)) + "/" + filepath.Base(path)
		kids := make(map[model.ID][]model.ID)
		for i := range m.Calls {
			p := m.Calls[i].Parent
			if p == model.None {
				continue
			}
			if m.Calls[p].Kind == trace.CallXctend {
				t.Fatalf("%s line %d: parent is the XCTEND of line %d", name, m.Calls[i].Line, m.Calls[p].Line)
			}
			kids[p] = append(kids[p], m.Calls[i].ID)
		}
		src := MemSource(m)
		for i := range m.Calls {
			o := m.Calls[i]
			if o.Dep == 0 || !hasCommitBelow(m, kids, o.ID) {
				continue
			}
			var want []model.ID
			for stack := []model.ID{o.ID}; len(stack) > 0; {
				id := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				want = append(want, kids[id]...)
				stack = append(stack, kids[id]...)
			}
			slices.Sort(want)
			r, err := ExecutionTrace(context.Background(), src, []model.Call{o})
			if err != nil {
				t.Fatal(err)
			}
			if r.Truncated {
				continue
			}
			got := []model.ID{}
			for _, c := range r.Children {
				got = append(got, c.ID)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("%s line %d: %d calls in the execution trace, %d under the call", name, o.Line, len(got), len(want))
			}
			checked++
		}
	}
	if checked == 0 {
		t.Fatal("no recursive call with a commit below it")
	}
	t.Logf("%d recursive calls with a commit below them", checked)
}

func hasCommitBelow(m *model.Model, kids map[model.ID][]model.ID, id model.ID) bool {
	for _, k := range kids[id] {
		if m.Calls[k].Kind == trace.CallXctend || hasCommitBelow(m, kids, k) {
			return true
		}
	}
	return false
}
