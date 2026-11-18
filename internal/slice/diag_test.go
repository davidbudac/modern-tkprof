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
	if got := DiagRoutes(); len(got) != 4 || got[2] != "/api/diag/reading" || got[3] != "/api/diag/reading/lines" {
		t.Errorf("routes %v", got)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }
