package report

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// DefaultPlanVizURL is the hosted davidbudac/ora-explain-plan-viz.
const DefaultPlanVizURL = "https://davidbudac.github.io/ora-explain-plan-viz/"

// maxPlanVizURL is the longest "Open in plan viz" link we hand out; browsers
// and chat tools choke on longer ones.
const maxPlanVizURL = 100000

// PlanRow is one STAT line in the V$SQL_PLAN_STATISTICS_ALL-style JSON row
// format that ora-explain-plan-viz auto-detects (jsonPlanParser.ts). Optional
// numbers are pointers so "missing" is omitted instead of printed as 0.
// SQLText, Execution and TraceLine are set on the first row only.
type PlanRow struct {
	ID              int    `json:"id"`
	ParentID        *int   `json:"parent_id"` // null for the root
	Depth           int    `json:"depth"`
	Operation       string `json:"operation"`
	ObjectName      string `json:"object_name,omitempty"`
	ObjectID        int64  `json:"object_id,omitempty"`
	Cardinality     *int64 `json:"cardinality,omitempty"`
	Bytes           *int64 `json:"bytes,omitempty"`
	Cost            *int64 `json:"cost,omitempty"`
	ActualRows      *int64 `json:"actual_rows,omitempty"`
	Starts          *int64 `json:"starts,omitempty"`
	ActualElapsedUs *int64 `json:"actual_elapsed_time,omitempty"` // microseconds
	CRBufferGets    *int64 `json:"cr_buffer_gets,omitempty"`
	PhysicalReads   *int64 `json:"physical_reads,omitempty"`
	PhysicalWrites  *int64 `json:"physical_writes,omitempty"`
	SQLID           string `json:"sql_id,omitempty"`
	PlanHashValue   string `json:"plan_hash_value"`
	SQLText         string `json:"sql_text,omitempty"`
	Execution       int    `json:"execution,omitempty"`
	TraceLine       int    `json:"trace_line,omitempty"`
}

func ptr[T any](v T) *T { return &v }

func optNeg(v int64) *int64 {
	if v < 0 {
		return nil
	}
	return &v
}

// PlansOf returns every STAT dump of a statement, in trace order.
func PlansOf(m *model.Model, stmt model.ID) []*model.Plan {
	var out []*model.Plan
	for i := range m.Plans {
		if m.Plans[i].Statement == stmt {
			out = append(out, &m.Plans[i])
		}
	}
	return out
}

// LatestPlans returns the last dump per plan hash, in order of first
// appearance of the hash.
func LatestPlans(m *model.Model, stmt model.ID) []*model.Plan {
	var out []*model.Plan
	at := map[uint64]int{}
	for _, p := range PlansOf(m, stmt) {
		if i, ok := at[p.PLH]; ok {
			out[i] = p
		} else {
			at[p.PLH] = len(out)
			out = append(out, p)
		}
	}
	return out
}

// PlanRows converts one STAT dump to visualizer rows.
func PlanRows(m *model.Model, p *model.Plan) []PlanRow {
	lines := m.PlanLines[p.First : p.First+p.N]
	ids := make(map[int]bool, len(lines))
	for _, l := range lines {
		ids[l.ID] = true
	}
	plh := strconv.FormatUint(p.PLH, 10)
	sqlID := ""
	text := ""
	exec := 0
	if p.Statement >= 0 && int(p.Statement) < len(m.Statements) {
		st := &m.Statements[p.Statement]
		sqlID, text = st.SQLID, st.Text
		for _, q := range PlansOf(m, p.Statement) {
			if q.PLH == p.PLH {
				exec++
			}
			if q == p {
				break
			}
		}
	}
	rows := make([]PlanRow, len(lines))
	for i, l := range lines {
		r := PlanRow{ID: l.ID, Depth: l.Depth, Operation: l.Op, ObjectName: l.Object, SQLID: sqlID, PlanHashValue: plh}
		if ids[l.ParentID] {
			r.ParentID = ptr(l.ParentID)
		}
		if l.Obj > 0 {
			r.ObjectID = l.Obj
		}
		if l.HasStats {
			r.Cardinality, r.Bytes, r.Cost = optNeg(l.Card), optNeg(l.Size), optNeg(l.Cost)
			r.ActualRows, r.Starts, r.ActualElapsedUs = ptr(l.Cnt), ptr(l.Str), ptr(l.TimeUs)
			r.CRBufferGets, r.PhysicalReads, r.PhysicalWrites = ptr(l.CR), ptr(l.PR), ptr(l.PW)
		} else {
			r.ActualRows = ptr(l.Cnt)
		}
		rows[i] = r
	}
	if len(rows) > 0 {
		rows[0].SQLText, rows[0].Execution, rows[0].TraceLine = text, exec, p.Line
	}
	return rows
}

// PlanJSON is PlanRows as an indented JSON array.
func PlanJSON(m *model.Model, p *model.Plan) ([]byte, error) {
	return json.MarshalIndent(PlanRows(m, p), "", "  ")
}

type planVizInput struct {
	RawInput string `json:"rawInput"`
}

type planVizPayload struct {
	Plans    []planVizInput `json:"plans"`
	ViewMode string         `json:"viewMode"`
}

// PlanVizURL builds the "Open in plan viz" link: the row array travels in the
// URL fragment as gzip+base64url of {"plans":[{"rawInput":...}],...}. The
// fragment is never sent to a server.
func PlanVizURL(base string, rows []byte) (string, error) {
	payload, err := json.Marshal(planVizPayload{
		Plans:    []planVizInput{{RawInput: string(rows)}},
		ViewMode: "hierarchical",
	})
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	zw.Write(payload)
	if err := zw.Close(); err != nil {
		return "", err
	}
	if base == "" {
		base = DefaultPlanVizURL
	}
	url := base + "#gz=" + base64.RawURLEncoding.EncodeToString(buf.Bytes())
	if len(url) > maxPlanVizURL {
		return "", fmt.Errorf("plan is too big for a link (%d chars, limit %d); use the JSON output and paste it into the visualizer", len(url), maxPlanVizURL)
	}
	return url, nil
}
