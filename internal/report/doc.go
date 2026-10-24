package report

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// Version is stamped into reports by the build (see Makefile LDFLAGS).
var Version = "0.1.0-dev"

// Document is the payload consumed by the web UI: dimension tables as
// objects, fact tables as columns, plus the standard aggregations.
type Document struct {
	Tool      string    `json:"tool"`
	Version   string    `json:"version"`
	Generated time.Time `json:"generated"`
	Format    int       `json:"format"` // bump when the layout changes

	File         model.FileInfo      `json:"file"`
	Span         model.Span          `json:"span"`
	Statements   []model.Statement   `json:"statements"`
	Cursors      []model.Cursor      `json:"cursors"`
	Contexts     []model.Context     `json:"contexts"`
	Events       []model.Event       `json:"events"`
	Plans        []model.Plan        `json:"plans"`
	PlanLines    []model.PlanLine    `json:"planLines"`
	Transactions []model.Transaction `json:"transactions"`
	Errors       []model.ErrorEvent  `json:"errors"`
	Markers      []model.Marker      `json:"markers"`
	Diag         model.Diagnostics   `json:"diag"`
	Unknown      []model.UnknownLine `json:"unknown"`

	// Reference-bundle dimensions (mtkprof -ref): names for the obj#, file#
	// and user ids that the fact tables carry. Omitted without a bundle.
	Objects []model.RefObject `json:"objects,omitempty"`
	Files   []model.RefFile   `json:"files,omitempty"`
	Users   []model.RefUser   `json:"users,omitempty"`

	Facts *Facts `json:"facts,omitempty"`

	Stats Stats `json:"stats"`

	// PlanViz is the base URL of the plan visualizer ("Open in plan viz");
	// empty means the UI uses its own default.
	PlanViz string `json:"planViz,omitempty"`

	// Slice says that the server that sent this document answers the
	// /api/pivot, /api/timeline, ... queries (internal/slice), so a document
	// without fact tables is still fully interactive.
	Slice bool `json:"slice,omitempty"`
}

// Facts are the columnar fact tables as plain JSON arrays. The packed form
// (every numeric column of a table in one gzip+base64 blob, see stream.go) is
// only written by WriteDocument; Packed is true on documents carrying it.
type Facts struct {
	Packed   bool           `json:"packed"`
	Calls    CallColumns    `json:"calls"`
	Waits    WaitColumns    `json:"waits"`
	BindSets BindSetColumns `json:"bindSets"`
	Binds    BindColumns    `json:"binds"`

	stream bool // marshals as a placeholder; see writeDocument
}

// MarshalJSON writes the plain struct, or the placeholder that writeDocument
// replaces with the streamed tables.
func (f *Facts) MarshalJSON() ([]byte, error) {
	if f.stream {
		return json.Marshal(factsPlaceholder)
	}
	type plain Facts
	return json.Marshal((*plain)(f))
}

// CallColumns: one entry per model.Call, same order/index.
type CallColumns struct {
	N       int    `json:"n"`
	Line    Column `json:"line"`
	Kind    Column `json:"kind"`
	Cursor  Column `json:"cursor"`
	Stmt    Column `json:"stmt"`
	C       Column `json:"c"`
	E       Column `json:"e"`
	P       Column `json:"p"`
	CR      Column `json:"cr"`
	CU      Column `json:"cu"`
	Mis     Column `json:"mis"`
	R       Column `json:"r"`
	Dep     Column `json:"dep"`
	OG      Column `json:"og"`
	PLH     Column `json:"plh"`
	Tim     Column `json:"tim"`
	Type    Column `json:"type"`
	Parent  Column `json:"parent"`
	SelfE   Column `json:"selfE"`
	SelfC   Column `json:"selfC"`
	SelfP   Column `json:"selfP"`
	SelfCR  Column `json:"selfCR"`
	SelfCU  Column `json:"selfCU"`
	Ctx     Column `json:"ctx"`
	ExecNo  Column `json:"execNo"`
	BindSet Column `json:"bindSet"`
	WaitEla Column `json:"waitEla"`
	IdleEla Column `json:"idleEla"`
	NWaits  Column `json:"nWaits"`
	Flags   Column `json:"flags"` // bit0 orphan, bit1 synthetic
}

// WaitColumns: one entry per model.Wait.
type WaitColumns struct {
	N      int    `json:"n"`
	Line   Column `json:"line"`
	Cursor Column `json:"cursor"`
	Stmt   Column `json:"stmt"`
	Call   Column `json:"call"`
	Event  Column `json:"event"`
	Ela    Column `json:"ela"`
	P1     Column `json:"p1"`
	P2     Column `json:"p2"`
	P3     Column `json:"p3"`
	Obj    Column `json:"obj"`
	Tim    Column `json:"tim"`
	Ctx    Column `json:"ctx"`
	Dep    Column `json:"dep"`
	Flags  Column `json:"flags"` // bit0 between calls, bit1 idle event
}

// BindSetColumns: one entry per model.BindSet.
type BindSetColumns struct {
	N      int    `json:"n"`
	Line   Column `json:"line"`
	Cursor Column `json:"cursor"`
	Stmt   Column `json:"stmt"`
	Call   Column `json:"call"`
	First  Column `json:"first"`
	Count  Column `json:"count"`
	Flags  Column `json:"flags"` // bit0 rpc
}

// BindColumns: one entry per model.Bind (strings stay JSON arrays).
type BindColumns struct {
	N     int      `json:"n"`
	Set   Column   `json:"set"`
	Pos   Column   `json:"pos"`
	Dty   Column   `json:"dty"`
	Type  []string `json:"type"`
	Value []string `json:"value"`
	Flags Column   `json:"flags"` // bit0 null, bit1 noDef, bit2 dump
	Mal   Column   `json:"mal"`
	Avl   Column   `json:"avl"`
}

// Stats are the pre-computed aggregations.
type Stats struct {
	Statements []analyze.StmtStats    `json:"statements"`
	Profile    analyze.Profile        `json:"profile"`
	Events     []analyze.EventAgg     `json:"events"`
	Timeline   []analyze.Bucket       `json:"timeline"`
	BucketUs   int64                  `json:"bucketUs"`
	Findings   []analyze.Finding      `json:"findings"`
	Contexts   []analyze.ContextStats `json:"contexts"` // per session context, in id order (Sessions view)

	FindingsConfig analyze.Thresholds `json:"findingsConfig"` // effective finding thresholds
}

// DocOptions control document generation.
type DocOptions struct {
	Facts  bool // include the fact tables
	Packed bool // pack fact columns into gzip+base64 blobs (WriteDocument, JSON, DocumentBytes)

	Thresholds *analyze.Thresholds // finding thresholds; nil = defaults

	PlanVizURL string // base URL of the plan visualizer, carried into Document.PlanViz

	Slice bool // the serving process answers the slicing API: sets Document.Slice
}

// BuildDocument assembles the document from a model. Fact tables, if asked
// for, are unpacked arrays whatever o.Packed says; WriteDocument writes the
// packed form without building it.
func BuildDocument(m *model.Model, o DocOptions) *Document {
	return buildDocument(m, o, o.Facts && !m.Aggregate)
}

// buildDocument is BuildDocument; withFacts says whether the fact tables are
// built in memory (the streaming writer sends them separately).
func buildDocument(m *model.Model, o DocOptions, withFacts bool) *Document {
	bucket := analyze.TimelineBucket(m)
	d := &Document{
		Tool: "mtkprof", Version: Version, Generated: time.Now(), Format: 3,
		File: m.File, Span: m.Span, Statements: m.Statements, Cursors: m.Cursors, Contexts: m.Contexts,
		Events: m.Events, Plans: m.Plans, PlanLines: m.PlanLines, Transactions: m.Transactions,
		Errors: m.Errors, Markers: m.Markers, Diag: m.Diag, Unknown: m.Unknown,
		Objects: m.Objects, Files: m.Files, Users: m.Users,
		Stats: Stats{
			Statements: analyze.Statements(m),
			Profile:    analyze.TraceProfile(m),
			Events:     analyze.WaitsByEvent(m, nil),
			Timeline:   analyze.Timeline(m, bucket),
			BucketUs:   bucket,
			Contexts:   analyze.Contexts(m),
		},
	}
	th := analyze.DefaultThresholds()
	if o.Thresholds != nil {
		th = *o.Thresholds
	}
	d.Stats.FindingsConfig = th
	d.Stats.Findings = analyze.FindingsWith(m, d.Stats.Statements, th)
	for i := range d.Statements {
		if d.Statements[i].Cursors == nil {
			d.Statements[i].Cursors = []model.ID{}
		}
	}
	if withFacts {
		d.Facts = buildFacts(m)
	}
	d.PlanViz = o.PlanVizURL
	d.Slice = o.Slice
	return d
}

func buildFacts(m *model.Model) *Facts {
	calls := m.Calls
	n := len(calls)
	cc := CallColumns{N: n,
		Line:    i32col(n, func(i int) int64 { return int64(calls[i].Line) }),
		Kind:    u8col(n, func(i int) uint8 { return uint8(calls[i].Kind) }),
		Cursor:  i32col(n, func(i int) int64 { return int64(calls[i].Cursor) }),
		Stmt:    i32col(n, func(i int) int64 { return int64(calls[i].Statement) }),
		C:       i32col(n, func(i int) int64 { return calls[i].C }),
		E:       i32col(n, func(i int) int64 { return calls[i].E }),
		P:       i32col(n, func(i int) int64 { return calls[i].P }),
		CR:      i32col(n, func(i int) int64 { return calls[i].CR }),
		CU:      i32col(n, func(i int) int64 { return calls[i].CU }),
		Mis:     i32col(n, func(i int) int64 { return int64(calls[i].Mis) }),
		R:       i32col(n, func(i int) int64 { return calls[i].R }),
		Dep:     u8col(n, func(i int) uint8 { return uint8(calls[i].Dep) }),
		OG:      u8col(n, func(i int) uint8 { return uint8(calls[i].OG) }),
		PLH:     f64col(n, func(i int) int64 { return int64(calls[i].PLH) }),
		Tim:     f64col(n, func(i int) int64 { return calls[i].Tim }),
		Type:    u8col(n, func(i int) uint8 { return uint8(calls[i].Type) }),
		Parent:  i32col(n, func(i int) int64 { return int64(calls[i].Parent) }),
		SelfE:   i32col(n, func(i int) int64 { return calls[i].SelfE }),
		SelfC:   i32col(n, func(i int) int64 { return calls[i].SelfC }),
		SelfP:   i32col(n, func(i int) int64 { return calls[i].SelfP }),
		SelfCR:  i32col(n, func(i int) int64 { return calls[i].SelfCR }),
		SelfCU:  i32col(n, func(i int) int64 { return calls[i].SelfCU }),
		Ctx:     i32col(n, func(i int) int64 { return int64(calls[i].Context) }),
		ExecNo:  i32col(n, func(i int) int64 { return int64(calls[i].ExecNo) }),
		BindSet: i32col(n, func(i int) int64 { return int64(calls[i].BindSet) }),
		WaitEla: i32col(n, func(i int) int64 { return calls[i].WaitEla }),
		IdleEla: i32col(n, func(i int) int64 { return calls[i].IdleEla }),
		NWaits:  i32col(n, func(i int) int64 { return int64(calls[i].NWaits) }),
		Flags: u8col(n, func(i int) uint8 {
			var f uint8
			if calls[i].Orphan {
				f |= 1
			}
			if calls[i].Synthetic {
				f |= 2
			}
			return f
		}),
	}
	waits := m.Waits
	n = len(waits)
	wc := WaitColumns{N: n,
		Line:   i32col(n, func(i int) int64 { return int64(waits[i].Line) }),
		Cursor: i32col(n, func(i int) int64 { return int64(waits[i].Cursor) }),
		Stmt:   i32col(n, func(i int) int64 { return int64(waits[i].Statement) }),
		Call:   i32col(n, func(i int) int64 { return int64(waits[i].Call) }),
		Event:  i32col(n, func(i int) int64 { return int64(waits[i].Event) }),
		Ela:    i32col(n, func(i int) int64 { return waits[i].Ela }),
		P1:     f64col(n, func(i int) int64 { return waits[i].P1 }),
		P2:     f64col(n, func(i int) int64 { return waits[i].P2 }),
		P3:     f64col(n, func(i int) int64 { return waits[i].P3 }),
		Obj:    i32col(n, func(i int) int64 { return waits[i].ObjID }),
		Tim:    f64col(n, func(i int) int64 { return waits[i].Tim }),
		Ctx:    i32col(n, func(i int) int64 { return int64(waits[i].Context) }),
		Dep:    u8col(n, func(i int) uint8 { return uint8(waits[i].Dep) }),
		Flags: u8col(n, func(i int) uint8 {
			var f uint8
			if waits[i].Between {
				f |= 1
			}
			if waits[i].Idle {
				f |= 2
			}
			return f
		}),
	}
	sets := m.BindSets
	n = len(sets)
	sc := BindSetColumns{N: n,
		Line:   i32col(n, func(i int) int64 { return int64(sets[i].Line) }),
		Cursor: i32col(n, func(i int) int64 { return int64(sets[i].Cursor) }),
		Stmt:   i32col(n, func(i int) int64 { return int64(sets[i].Statement) }),
		Call:   i32col(n, func(i int) int64 { return int64(sets[i].Call) }),
		First:  i32col(n, func(i int) int64 { return int64(sets[i].First) }),
		Count:  i32col(n, func(i int) int64 { return int64(sets[i].N) }),
		Flags: u8col(n, func(i int) uint8 {
			if sets[i].IsRPC {
				return 1
			}
			return 0
		}),
	}
	binds := m.Binds
	n = len(binds)
	bc := BindColumns{N: n,
		Set:   i32col(n, func(i int) int64 { return int64(binds[i].Set) }),
		Pos:   i32col(n, func(i int) int64 { return int64(binds[i].Pos) }),
		Dty:   i32col(n, func(i int) int64 { return int64(binds[i].Dty) }),
		Type:  make([]string, n),
		Value: make([]string, n),
		Flags: u8col(n, func(i int) uint8 {
			var f uint8
			if binds[i].IsNull {
				f |= 1
			}
			if binds[i].NoDef {
				f |= 2
			}
			if binds[i].IsDump {
				f |= 4
			}
			return f
		}),
		Mal: i32col(n, func(i int) int64 { return int64(binds[i].Mal) }),
		Avl: i32col(n, func(i int) int64 { return int64(binds[i].Avl) }),
	}
	for i := range binds {
		bc.Type[i] = binds[i].TypeName()
		bc.Value[i] = binds[i].Value
	}
	return &Facts{Calls: cc, Waits: wc, BindSets: sc, Binds: bc}
}

// JSON writes the document to w (one line, newline-terminated).
func JSON(w io.Writer, m *model.Model, o DocOptions) error {
	bw := bufio.NewWriterSize(w, 256<<10)
	if err := writeDocument(bw, m, o); err != nil {
		return err
	}
	if _, err := bw.WriteString("\n"); err != nil {
		return err
	}
	return bw.Flush()
}

// DocumentBytes marshals the document (HTML-safe escaping, so it can be
// inlined in a <script> tag).
func DocumentBytes(m *model.Model, o DocOptions) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeDocument(&buf, m, o); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
