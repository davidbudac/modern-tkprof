package analyze

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// scatterRef is the in-memory algorithm ScatterWaitsOn replaces: sort every
// wait in scope by elapsed time and stride through the sorted list.
func scatterRef(waits []model.Wait, f Filter, max int) (ids []int32, total int) {
	mt := f.Matcher()
	var all []int32
	for i := range waits {
		w := &waits[i]
		if w.Tim == 0 || !mt.Wait(w) {
			continue
		}
		all = append(all, int32(i))
	}
	total = len(all)
	if total <= max {
		return all, total
	}
	byEla := append([]int32(nil), all...)
	sort.SliceStable(byEla, func(a, b int) bool { return waits[byEla[a]].Ela > waits[byEla[b]].Ela })
	if max < KeepSlowest {
		return append([]int32(nil), byEla[:max]...), total
	}
	rest := byEla[KeepSlowest:]
	out := append([]int32(nil), byEla[:KeepSlowest]...)
	stride := float64(len(rest)) / float64(max-KeepSlowest)
	for k := 0; k < max-KeepSlowest; k++ {
		out = append(out, rest[int(float64(k)*stride)])
	}
	sort.Slice(out, func(a, b int) bool { return out[a] < out[b] })
	return out, total
}

func TestScatterWaitsOnMatchesInMemory(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for _, tc := range []struct{ n, distinct, max int }{
		{500, 50, 600}, {3000, 40, 2500}, {9000, 300, 2000}, {9000, 5000, 3333}, {20000, 17, 5000}, {6000, 900, 100}, {6000, 900, 1999},
	} {
		waits := make([]model.Wait, tc.n)
		for i := range waits {
			waits[i] = model.Wait{ID: model.ID(i), Tim: int64(i + 1), Ela: int64(rng.Intn(tc.distinct)), Statement: model.ID(rng.Intn(3)), Line: int32(i)}
			if rng.Intn(20) == 0 {
				waits[i].Tim = 0
			}
		}
		m := &model.Model{Waits: waits}
		for _, f := range []Filter{{IncludeIdle: true}, {IncludeIdle: true, StartTim: int64(tc.n / 3)}} {
			wantIDs, wantTotal := scatterRef(waits, f, tc.max)
			pts, total, err := ScatterWaitsOn(t.Context(), ModelFacts(m), f, tc.max)
			if err != nil {
				t.Fatal(err)
			}
			var gotIDs []int32
			for _, p := range pts {
				gotIDs = append(gotIDs, int32(p.ID))
				if w := waits[p.ID]; p.Tim != w.Tim || p.Ela != w.Ela || p.Line != w.Line || p.Stmt != w.Statement {
					t.Fatalf("point %+v does not carry wait %+v", p, w)
				}
			}
			if total != wantTotal || !reflect.DeepEqual(gotIDs, wantIDs) {
				t.Errorf("%+v: total %d/%d, ids differ (%d vs %d)", tc, total, wantTotal, len(gotIDs), len(wantIDs))
			}
		}
	}
}
