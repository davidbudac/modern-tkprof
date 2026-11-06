package report

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"flag"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

var updateFindingsDocs = flag.Bool("update-findings-docs", false, "rewrite web/src/lib/data/testdata/findings-*.json.gz")

// findingsDocsDir holds the documents the UI's in-browser findings
// (web/src/lib/data/findings.ts) are checked against: a document with facts
// per trace set, built with thresholds that make the rules fire, and the
// engine's answers (analyze.FindingsOn) for some scopes of it.
const findingsDocsDir = "../../web/src/lib/data/testdata"

// FindingsDoc is one fixture: the document and the scoped answers.
type findingsDoc struct {
	Doc    json.RawMessage `json:"doc"`
	Scopes []findingsScope `json:"scopes"`
}

type findingsScope struct {
	Contexts []model.ID        `json:"contexts"` // nil: all
	From     int64             `json:"from"`
	To       int64             `json:"to"`
	Findings []analyze.Finding `json:"findings"`
	Response analyze.Response  `json:"response"` // the base of the severities (response.ts scopeResponse is checked against it)
}

// TestFindingsDocsCurrent: the fixtures carry the findings the rules give
// today (go test ./internal/report -update-findings-docs rewrites them).
func TestFindingsDocsCurrent(t *testing.T) {
	cfg, err := os.ReadFile(filepath.Join(findingsDocsDir, "findings-eager.json"))
	if err != nil {
		t.Fatal(err)
	}
	th, err := analyze.ParseThresholds(cfg)
	if err != nil {
		t.Fatal(err)
	}
	tr := "../../testdata/traces/19c/"
	sets := map[string][]string{
		"io_waits":        {tr + "io_waits.trc"}, // also the Dialogue's fixture (dialogue.test.ts)
		"multisession":    {tr + "multisession_a.trc", tr + "multisession_b.trc"},
		"nasty_sql":       {tr + "nasty_sql.trc"}, // the plan advisor's INLIST ITERATOR case (advisor.test.ts)
		"parallel":        {tr + "parallel.trc", tr + "parallel_slave.trc"},
		"plan_change":     {tr + "plan_change.trc"},
		"plsql_recursive": {tr + "plsql_recursive.trc"},
		"two_boots":       {tr + "basic_binds.trc", tr + "bind_types.trc"}, // tim 12.27 h apart: two instance starts
		"workload":        {"../../testdata/sets/workload"},
	}
	for name, paths := range sets {
		t.Run(name, func(t *testing.T) {
			m, err := model.BuildFiles(paths, model.Options{})
			if err != nil {
				t.Fatal(err)
			}
			doc, err := DocumentBytes(m, DocOptions{Facts: true, Thresholds: &th})
			if err != nil {
				t.Fatal(err)
			}
			var scopes []findingsScope
			byFile := map[int][]model.ID{}
			for i := range m.Contexts {
				byFile[m.Contexts[i].FileIdx] = append(byFile[m.Contexts[i].FileIdx], model.ID(i))
			}
			for fi := 0; fi < len(m.File.Files); fi++ {
				scopes = append(scopes, findingsScope{Contexts: byFile[fi]})
			}
			if len(m.Contexts) > 1 {
				scopes = append(scopes, findingsScope{Contexts: []model.ID{model.ID(len(m.Contexts) - 1)}})
			}
			first, last := m.Span.FirstTim, m.Span.LastTim
			mid := first + (last-first)/2
			scopes = append(scopes, findingsScope{From: first, To: mid}, findingsScope{From: mid, To: last}, findingsScope{Contexts: byFile[0], From: mid, To: last})
			for i := range scopes {
				sc := &scopes[i]
				f := analyze.Filter{Contexts: sc.Contexts, StartTim: sc.From, EndTim: sc.To}
				sc.Findings, err = analyze.FindingsOnWith(context.Background(), m, analyze.ModelFacts(m), f, th)
				if err != nil {
					t.Fatal(err)
				}
				sc.Response = analyze.ResponseOf(m, analyze.Contexts(m), f)
			}
			path := filepath.Join(findingsDocsDir, "findings-"+name+".json.gz")
			if *updateFindingsDocs {
				b, _ := json.Marshal(findingsDoc{Doc: doc, Scopes: scopes})
				var buf bytes.Buffer
				zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
				zw.Write(b)
				zw.Close()
				if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			f, err := os.Open(path)
			if err != nil {
				t.Fatalf("%v (go test ./internal/report -run FindingsDocs -update-findings-docs)", err)
			}
			defer f.Close()
			zr, err := gzip.NewReader(f)
			if err != nil {
				t.Fatal(err)
			}
			b, err := io.ReadAll(zr)
			if err != nil {
				t.Fatal(err)
			}
			var pinned findingsDoc
			if err := json.Unmarshal(b, &pinned); err != nil {
				t.Fatal(err)
			}
			var pd, nd struct {
				Stats struct {
					Findings []analyze.Finding `json:"findings"`
				} `json:"stats"`
			}
			json.Unmarshal(pinned.Doc, &pd)
			json.Unmarshal(doc, &nd)
			if !reflect.DeepEqual(pd.Stats.Findings, nd.Stats.Findings) || !reflect.DeepEqual(pinned.Scopes, scopes) {
				t.Errorf("%s is stale: go test ./internal/report -run FindingsDocs -update-findings-docs, then cd web && pnpm test", path)
			}
		})
	}
}
