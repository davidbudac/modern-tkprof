package slice

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

const optTwoTrace = "../../testdata/opt/19c/opt_two.trc"

func optGet(h http.Handler, method, path string) (int, http.Header, string) {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	b, _ := io.ReadAll(rec.Body)
	return rec.Code, rec.Header(), string(b)
}

// TestOptServer: the two routes over a line index, and over the reader the server makes itself.
func TestOptServer(t *testing.T) {
	b, err := os.ReadFile(optTwoTrace)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
	li, err := trace.OpenLineIndex(optTwoTrace)
	if err != nil {
		t.Fatal(err)
	}
	defer li.Close()
	for name, o := range map[string]*OptServer{"line index": NewOptServer(optTwoTrace, nil, li), "own reader": NewOptServer(optTwoTrace, nil, nil)} {
		t.Run(name, func(t *testing.T) {
			defer o.Close()
			h := o.Handler()
			sc, err := o.Scan()
			if err != nil || len(sc.Dumps) != 2 {
				t.Fatalf("scan: %v", err)
			}
			if ids := o.SQLIDs(); len(ids) != 2 || ids[0] != sc.Dumps[0].SQLID {
				t.Errorf("SQLIDs %v", ids)
			}
			for i, d := range sc.Dumps {
				code, hdr, body := optGet(h, "GET", "/api/opt/text?i="+string(rune('0'+i)))
				got := strings.Split(body, "\n")
				if code != 200 || !strings.HasPrefix(hdr.Get("Content-Type"), "text/plain") || len(got) != d.LineCount ||
					got[0] != lines[d.ViewFrom-1] || got[len(got)-1] != lines[d.ViewTo-1] {
					t.Errorf("text %d: %d %d lines, want %d", i, code, len(got), d.LineCount)
				}
				code, hdr, body = optGet(h, "GET", "/api/opt/dump?i="+string(rune('0'+i)))
				if code != 200 || hdr.Get("Content-Type") != "application/json" || !strings.Contains(body, `"sqlId":"`+d.SQLID+`"`) {
					t.Errorf("dump %d: %d", i, code)
				}
				if hdr.Get("Access-Control-Allow-Origin") != "*" {
					t.Errorf("no CORS header")
				}
			}
			for _, p := range []string{"/api/opt/dump?i=2", "/api/opt/text?i=-1", "/api/opt/dump", "/api/opt/text?i=a"} {
				if code, _, _ := optGet(h, "GET", p); code != 404 {
					t.Errorf("%s: %d", p, code)
				}
			}
			if code, _, _ := optGet(h, "POST", "/api/opt/dump?i=0"); code != 405 {
				t.Errorf("POST: %d", code)
			}
			if code, hdr, _ := optGet(h, "OPTIONS", "/api/opt/dump?i=0"); code != 204 || hdr.Get("Access-Control-Allow-Methods") == "" {
				t.Errorf("OPTIONS: %d", code)
			}
		})
	}
	// no CORS of its own (the engine's middleware sets it)
	o := NewOptServer(optTwoTrace, nil, li)
	o.AllowOrigin = NoCORS
	if _, hdr, _ := optGet(o.Handler(), "GET", "/api/opt/dump?i=0"); hdr.Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("NoCORS sets a header")
	}
	// a server for a file that is not a 10053 one
	var none *OptServer
	if code, _, _ := optGet(none.Handler(), "GET", "/api/opt/dump?i=0"); code != 404 {
		t.Errorf("nil server: %d", code)
	}
}
