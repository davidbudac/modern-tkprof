package analyze

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// phasesCase is web/src/lib/data/testdata/phases-case.json, shared with the TS
// statementPhases test (derive.test.ts) so both segmenters stay identical.
type phasesCase struct {
	GapUs int64 `json:"gapUs"`
	Calls []struct {
		Kind int   `json:"kind"`
		Tim  int64 `json:"tim"`
		E    int64 `json:"e"`
	} `json:"calls"`
	Expect []PhaseSpan `json:"expect"`
}

func TestStmtPhasesOnSharedCase(t *testing.T) {
	raw, err := os.ReadFile("../../web/src/lib/data/testdata/phases-case.json")
	if err != nil {
		t.Fatal(err)
	}
	var pc phasesCase
	if err := json.Unmarshal(raw, &pc); err != nil {
		t.Fatal(err)
	}
	m := &model.Model{}
	for i, c := range pc.Calls {
		m.Calls = append(m.Calls, model.Call{ID: model.ID(i), Statement: 7, Kind: trace.CallKind(c.Kind), Tim: c.Tim, E: c.E})
	}
	// a call of another statement and one without tim must not show up
	m.Calls = append(m.Calls,
		model.Call{ID: 100, Statement: 8, Kind: trace.CallExec, Tim: 500, E: 400},
		model.Call{ID: 101, Statement: 7, Kind: trace.CallExec, Tim: 0, E: 400})
	res, err := StmtPhasesOn(context.Background(), ModelFacts(m), Filter{}, []model.ID{7}, pc.GapUs)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(res[7], pc.Expect) {
		t.Errorf("phases\n got %+v\nwant %+v", res[7], pc.Expect)
	}
	if _, ok := res[8]; ok {
		t.Error("statement 8 was not asked for")
	}
}

func TestSegmentPhasesBounds(t *testing.T) {
	// 1000 alternating 1 µs calls 2 µs apart: with a 50 µs gap the segments stay >= 50 µs wide.
	var calls []phaseCall
	for i := int64(0); i < 1000; i++ {
		calls = append(calls, phaseCall{start: i * 3, end: i*3 + 1, e: 1, group: int(i % 2)})
	}
	segs := segmentPhases(calls, 50)
	if len(segs) > 2*3000/50+1 {
		t.Errorf("%d segments, want about <= %d", len(segs), 2*3000/50)
	}
	var sum int64
	for _, s := range segs {
		for _, v := range s.Us {
			sum += v
		}
	}
	if sum != 1000 {
		t.Errorf("µs not conserved: %d", sum)
	}
	if got := segmentPhases(nil, 10); len(got) != 0 {
		t.Errorf("no calls, got %+v", got)
	}
}
