// Package report renders a model as text, JSON or CSV.
package report

import (
	"encoding/json"
	"io"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// Document is the JSON payload consumed by the web UI: the model plus the
// standard aggregations, so the UI never has to recompute the basics.
type Document struct {
	Tool       string              `json:"tool"`
	Version    string              `json:"version"`
	Model      *model.Model        `json:"model"`
	Statements []analyze.StmtStats `json:"statements"`
	Profile    analyze.Profile     `json:"profile"`
	Events     []analyze.EventAgg  `json:"events"`
	Timeline   []analyze.Bucket    `json:"timeline"`
}

// Version is stamped into reports by the CLI.
var Version = "0.1.0-dev"

// JSON writes the document. With facts=false the raw fact tables are omitted
// (statements, cursors, contexts, plans and aggregates remain).
func JSON(w io.Writer, m *model.Model, facts bool) error {
	doc := Document{
		Tool:       "mtkprof",
		Version:    Version,
		Model:      m,
		Statements: analyze.Statements(m),
		Profile:    analyze.TraceProfile(m),
		Events:     analyze.WaitsByEvent(m, nil),
		Timeline:   analyze.Timeline(m, timelineBucket(m)),
	}
	if !facts {
		slim := *m
		slim.Calls, slim.Waits, slim.Binds, slim.BindSets = nil, nil, nil, nil
		doc.Model = &slim
	}
	enc := json.NewEncoder(w)
	return enc.Encode(doc)
}

// timelineBucket picks a bucket size giving roughly 200-400 buckets.
func timelineBucket(m *model.Model) int64 {
	span := m.Span.Us()
	if span <= 0 {
		return 0
	}
	for _, b := range []int64{1000, 10000, 100000, 1000000, 10000000, 60000000, 600000000, 3600000000} {
		if span/b <= 400 {
			return b
		}
	}
	return span / 400
}
