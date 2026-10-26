package analyze

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// waitSpansCase is web/src/lib/data/testdata/waitspans-case.json, shared with the
// TS statementWaitSpans test (derive.test.ts) so both segmenters stay identical.
type waitSpansCase struct {
	GapUs int64 `json:"gapUs"`
	Waits []struct {
		Event model.ID `json:"event"`
		Tim   int64    `json:"tim"`
		Ela   int64    `json:"ela"`
	} `json:"waits"`
	Expect []WaitSpan `json:"expect"`
}

func TestStmtWaitSpansOnSharedCase(t *testing.T) {
	raw, err := os.ReadFile("../../web/src/lib/data/testdata/waitspans-case.json")
	if err != nil {
		t.Fatal(err)
	}
	var wc waitSpansCase
	if err := json.Unmarshal(raw, &wc); err != nil {
		t.Fatal(err)
	}
	m := &model.Model{}
	for i, w := range wc.Waits {
		m.Waits = append(m.Waits, model.Wait{ID: model.ID(i), Statement: 7, Event: w.Event, Tim: w.Tim, Ela: w.Ela})
	}
	// another statement's wait, one without tim and an idle one (kept only with IncludeIdle) must not change the case
	m.Waits = append(m.Waits,
		model.Wait{ID: 100, Statement: 8, Event: 1, Tim: 500, Ela: 400},
		model.Wait{ID: 101, Statement: 7, Event: 1, Tim: 0, Ela: 400},
		model.Wait{ID: 102, Statement: 7, Event: 9, Tim: 5000, Ela: 400, Idle: true})
	run := func(idle bool) []WaitSpan {
		res, err := StmtWaitSpansOn(context.Background(), ModelFacts(m), Filter{IncludeIdle: idle}, []model.ID{7}, wc.GapUs)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := res[8]; ok {
			t.Error("statement 8 was not asked for")
		}
		return res[7]
	}
	if got := run(false); !reflect.DeepEqual(got, wc.Expect) {
		t.Errorf("wait spans\n got %+v\nwant %+v", got, wc.Expect)
	}
	idle := run(true)
	if len(idle) != len(wc.Expect)+1 || idle[3].Event != 9 || idle[3].Start != 4600 {
		t.Errorf("with idle waits: %+v", idle)
	}
}
