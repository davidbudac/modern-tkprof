package engine

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/cut"
)

// The cut routes on a spilled session: a window of io_waits.trc plans,
// checks and downloads; a session with redacted binds refuses binds=keep and
// writes its bind values masked.
func TestCutRoutes(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{traces + "io_waits.trc"}, nil)
	base := "/s/" + sid + "/api/cut"
	// 11:35:34.880 - 11:35:35.300 of the trace, as tim (the mock-up's window)
	q := "?from=10810188000&to=10810608000"
	var p cut.Plan
	if r := e.req("GET", base+q, nil); r.code != 200 {
		t.Fatalf("plan: %d %s", r.code, r.body)
	} else if err := json.Unmarshal(r.body, &p); err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, pc := range p.Pieces {
		kinds = append(kinds, pc.Kind+":"+pc.Title)
	}
	if got := strings.Join(kinds, " "); !strings.Contains(got, "before:Cursor 10gywwmwk6xfy") || !strings.Contains(got, "after:Plan of 7r10y07tqpg98") {
		t.Errorf("pieces %s", got)
	}
	if strings.Join(p.BindsAllowed, ",") != "keep,mask,none" {
		t.Errorf("binds allowed %v", p.BindsAllowed)
	}
	var ck cut.Check
	if r := e.req("GET", base+"/check"+q, nil); r.code != 200 {
		t.Fatalf("check: %d %s", r.code, r.body)
	} else if err := json.Unmarshal(r.body, &ck); err != nil || !ck.OK {
		t.Fatalf("check %+v %v", ck, err)
	}
	// force=1 (check a file over the 1 GiB limit too) is a parameter of the route; anything but 0|1 is a 400
	if r := e.req("GET", base+"/check"+q+"&force=1", nil); r.code != 200 {
		t.Fatalf("check force=1: %d %s", r.code, r.body)
	} else if err := json.Unmarshal(r.body, &ck); err != nil || !ck.OK {
		t.Fatalf("check force=1 %+v %v", ck, err)
	}
	if r := e.req("GET", base+"/check"+q+"&force=yes", nil); r.code != 400 {
		t.Errorf("check force=yes: %d %s", r.code, r.body)
	}
	r := e.req("GET", base+"/file"+q, nil)
	if r.code != 200 || !strings.Contains(r.hdr.Get("Content-Disposition"), `filename="io_waits-cut.trc"`) {
		t.Fatalf("file: %d %v", r.code, r.hdr)
	}
	if n := int64(strings.Count(string(r.body), "\n")); n != p.Lines || int64(len(r.body)) != p.Bytes {
		t.Errorf("file has %d lines %d bytes, the plan %d lines %d bytes", n, len(r.body), p.Lines, p.Bytes)
	}
	if r := e.req("GET", base+"?edges=whole", nil); r.code != 400 {
		t.Errorf("edges=whole: %d", r.code)
	}

	red := e.openReady([]string{traces + "basic_binds.trc"}, map[string]any{"binds": "redact"})
	rb := "/s/" + red + "/api/cut"
	if r := e.req("GET", rb+"?binds=keep", nil); r.code != 400 {
		t.Errorf("redacted session, binds=keep: %d %s", r.code, r.body)
	}
	f := e.req("GET", rb+"/file", nil)
	if f.code != 200 || !strings.Contains(string(f.body), `value="<`) {
		t.Fatalf("redacted session: %d, no masked value", f.code)
	}
	for _, l := range strings.Split(string(f.body), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(l), "value="); ok && !strings.HasPrefix(v, `"<`) {
			t.Fatalf("redacted session wrote a bind value: %q", l)
		}
	}
}
