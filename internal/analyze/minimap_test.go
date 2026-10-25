package analyze

import (
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// minimapSets are the single fixtures of every Oracle version plus the
// multi-file sets (PX slave attached to its coordinator, two sessions).
func minimapSets(t *testing.T) map[string][]string {
	t.Helper()
	sets := fixtureSets(t)
	all, _ := filepath.Glob("../../testdata/traces/*/*.trc")
	for _, f := range all {
		if strings.Contains(f, "/19c/") {
			continue
		}
		sets[filepath.Base(filepath.Dir(f))+"/"+strings.TrimSuffix(filepath.Base(f), ".trc")] = []string{f}
	}
	return sets
}

func sum(v []int64) (s int64) {
	for _, x := range v {
		s += x
	}
	return
}

// profileByClass is Σ us of the wait / idle rows of a profile per class.
func profileByClass(p Profile) map[string]int64 {
	out := map[string]int64{}
	for _, r := range p.Rows {
		if r.Kind != "wait" && r.Kind != "idle" {
			continue
		}
		c := r.Class
		if c == "" {
			c = "Other"
		}
		out[c] += r.Us
	}
	for c, v := range out {
		if v == 0 {
			delete(out, c)
		}
	}
	return out
}

func checkMinimapSums(t *testing.T, mode string, m *model.Model) *Minimap {
	t.Helper()
	mm := TraceMinimap(m)
	if mm == nil {
		t.Fatalf("%s: no minimap", mode)
	}
	p := TraceProfile(m)
	if len(mm.CPU) < 1 || len(mm.CPU) > MinimapBuckets || mm.BucketUs < 1 {
		t.Fatalf("%s: layout n=%d bucketUs=%d", mode, len(mm.CPU), mm.BucketUs)
	}
	if span := m.Span.LastTim - m.Span.FirstTim; span+1 >= MinimapBuckets && len(mm.CPU) != MinimapBuckets {
		t.Errorf("%s: %d buckets for span %d µs, want %d", mode, len(mm.CPU), span, MinimapBuckets)
	}
	if got := sum(mm.CPU); got != p.CPUUs {
		t.Errorf("%s: Σ cpu = %d, profile CPU = %d", mode, got, p.CPUUs)
	}
	want := profileByClass(p)
	got := map[string]int64{}
	for c, v := range mm.Waits {
		if len(v) != len(mm.CPU) {
			t.Errorf("%s: class %s has %d buckets, cpu %d", mode, c, len(v), len(mm.CPU))
		}
		got[c] = sum(v)
	}
	if len(got) != len(want) {
		t.Errorf("%s: classes %v, profile %v", mode, got, want)
	}
	for c, us := range want {
		if got[c] != us {
			t.Errorf("%s: class %s Σ = %d, profile %d", mode, c, got[c], us)
		}
	}
	return mm
}

// cumulative checks the aggregate minimap against the exact one. The
// accumulator puts a 100 µs cell into the bucket of its start, so an event
// is at most ceil(100/bucketUs) buckets early and never late:
// full[:k+1] ≤ agg[:k+1] ≤ full[:k+1+d] for every k.
func cumulative(t *testing.T, name string, full, agg []int64, d int) {
	t.Helper()
	if len(full) != len(agg) {
		t.Fatalf("%s: %d vs %d buckets", name, len(full), len(agg))
	}
	var cf, ca []int64
	var sf, sa int64
	for i := range full {
		sf += full[i]
		sa += agg[i]
		cf, ca = append(cf, sf), append(ca, sa)
	}
	for k := range ca {
		hi := cf[len(cf)-1]
		if k+d < len(cf) {
			hi = cf[k+d]
		}
		if ca[k] < cf[k] || ca[k] > hi {
			t.Errorf("%s: after bucket %d agg Σ = %d, full Σ = %d (up to %d allowed)", name, k, ca[k], cf[k], hi)
			return
		}
	}
}

func TestMinimapFixtures(t *testing.T) {
	th := DefaultThresholds()
	sets := minimapSets(t)
	names := make([]string, 0, len(sets))
	for n := range sets {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		files := sets[name]
		t.Run(name, func(t *testing.T) {
			full, agg := buildPair(t, files, th)
			f := checkMinimapSums(t, "full", full)
			a := checkMinimapSums(t, "aggregate", agg)
			if f.BucketUs != a.BucketUs {
				t.Fatalf("bucketUs full %d, aggregate %d", f.BucketUs, a.BucketUs)
			}
			d := 1
			if f.BucketUs < 100 {
				d = int((100 + f.BucketUs - 1) / f.BucketUs)
			}
			cumulative(t, "cpu", f.CPU, a.CPU, d)
			for c, v := range f.Waits {
				cumulative(t, "waits "+c, v, a.Waits[c], d)
			}
		})
	}
}

// The layout: one bucket per µs below 1024 µs, 1024 buckets of ceil((span+1)/1024) above.
func TestMinimapShortSpan(t *testing.T) {
	m := &model.Model{Span: model.Span{FirstTim: 1000, LastTim: 1009}}
	l := newMmLayout(m.Span)
	if l.n != 10 || l.bucketUs != 1 {
		t.Fatalf("short span: n=%d bucketUs=%d", l.n, l.bucketUs)
	}
	l = newMmLayout(model.Span{FirstTim: 1000, LastTim: 1000 + 1023})
	if l.n != 1024 || l.bucketUs != 1 {
		t.Fatalf("span 1024 µs: n=%d bucketUs=%d", l.n, l.bucketUs)
	}
	l = newMmLayout(model.Span{FirstTim: 1000, LastTim: 1000 + 1024})
	if l.n != 1024 || l.bucketUs != 2 || l.at(1000+1024) != 512 {
		t.Fatalf("span 1025 µs: n=%d bucketUs=%d last=%d", l.n, l.bucketUs, l.at(1000+1024))
	}
}
