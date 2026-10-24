// Package analyze computes profiles and statistics over a model.Model.
package analyze

import (
	"context"
	"fmt"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// CallStats are tkprof-style totals for one call kind.
type CallStats struct {
	Count   int64 `json:"count"`
	Misses  int64 `json:"misses"`
	CPU     int64 `json:"cpu"`
	Elapsed int64 `json:"elapsed"`
	Disk    int64 `json:"disk"`
	Query   int64 `json:"query"`
	Current int64 `json:"current"`
	Rows    int64 `json:"rows"`
	Waits   int64 `json:"waitUs"` // in-call waits attributed to these calls
	Idle    int64 `json:"idleUs"` // between-call waits attributed to these calls
	// Self* exclude the recursive child calls (this is what tkprof prints).
	SelfCPU     int64 `json:"selfCpu"`
	SelfElapsed int64 `json:"selfElapsed"`
	SelfDisk    int64 `json:"selfDisk"`
	SelfQuery   int64 `json:"selfQuery"`
	SelfCurrent int64 `json:"selfCurrent"`
}

func (s *CallStats) add(c *model.Call) {
	s.Count++
	s.Misses += int64(c.Mis)
	s.CPU += c.C
	s.Elapsed += c.E
	s.Disk += c.P
	s.Query += c.CR
	s.Current += c.CU
	s.Rows += c.R
	s.Waits += c.WaitEla
	s.Idle += c.IdleEla
	s.SelfCPU += c.SelfC
	s.SelfElapsed += c.SelfE
	s.SelfDisk += c.SelfP
	s.SelfQuery += c.SelfCR
	s.SelfCurrent += c.SelfCU
}

func (s *CallStats) addStats(o CallStats) {
	s.Count += o.Count
	s.Misses += o.Misses
	s.CPU += o.CPU
	s.Elapsed += o.Elapsed
	s.Disk += o.Disk
	s.Query += o.Query
	s.Current += o.Current
	s.Rows += o.Rows
	s.Waits += o.Waits
	s.Idle += o.Idle
	s.SelfCPU += o.SelfCPU
	s.SelfElapsed += o.SelfElapsed
	s.SelfDisk += o.SelfDisk
	s.SelfQuery += o.SelfQuery
	s.SelfCurrent += o.SelfCurrent
}

// Link is a recursive relationship between two statements with the time share.
type Link struct {
	Statement model.ID `json:"statement"`
	Calls     int64    `json:"calls"`
	Elapsed   int64    `json:"elapsed"`
}

// StmtStats is everything tkprof prints per statement, plus response-time
// accounting that respects the recursive hierarchy.
type StmtStats struct {
	ID       model.ID  `json:"id"`
	Parse    CallStats `json:"parse"`
	Exec     CallStats `json:"exec"`
	Fetch    CallStats `json:"fetch"`
	Close    CallStats `json:"close"`
	Other    CallStats `json:"other"` // LOB / RPC / XCTEND
	Total    CallStats `json:"total"` // parse+exec+fetch (tkprof "total" row)
	AllCalls CallStats `json:"allCalls"`

	// Response time: Σ e over calls of this statement not nested in another
	// call of the same statement; includes recursive children of other statements.
	Elapsed     int64 `json:"elapsed"`
	SelfElapsed int64 `json:"selfElapsed"` // Σ SelfE: elapsed excluding recursive children
	CPU         int64 `json:"cpu"`
	SelfCPU     int64 `json:"selfCpu"`
	WaitUs      int64 `json:"waitUs"` // in-call waits
	IdleUs      int64 `json:"idleUs"` // between-call waits (think time)
	ChildUs     int64 `json:"childUs"`

	Executions int64 `json:"executions"`
	HardParses int64 `json:"hardParses"`
	Cursors    int   `json:"cursors"`
	Errors     int   `json:"errors"`
	MinDep     int   `json:"minDepth"`
	MaxDep     int   `json:"maxDepth"`
	TopLevel   bool  `json:"topLevel"` // has calls with no parent

	FirstWallUs int64 `json:"firstWallUs"`
	LastWallUs  int64 `json:"lastWallUs"`
	FirstTim    int64 `json:"firstTim"`
	LastTim     int64 `json:"lastTim"`

	// PX slave work attached to this statement (see model.Context.Parent):
	// kept out of every field above so a coordinator's response time is not
	// double counted.
	PXElapsed  int64 `json:"pxEla"`      // Σ self elapsed of the slaves' calls of this statement
	PXCPU      int64 `json:"pxCpu"`      // Σ self cpu
	PXSessions int   `json:"pxSessions"` // distinct slave processes that ran it

	Parents    []Link     `json:"parents"`
	Children   []Link     `json:"children"`
	Plans      []model.ID `json:"plans"`
	PlanHashes []uint64   `json:"planHashes"`
}

// Statements computes StmtStats for every statement, in statement id order.
func Statements(m *model.Model) []StmtStats {
	if a := AggOf(m); a != nil {
		return a.stats
	}
	out := make([]StmtStats, len(m.Statements))
	for i := range out {
		out[i].ID = model.ID(i)
		out[i].MinDep = 1 << 30
		out[i].MaxDep = -1
		out[i].Cursors = len(m.Statements[i].Cursors)
	}
	type edge struct{ parent, child model.ID }
	edges := make(map[edge]*Link)
	pxProcs := map[model.ID]map[string]bool{}
	for i := range m.Calls {
		c := &m.Calls[i]
		s := &out[c.Statement]
		if m.PXChild(c.Context) {
			s.PXElapsed += c.SelfE
			s.PXCPU += c.SelfC
			if pxProcs[c.Statement] == nil {
				pxProcs[c.Statement] = map[string]bool{}
			}
			pxProcs[c.Statement][PXProcess(m, c.Context)] = true
			continue
		}
		switch c.Kind {
		case trace.CallParse:
			s.Parse.add(c)
			if c.Mis > 0 {
				s.HardParses += int64(c.Mis)
			}
		case trace.CallExec:
			s.Exec.add(c)
			s.Executions++
		case trace.CallFetch:
			s.Fetch.add(c)
		case trace.CallClose:
			s.Close.add(c)
		default:
			s.Other.add(c)
		}
		s.AllCalls.add(c)
		if dep := int(c.Dep); dep < s.MinDep {
			s.MinDep = dep
		}
		if dep := int(c.Dep); dep > s.MaxDep {
			s.MaxDep = dep
		}
		nestedInSelf := c.Parent != model.None && m.Calls[c.Parent].Statement == c.Statement
		if !nestedInSelf {
			s.Elapsed += c.E
			s.CPU += c.C
		}
		s.SelfElapsed += c.SelfE
		s.SelfCPU += c.SelfC
		s.WaitUs += c.WaitEla
		s.IdleUs += c.IdleEla
		if c.Parent == model.None {
			s.TopLevel = true
		} else {
			p := &m.Calls[c.Parent]
			if p.Statement != c.Statement {
				e := edge{p.Statement, c.Statement}
				l, ok := edges[e]
				if !ok {
					l = &Link{}
					edges[e] = l
				}
				l.Calls++
				l.Elapsed += c.E
				out[p.Statement].ChildUs += c.E
			}
		}
		if c.Tim != 0 {
			if s.FirstTim == 0 || c.Tim-c.E < s.FirstTim {
				s.FirstTim = c.Tim - c.E
				s.FirstWallUs = m.CallWall(c) - c.E
			}
			if c.Tim > s.LastTim {
				s.LastTim = c.Tim
				s.LastWallUs = m.CallWall(c)
			}
		}
	}
	for sid, procs := range pxProcs {
		out[sid].PXSessions = len(procs)
	}
	keys := make([]edge, 0, len(edges))
	for e := range edges {
		keys = append(keys, e)
	}
	sort.Slice(keys, func(i, j int) bool { // map order is random; keep the output reproducible
		if keys[i].parent != keys[j].parent {
			return keys[i].parent < keys[j].parent
		}
		return keys[i].child < keys[j].child
	})
	for _, e := range keys {
		l := edges[e]
		out[e.parent].Children = append(out[e.parent].Children, Link{Statement: e.child, Calls: l.Calls, Elapsed: l.Elapsed})
		out[e.child].Parents = append(out[e.child].Parents, Link{Statement: e.parent, Calls: l.Calls, Elapsed: l.Elapsed})
	}
	for i := range out {
		s := &out[i]
		s.Total.addStats(s.Parse)
		s.Total.addStats(s.Exec)
		s.Total.addStats(s.Fetch)
		if s.MinDep == 1<<30 {
			s.MinDep = m.Statements[i].MinDep
			s.MaxDep = s.MinDep
		}
		sort.Slice(s.Children, func(a, b int) bool { return s.Children[a].Elapsed > s.Children[b].Elapsed })
		sort.Slice(s.Parents, func(a, b int) bool { return s.Parents[a].Elapsed > s.Parents[b].Elapsed })
	}
	for i := range m.Errors {
		if sid := m.Errors[i].Statement; sid != model.None {
			out[sid].Errors++
		}
	}
	seen := map[model.ID]map[uint64]bool{}
	for i := range m.Plans {
		p := &m.Plans[i]
		s := &out[p.Statement]
		s.Plans = append(s.Plans, p.ID)
		if seen[p.Statement] == nil {
			seen[p.Statement] = map[uint64]bool{}
		}
		if !seen[p.Statement][p.PLH] {
			seen[p.Statement][p.PLH] = true
			s.PlanHashes = append(s.PlanHashes, p.PLH)
		}
	}
	return out
}

// ProfileRow is one component of a resource profile.
type ProfileRow struct {
	Component string  `json:"component"`
	Kind      string  `json:"kind"` // cpu | wait | idle | unaccounted
	Class     string  `json:"class,omitempty"`
	Us        int64   `json:"us"`
	Pct       float64 `json:"pct"`
	Count     int64   `json:"count"`
	AvgUs     float64 `json:"avgUs"`
	MinUs     int64   `json:"minUs"`
	MaxUs     int64   `json:"maxUs"`
}

// Profile is a Millsap-style resource profile: response time split into
// CPU, each wait event, and the unaccounted-for remainder.
type Profile struct {
	Label         string       `json:"label"`
	TotalUs       int64        `json:"totalUs"`
	CPUUs         int64        `json:"cpuUs"`
	WaitUs        int64        `json:"waitUs"` // non-idle waits
	IdleUs        int64        `json:"idleUs"` // idle / between-call waits
	UnaccountedUs int64        `json:"unaccountedUs"`
	Rows          []ProfileRow `json:"rows"`
}

// PXProcess names the slave process a PX context ran in (its pid, else the
// file), for counting slave sessions.
func PXProcess(m *model.Model, ctx model.ID) string {
	c := &m.Contexts[ctx]
	if c.Process != "" {
		return "pid " + c.Process
	}
	return fmt.Sprintf("file %d", c.FileIdx)
}

// PXTotals is the work of the PX slaves attached to coordinators.
type PXTotals struct {
	Sessions int   `json:"sessions"` // slave processes
	CPUUs    int64 `json:"cpuUs"`    // Σ c of the slaves' top-level calls
	WaitUs   int64 `json:"waitUs"`   // non-idle waits
	IdleUs   int64 `json:"idleUs"`   // idle waits (PX Deq: ...)
}

// PX sums what the attached PX slaves did. TraceProfile leaves it out of the
// coordinator's profile.
func PX(m *model.Model) PXTotals {
	if a := AggOf(m); a != nil {
		return a.pxTotals
	}
	var t PXTotals
	procs := map[string]bool{}
	for i := range m.Calls {
		c := &m.Calls[i]
		if m.PXChild(c.Context) {
			procs[PXProcess(m, c.Context)] = true
			if c.Parent == model.None {
				t.CPUUs += c.C
			}
		}
	}
	for i := range m.Waits {
		w := &m.Waits[i]
		if m.PXChild(w.Context) {
			procs[PXProcess(m, w.Context)] = true
			if w.Idle || w.Between {
				t.IdleUs += w.Ela
			} else {
				t.WaitUs += w.Ela
			}
		}
	}
	t.Sessions = len(procs)
	return t
}

// TraceProfile profiles the whole file: total = trace span, CPU = Σ c of
// top-level calls, waits = every wait line. PX slaves attached to a
// coordinator are left out (see PX): their time runs in parallel with the
// coordinator's.
func TraceProfile(m *model.Model) Profile {
	if a := AggOf(m); a != nil {
		by := map[model.ID]*evAgg{}
		for i := range a.main.events {
			if e := &a.main.events[i]; e.n > 0 {
				by[model.ID(i)] = e
			}
		}
		return profileOf(m, "whole trace", m.Span.Us(), a.main.topCPU, by, a.main.waitUs, a.main.idleUs)
	}
	var cpu int64
	for i := range m.Calls {
		c := &m.Calls[i]
		if c.Parent == model.None && !m.PXChild(c.Context) {
			cpu += c.C
		}
	}
	total := m.Span.Us()
	p := buildProfile(m, "whole trace", total, cpu, func(w *model.Wait) bool { return !m.PXChild(w.Context) })
	return p
}

// StatementProfile profiles one statement: total = its response time plus
// the between-call (idle) waits attributed to it.
func StatementProfile(m *model.Model, st *StmtStats) Profile {
	total := st.Elapsed + st.IdleUs
	sid := st.ID
	if a := AggOf(m); a != nil {
		if s := a.acc(sid); s != nil {
			return profileOf(m, m.Statements[sid].SQLID, total, st.CPU, s.byEvent, s.profWait, s.profIdle)
		}
		return profileOf(m, m.Statements[sid].SQLID, total, st.CPU, nil, 0, 0)
	}
	return buildProfile(m, m.Statements[sid].SQLID, total, st.CPU, func(w *model.Wait) bool {
		return w.Statement == sid && !m.PXChild(w.Context)
	})
}

func buildProfile(m *model.Model, label string, total, cpu int64, in func(*model.Wait) bool) Profile {
	byEvent := map[model.ID]*evAgg{}
	var waitUs, idleUs int64
	for i := range m.Waits {
		w := &m.Waits[i]
		if !in(w) {
			continue
		}
		a := byEvent[w.Event]
		if a == nil {
			a = &evAgg{}
			byEvent[w.Event] = a
		}
		a.add(w.Ela)
		if w.Idle || w.Between {
			idleUs += w.Ela
		} else {
			waitUs += w.Ela
		}
	}
	return profileOf(m, label, total, cpu, byEvent, waitUs, idleUs)
}

// profileOf builds the profile from the waits aggregated by event.
func profileOf(m *model.Model, label string, total, cpu int64, byEvent map[model.ID]*evAgg, waitUs, idleUs int64) Profile {
	p := Profile{Label: label, TotalUs: total, CPUUs: cpu, WaitUs: waitUs, IdleUs: idleUs}
	p.Rows = append(p.Rows, ProfileRow{Component: "CPU", Kind: "cpu", Us: cpu})
	eids := make([]model.ID, 0, len(byEvent))
	for eid := range byEvent {
		eids = append(eids, eid)
	}
	sort.Slice(eids, func(i, j int) bool { return eids[i] < eids[j] }) // map order is random; ties must not reorder rows
	for _, eid := range eids {
		a := byEvent[eid]
		ev := &m.Events[eid]
		kind := "wait"
		if ev.Idle {
			kind = "idle"
		}
		p.Rows = append(p.Rows, ProfileRow{Component: ev.Name, Kind: kind, Class: ev.Class, Us: a.us, Count: a.n, AvgUs: float64(a.us) / float64(a.n), MinUs: a.min, MaxUs: a.max})
	}
	p.UnaccountedUs = total - cpu - waitUs - idleUs
	p.Rows = append(p.Rows, ProfileRow{Component: "unaccounted-for", Kind: "unaccounted", Us: p.UnaccountedUs})
	sort.SliceStable(p.Rows, func(i, j int) bool { return p.Rows[i].Us > p.Rows[j].Us })
	if total > 0 {
		for i := range p.Rows {
			p.Rows[i].Pct = 100 * float64(p.Rows[i].Us) / float64(total)
		}
	}
	return p
}

// EventAgg aggregates waits by event.
type EventAgg struct {
	Event model.ID `json:"event"`
	Name  string   `json:"name"`
	Class string   `json:"class"`
	Idle  bool     `json:"idle"`
	Count int64    `json:"count"`
	Us    int64    `json:"us"`
	MinUs int64    `json:"minUs"`
	MaxUs int64    `json:"maxUs"`
}

// WaitsByEvent aggregates the waits accepted by in (nil = all), sorted by time desc.
func WaitsByEvent(m *model.Model, in func(*model.Wait) bool) []EventAgg {
	if a := AggOf(m); a != nil && in == nil {
		return a.waitsByEvent(func(ev model.ID) *evAgg {
			if int(ev) < len(a.events) {
				return &a.events[ev]
			}
			return nil
		})
	}
	out, _ := WaitsByEventOn(context.Background(), m, ModelFacts(m), Scan{}, in)
	return out
}

// WaitsByEventOn is WaitsByEvent over any Facts (it always scans: sc narrows
// the scan to the rows in can accept).
func WaitsByEventOn(ctx context.Context, m *model.Model, src Facts, sc Scan, in func(*model.Wait) bool) ([]EventAgg, error) {
	aggs := make([]EventAgg, len(m.Events))
	for i := range aggs {
		aggs[i] = EventAgg{Event: model.ID(i), Name: m.Events[i].Name, Class: m.Events[i].Class, Idle: m.Events[i].Idle}
	}
	err := src.EachWait(ctx, sc, func(w *model.Wait) bool {
		if in != nil && !in(w) {
			return true
		}
		a := &aggs[w.Event]
		if a.Count == 0 || w.Ela < a.MinUs {
			a.MinUs = w.Ela
		}
		if w.Ela > a.MaxUs {
			a.MaxUs = w.Ela
		}
		a.Count++
		a.Us += w.Ela
		return true
	})
	if err != nil {
		return nil, err
	}
	out := aggs[:0]
	for _, a := range aggs {
		if a.Count > 0 {
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Us > out[j].Us })
	return out, nil
}

// KeyAgg is a generic group-by result.
type KeyAgg struct {
	Key   int64 `json:"key"`
	Count int64 `json:"count"`
	Us    int64 `json:"us"`
}

// WaitsBy groups waits by an integer key (object id, file#, ...).
func WaitsBy(m *model.Model, in func(*model.Wait) bool, key func(*model.Wait) (int64, bool)) []KeyAgg {
	out, _ := WaitsByOn(context.Background(), ModelFacts(m), Scan{}, in, key)
	return out
}

// WaitsByOn is WaitsBy over any Facts (sc narrows the scan to the rows in can accept).
func WaitsByOn(ctx context.Context, src Facts, sc Scan, in func(*model.Wait) bool, key func(*model.Wait) (int64, bool)) ([]KeyAgg, error) {
	acc := map[int64]*KeyAgg{}
	err := src.EachWait(ctx, sc, func(w *model.Wait) bool {
		if in != nil && !in(w) {
			return true
		}
		k, ok := key(w)
		if !ok {
			return true
		}
		a := acc[k]
		if a == nil {
			a = &KeyAgg{Key: k}
			acc[k] = a
		}
		a.Count++
		a.Us += w.Ela
		return true
	})
	if err != nil {
		return nil, err
	}
	out := make([]KeyAgg, 0, len(acc))
	for _, a := range acc {
		out = append(out, *a)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Us != out[j].Us {
			return out[i].Us > out[j].Us
		}
		return out[i].Key < out[j].Key
	})
	return out, nil
}

// Execution groups one EXEC with its FETCH calls.
type Execution struct {
	Cursor    model.ID   `json:"cursor"`
	Statement model.ID   `json:"statement"`
	ExecNo    int32      `json:"execNo"`
	Exec      model.ID   `json:"exec"`
	Fetches   []model.ID `json:"fetches"`
	BindSet   model.ID   `json:"bindSet"`
	Stats     CallStats  `json:"stats"`
	StartTim  int64      `json:"startTim"`
	EndTim    int64      `json:"endTim"`
	WallUs    int64      `json:"wallUs"`
	Context   model.ID   `json:"context"`
	Line      int32      `json:"-"` // trace line of the EXEC
}

// Executions lists the executions of one statement in file order.
func Executions(m *model.Model, sid model.ID) []Execution {
	if AggOf(m) != nil {
		return nil // no per-execution facts: see ExecSummaryOf
	}
	out, _ := ExecutionsOn(context.Background(), m, ModelFacts(m), sid)
	return out
}

// ExecutionsOn is Executions over any Facts (m for the PX contexts and wall
// clock anchors).
func ExecutionsOn(ctx context.Context, m *model.Model, src Facts, sid model.ID) ([]Execution, error) {
	var out []Execution
	idx := map[[2]int64]int{} // cursor,execNo -> index
	err := src.EachCall(ctx, Scan{Statements: []model.ID{sid}}, func(c *model.Call) bool {
		if c.Statement != sid || m.PXChild(c.Context) {
			return true
		}
		switch c.Kind {
		case trace.CallExec:
			e := Execution{Cursor: c.Cursor, Statement: sid, ExecNo: c.ExecNo, Exec: c.ID, BindSet: c.BindSet, StartTim: c.Tim - c.E, EndTim: c.Tim, WallUs: m.CallWall(c) - c.E, Context: c.Context, Line: c.Line}
			e.Stats.add(c)
			idx[[2]int64{int64(c.Cursor), int64(c.ExecNo)}] = len(out)
			out = append(out, e)
		case trace.CallFetch:
			if j, ok := idx[[2]int64{int64(c.Cursor), int64(c.ExecNo)}]; ok {
				e := &out[j]
				e.Fetches = append(e.Fetches, c.ID)
				e.Stats.add(c)
				if c.Tim > e.EndTim {
					e.EndTim = c.Tim
				}
			}
		}
		return true
	})
	return out, err
}

// ExecInfo is an execution seen by EachExecution: the EXEC and the sum of its
// FETCHes, without the list of fetch calls.
type ExecInfo struct {
	Execution
	Seq        int // position among the statement's executions in file order
	NumFetches int
}

// EachExecution calls fn once for every execution of a statement (the ones
// Executions lists) in the order they are complete, not in file order: an
// execution is complete when the next EXEC of its cursor comes (or at the end).
// Memory is that of the open executions, one per cursor, however many
// executions the statement has. e is only valid during the call.
func EachExecution(ctx context.Context, m *model.Model, src Facts, sid model.ID, fn func(e *ExecInfo)) error {
	open := map[model.ID]*ExecInfo{} // cursor -> its latest execution; only that one can still get fetches
	seq := 0
	err := src.EachCall(ctx, Scan{Statements: []model.ID{sid}}, func(c *model.Call) bool {
		if c.Statement != sid || m.PXChild(c.Context) {
			return true
		}
		switch c.Kind {
		case trace.CallExec:
			e := open[c.Cursor]
			if e != nil {
				fn(e)
			} else {
				e = &ExecInfo{}
				open[c.Cursor] = e
			}
			*e = ExecInfo{Execution: Execution{Cursor: c.Cursor, Statement: sid, ExecNo: c.ExecNo, Exec: c.ID, BindSet: c.BindSet, StartTim: c.Tim - c.E,
				EndTim: c.Tim, WallUs: m.CallWall(c) - c.E, Context: c.Context, Line: c.Line}, Seq: seq}
			seq++
			e.Stats.add(c)
		case trace.CallFetch:
			if e := open[c.Cursor]; e != nil && e.ExecNo == c.ExecNo {
				e.NumFetches++
				e.Stats.add(c)
				if c.Tim > e.EndTim {
					e.EndTim = c.Tim
				}
			}
		}
		return true
	})
	if err != nil {
		return err
	}
	for _, e := range open { // map order: the consumer must not depend on it
		fn(e)
	}
	return nil
}

// Bucket is one slice of the timeline.
type Bucket struct {
	StartUs int64 `json:"startUs"` // wall-clock µs (or tim when no anchor)
	Calls   int64 `json:"calls"`
	CPUUs   int64 `json:"cpuUs"`
	ElaUs   int64 `json:"elaUs"`
	WaitUs  int64 `json:"waitUs"`
	IdleUs  int64 `json:"idleUs"`
	Disk    int64 `json:"disk"`
	Query   int64 `json:"query"`
	Rows    int64 `json:"rows"`
}

// Timeline buckets top-level call activity and waits by their completion time.
func Timeline(m *model.Model, bucketUs int64) []Bucket {
	if a := AggOf(m); a != nil {
		return a.timeline(bucketUs)
	}
	if bucketUs <= 0 || m.Span.Us() == 0 {
		return nil
	}
	n := int(m.Span.Us()/bucketUs) + 1
	if n > 100000 {
		return nil
	}
	out := make([]Bucket, n)
	base := m.Span.FirstTim
	for i := range out {
		out[i].StartUs = m.WallOf(base + int64(i)*bucketUs)
		if out[i].StartUs == 0 {
			out[i].StartUs = base + int64(i)*bucketUs
		}
	}
	for i := range m.Calls {
		c := &m.Calls[i]
		if c.Tim == 0 {
			continue
		}
		b := &out[int((c.Tim-base)/bucketUs)]
		b.Calls++
		if c.Parent == model.None {
			b.CPUUs += c.C
			b.ElaUs += c.E
		}
		b.Disk += c.P
		b.Query += c.CR
		b.Rows += c.R
	}
	for i := range m.Waits {
		w := &m.Waits[i]
		if w.Tim == 0 {
			continue
		}
		b := &out[int((w.Tim-base)/bucketUs)]
		if w.Idle || w.Between {
			b.IdleUs += w.Ela
		} else {
			b.WaitUs += w.Ela
		}
	}
	return out
}
