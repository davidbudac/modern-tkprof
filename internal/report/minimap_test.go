package report

import (
	"encoding/json"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// stats.minimap is in the document of both build modes.
func TestDocumentMinimap(t *testing.T) {
	f := "../../testdata/traces/19c/io_waits.trc"
	full, err := model.BuildFiles([]string{f}, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	for name, m := range map[string]*model.Model{"full": full, "aggregate": buildAggregate(t, f)} {
		b, err := json.Marshal(BuildDocument(m, DocOptions{}))
		if err != nil {
			t.Fatal(err)
		}
		var d struct {
			Stats struct {
				Minimap *struct {
					BucketUs int64              `json:"bucketUs"`
					CPU      []int64            `json:"cpu"`
					Waits    map[string][]int64 `json:"waits"`
				} `json:"minimap"`
			} `json:"stats"`
		}
		if err := json.Unmarshal(b, &d); err != nil {
			t.Fatal(err)
		}
		mm := d.Stats.Minimap
		if mm == nil || mm.BucketUs < 1 || len(mm.CPU) == 0 || len(mm.Waits) == 0 {
			t.Fatalf("%s: stats.minimap = %+v", name, mm)
		}
	}
}
