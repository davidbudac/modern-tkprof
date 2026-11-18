package slice

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/diag"
)

const diagHeapFixture = "../../testdata/diag/19c/diag_heap_pga.trc"

func diagGet(t *testing.T, h http.Handler, target string) (int, []byte) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec.Code, rec.Body.Bytes()
}

// TestDiagServerReadings: the reading routes of a diag file, their errors, and the nil server.
func TestDiagServerReadings(t *testing.T) {
	d := NewDiagServer(diagHeapFixture, nil, nil)
	defer d.Close()
	h := d.Handler()
	sc, err := d.Scan()
	if err != nil {
		t.Fatal(err)
	}
	heap := sc.File.Outline[1]
	if heap.Reading != "heap" {
		t.Fatalf("node %+v", heap)
	}
	code, body := diagGet(t, h, "/api/diag/reading?node="+heap.ID)
	if code != 200 || !strings.HasPrefix(string(body), `{"kind":"heap","node":`) {
		t.Fatalf("reading: %d %.100s", code, body)
	}
	var hr diag.HeapReading
	if err := json.Unmarshal(body, &hr); err != nil || hr.Name != "pga heap" || len(hr.Checks) != 3 || hr.Checks[0].State != "match" {
		t.Fatalf("reading: %v %+v", err, hr.Checks)
	}
	// the lines of a comment: all of its chunks, then the same in pages of the bound
	code, body = diagGet(t, h, "/api/diag/reading/lines?node="+heap.ID+"&comment=perm&type=perm")
	var hl diag.HeapLines
	if err := json.Unmarshal(body, &hl); err != nil || code != 200 || hl.Total != 40 || len(hl.Lines) != 40 || hl.More != 0 {
		t.Fatalf("reading/lines: %d %v %+v", code, err, hl)
	}
	code, body = diagGet(t, h, "/api/diag/reading/lines?node="+heap.ID+"&comment=perm&after="+itoa(hl.Lines[9]))
	json.Unmarshal(body, &hl)
	if code != 200 || len(hl.Lines) != 30 || hl.Total != 40 {
		t.Errorf("after the 10th line: %d lines of %d", len(hl.Lines), hl.Total)
	}
	// a blank comment is a free chunk's
	code, body = diagGet(t, h, "/api/diag/reading/lines?node="+heap.ID+"&comment=")
	json.Unmarshal(body, &hl)
	if code != 200 || hl.Total != 10 {
		t.Errorf("blank comment: %d %d", code, hl.Total)
	}
	for target, want := range map[string]int{
		"/api/diag/reading":                                                    400,
		"/api/diag/reading?node=nonsense":                                      404,
		"/api/diag/reading?node=root":                                          404,
		"/api/diag/reading?node=" + sc.File.Outline[0].ID:                      404,
		"/api/diag/reading/lines":                                              400,
		"/api/diag/reading/lines?node=" + heap.ID:                              400,
		"/api/diag/reading/lines?node=x&comment=a":                             404,
		"/api/diag/reading/lines?node=" + sc.File.Outline[0].ID + "&comment=a": 404,
		"/api/diag/reading/lines?node=" + heap.ID + "&comment=a&after=-3":      400,
	} {
		code, body := diagGet(t, h, target)
		var env struct {
			Error struct{ Code, Message string }
		}
		if code != want || json.Unmarshal(body, &env) != nil || env.Error.Code == "" {
			t.Errorf("%s: %d %s, want %d with an envelope", target, code, body, want)
		}
	}
	if code, body := diagGet(t, h, "/api/diag/reading?node="+sc.File.Outline[0].ID); !strings.Contains(string(body), "no reading for this kind of section") || code != 404 {
		t.Errorf("header: %d %s", code, body)
	}
	// a session that is not a diag one: every route answers 404 "not a diag session"
	var none *DiagServer
	for target, h := range map[string]http.Handler{"/api/diag/reading?node=x": none.ReadingHandler(), "/api/diag/reading/lines?node=x&comment=a": none.ReadingLinesHandler()} {
		code, body := diagGet(t, h, target)
		if code != 404 || !strings.Contains(string(body), "not a diag session") {
			t.Errorf("nil server %s: %d %s", target, code, body)
		}
	}
	for target, h := range map[string]http.Handler{"/api/diag/path?line=3": none.PathHandler()} {
		code, body := diagGet(t, h, target)
		if code != 404 || !strings.Contains(string(body), "not a diag session") {
			t.Errorf("nil server %s: %d %s", target, code, body)
		}
	}
	if got := DiagRoutes(); len(got) != 5 || got[2] != "/api/diag/reading" || got[3] != "/api/diag/reading/lines" || got[4] != "/api/diag/path" {
		t.Errorf("routes %v", got)
	}
}

// TestDiagServerPath: api/diag/path answers the chain of nodes of a line or of a node, and its errors.
func TestDiagServerPath(t *testing.T) {
	const fx = "../../testdata/diag/19c/diag_sysstate_l1.trc"
	d := NewDiagServer(fx, nil, nil)
	defer d.Close()
	h := d.Handler()
	sc, err := d.Scan()
	if err != nil {
		t.Fatal(err)
	}
	var sys diag.Node
	for _, n := range sc.File.Outline {
		if n.Kind == "sysstate" {
			sys = n
		}
	}
	if sys.ID == "" || sys.Reading != "sysstate" {
		t.Fatalf("no system state node with a reading: %+v", sys)
	}
	// a line deep inside the process 61 of the system state, which a client has not loaded
	code, body := diagGet(t, h, "/api/diag/path?line=18559")
	var p diag.Path
	if err := json.Unmarshal(body, &p); err != nil || code != 200 || len(p.Nodes) < 3 {
		t.Fatalf("path: %d %v %s", code, err, body)
	}
	if p.Nodes[0].ID != sys.ID || p.Nodes[1].Kind != "process" || p.Nodes[1].N != 61 {
		t.Errorf("path %+v", p.Nodes)
	}
	last := p.Nodes[len(p.Nodes)-1]
	if last.From > 18559 || last.To < 18559 {
		t.Errorf("the deepest node %+v does not hold the line", last)
	}
	// the same chain by node id
	code, body = diagGet(t, h, "/api/diag/path?node="+p.Nodes[1].ID)
	var q diag.Path
	if err := json.Unmarshal(body, &q); err != nil || code != 200 || len(q.Nodes) != 2 || q.Nodes[1].ID != p.Nodes[1].ID {
		t.Errorf("path by node: %d %v %s", code, err, body)
	}
	for target, want := range map[string]int{
		"/api/diag/path":                       400,
		"/api/diag/path?line=zero":             400,
		"/api/diag/path?line=0":                400,
		"/api/diag/path?line=-4":               400,
		"/api/diag/path?line=99999999":         404,
		"/api/diag/path?node=nonsense":         404,
		"/api/diag/path?node=process:5-9:1:ff": 404,
	} {
		code, body := diagGet(t, h, target)
		var env struct {
			Error struct{ Code, Message string }
		}
		if code != want || json.Unmarshal(body, &env) != nil || env.Error.Code == "" {
			t.Errorf("%s: %d %s, want %d with an envelope", target, code, body, want)
		}
	}
	// the readings of the three new kinds over the route
	code, body = diagGet(t, h, "/api/diag/reading?node="+sys.ID)
	if code != 200 || !strings.HasPrefix(string(body), `{"kind":"sysstate","node":`) {
		t.Errorf("sysstate reading: %d %.100s", code, body)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }
