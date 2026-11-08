package engine

import (
	"bytes"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/ref"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

// The names script and its pasted output (refpaste: GET api/ref, GET
// api/ref/script, POST api/ref/paste), with the outputs the script printed on
// the lab (internal/ref/testdata).
func TestRefPaste(t *testing.T) {
	e, ts := newServed(t)
	trace := traces + "io_waits.trc"
	s := openTS(t, ts, trace)
	base := "/s/" + s.ID + "/api/ref"
	status := func() RefStatus {
		t.Helper()
		r := call(t, ts, "GET", base, nil)
		if r.code != 200 {
			t.Fatalf("status %d %s", r.code, r.body)
		}
		return decode[RefStatus](t, r.body)
	}
	wanted := report.RefCounts{Objects: 7, Files: 3, Users: 2, Plans: 23}
	if st := status(); st.Wanted != wanted || st.Named != (report.RefCounts{}) || st.Stored || st.Job != nil || st.Rev != 1 {
		t.Errorf("before: %+v", st)
	}

	r := call(t, ts, "GET", base+"/script", nil)
	sc := decode[RefScript](t, r.body)
	if r.code != 200 || sc.Name != "names-io_waits.sql" || sc.Plans || sc.Wanted != wanted ||
		!strings.Contains(sc.Script, "push(objs, sys.odcinumberlist(720, 721, 108609") || strings.Contains(sc.Script, "dbms_xplan") {
		t.Errorf("script %d %+v", r.code, sc.Name)
	}
	if sc := decode[RefScript](t, call(t, ts, "GET", base+"/script?plans=true", nil).body); !sc.Plans || !strings.Contains(sc.Script, "dbms_xplan.display_cursor") {
		t.Error("?plans=true: no plan section")
	}
	if r := call(t, ts, "GET", base+"/script?plans=maybe", nil); r.code != 400 {
		t.Errorf("plans=maybe: %d", r.code)
	}

	paste := func(name string) RefPasted {
		t.Helper()
		raw, err := os.ReadFile("../ref/testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		r := call(t, ts, "POST", base+"/paste", map[string]any{"text": string(raw)})
		if r.code != 202 {
			t.Fatalf("paste %s: %d %s", name, r.code, r.body)
		}
		p := decode[RefPasted](t, r.body)
		if j := waitJob(t, ts, p.Job.ID); j.State != JobDone || !strings.Contains(j.Message, "pasted") {
			t.Fatalf("paste job %+v", j)
		}
		return p
	}
	// as the schema owner: what ALL_ views show, and the notes that say so
	p := paste("paste_io_waits_mtk.txt")
	if p.Read != (report.RefCounts{Objects: 5, Users: 2}) || !p.Complete || len(p.Notes) != 4 || p.Job.Kind != "ref" {
		t.Errorf("mtk paste %+v", p)
	}
	if st := status(); st.Named != (report.RefCounts{Objects: 5, Users: 2}) || !st.Stored || st.Rev != 2 || st.Job == nil || st.Job.State != JobDone {
		t.Errorf("after mtk: %+v", st)
	}
	// as SYSDBA: everything; merged with the kept names
	paste("paste_io_waits_sysdba.txt")
	if st := status(); st.Named != (report.RefCounts{Objects: 7, Files: 3, Users: 2, Plans: 6}) || st.Rev != 3 {
		t.Errorf("after sysdba: %+v", st)
	}
	d := docMasked(t, ts, s.ID)
	if !bytes.Equal(d, expectedDoc(t, e, trace, "../ref/testdata/paste_io_waits_sysdba.txt")) {
		t.Error("document after the pastes differs from the paste applied directly (LoadBundle of the file)")
	}
	// a paste replaces what it has and keeps the rest (the plans, the datafiles)
	paste("paste_io_waits_mtk.txt")
	if st := status(); st.Named != (report.RefCounts{Objects: 7, Files: 3, Users: 2, Plans: 6}) || st.Rev != 4 || !bytes.Equal(docMasked(t, ts, s.ID), d) {
		t.Errorf("the second mtk paste dropped names: %+v", st)
	}

	// requests
	for name, body := range map[string]any{
		"no names": map[string]any{"text": "SQL> select 1 from dual;\n"},
		"empty":    map[string]any{"text": ""},
		"unknown":  map[string]any{"text": "x", "dir": "/tmp"},
	} {
		if r := call(t, ts, "POST", base+"/paste", body); r.code != 400 {
			t.Errorf("%s: %d %s", name, r.code, r.body)
		}
	}
	r = call(t, ts, "POST", base+"/paste", map[string]any{"text": "mtkprof-ref 1\nnote,\"objects: ORA-00942: table or view does not exist\"\n"})
	if r.code != 400 || !strings.Contains(string(r.body), "the script said: objects: ORA-00942") {
		t.Errorf("only notes: %d %s", r.code, r.body)
	}
}

// A bundle reaches every open session of the trace: the other tab of the same
// files reloads (session event, rev + 1), and a session that was still
// opening when the bundle was stored applies it once it is ready.
func TestRefSameTrace(t *testing.T) {
	e, ts := newServed(t)
	trace := traces + "io_waits.trc"
	s1 := openTS(t, ts, trace)
	s2 := openTS(t, ts, trace)
	if s1.ID == s2.ID || s1.Identity != s2.Identity {
		t.Fatalf("want two sessions of one trace: %+v %+v", s1, s2)
	}
	ev := openSSE(t, ts)
	raw, err := os.ReadFile("../ref/testdata/paste_io_waits_sysdba.txt")
	if err != nil {
		t.Fatal(err)
	}
	r := call(t, ts, "POST", "/s/"+s1.ID+"/api/ref/paste", map[string]any{"text": string(raw)})
	if r.code != 202 {
		t.Fatalf("paste %d %s", r.code, r.body)
	}
	j := waitJob(t, ts, decode[RefPasted](t, r.body).Job.ID)
	if j.State != JobDone || !strings.Contains(j.Message, "also applied to 1 other open session of the trace") {
		t.Errorf("job %+v", j)
	}
	if sessionRev(t, ts, s2.ID) != 2 {
		t.Errorf("the other session's rev %d", sessionRev(t, ts, s2.ID))
	}
	if !bytes.Equal(docMasked(t, ts, s2.ID), docMasked(t, ts, s1.ID)) {
		t.Error("the other session's document lacks the names")
	}
	named := report.RefCounts{Objects: 7, Files: 3, Users: 2, Plans: 6}
	if st := decode[RefStatus](t, call(t, ts, "GET", "/s/"+s2.ID+"/api/ref", nil).body); st.Named != named {
		t.Errorf("other session named %+v", st.Named)
	}
	deadline := time.Now().Add(10 * time.Second)
	seen := false
	for !seen && time.Now().Before(deadline) {
		if typ, data := ev.next(); typ == "session" {
			se := decode[SessionEvent](t, []byte(data))
			seen = se.ID == s2.ID && se.Rev == 2
		}
	}
	if !seen {
		t.Error("no session event for the other session")
	}

	// the race catchUpRef closes: a commit stored a bundle while a session's build
	// ran (the commit found no model to apply it to)
	s3 := openTS(t, ts, trace)
	ss3 := e.srv.sessions[s3.ID]
	mtk, err := os.ReadFile("../ref/testdata/paste_io_waits_mtk.txt")
	if err != nil {
		t.Fatal(err)
	}
	dir := e.srv.refDir(ss3)
	os.RemoveAll(dir)
	if err := ref.WriteBundle(ref.ParsePaste(string(mtk)).Bundle, dir); err != nil {
		t.Fatal(err)
	}
	e.srv.refMu.Lock()
	e.srv.refGen[ss3.identity]++
	e.srv.refMu.Unlock()
	e.srv.catchUpRef(ss3)
	if st := decode[RefStatus](t, call(t, ts, "GET", "/s/"+s3.ID+"/api/ref", nil).body); st.Named != (report.RefCounts{Objects: 5, Users: 2}) || st.Rev != 2 {
		t.Errorf("after the catch-up %+v", st)
	}
	e.srv.catchUpRef(ss3) // up to date: nothing
	if rev := sessionRev(t, ts, s3.ID); rev != 2 {
		t.Errorf("a second catch-up applied again: rev %d", rev)
	}
}
