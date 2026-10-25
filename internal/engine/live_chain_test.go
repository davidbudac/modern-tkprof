package engine

import (
	"bytes"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/remote"
	"github.com/davidbudac/modern-tkprof/internal/remote/sshtest"
)

// chainFixture is the real two-file chain of midtrace_start: part 1 ends
// with "*** TRACE CONTINUES IN FILE .../<next> ***", part 2 is <next>.
func chainFixture(t *testing.T) (part1, part2 []byte, next string) {
	t.Helper()
	part1, err := os.ReadFile(traces + "midtrace_start_part1.trc")
	if err != nil {
		t.Fatal(err)
	}
	part2, err = os.ReadFile(traces + "midtrace_start.trc")
	if err != nil {
		t.Fatal(err)
	}
	const key = "*** TRACE CONTINUES IN FILE "
	i := bytes.Index(part1, []byte(key))
	if i < 0 {
		t.Fatal("no continuation marker in part 1")
	}
	ref := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(string(part1[i+len(key):][:bytes.IndexByte(part1[i:], '\n')-len(key)])), "***"))
	return part1, part2, filepath.Base(ref)
}

// logWatch collects the data of the engine's log events.
func logWatch(t *testing.T, ev *sse) <-chan string {
	ch := make(chan string, 100)
	go func() { // reads the stream itself: sse.next fails the test at its end
		typ := ""
		for ev.sc.Scan() {
			switch line := ev.sc.Text(); {
			case strings.HasPrefix(line, "event: "):
				typ = line[7:]
			case strings.HasPrefix(line, "data: ") && typ == "log":
				ch <- line[6:]
			case line == "":
				typ = ""
			}
		}
	}()
	return ch
}

func waitLog(t *testing.T, ch <-chan string, sub string) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case d := <-ch:
			if strings.Contains(d, sub) {
				return
			}
		case <-deadline:
			t.Fatalf("no log event with %q", sub)
		}
	}
}

// TestLiveFollowChain: a followed file that ends with TRACE CONTINUES IN is
// followed into the next file once it appears next to it; the snapshots
// list both files, every slice and line endpoint answers what a normal
// open of the chain answers, and a log event tells of the switch.
func TestLiveFollowChain(t *testing.T) {
	part1, part2, next := chainFixture(t)
	e, ts := newServed(t)
	logs := logWatch(t, openSSE(t, ts))
	dir := t.TempDir()
	p1, p2 := filepath.Join(dir, "part1.trc"), filepath.Join(dir, next)
	cut := lineCuts(part1, 0.5)[0]
	os.WriteFile(p1, part1[:cut], 0o644)
	r := e.open([]string{p1}, map[string]any{"follow": true, "batchMs": 50})
	le := &liveEnv{env: e, path: p1, id: r.Session.ID}
	le.waitBytes(cut)
	appendFile(t, p1, part1[cut:]) // ends with the marker; the next file is not there yet
	le.waitBytes(int64(len(part1)))
	waitLog(t, logs, "waiting for it")
	if si := le.info(); len(si.Files) != 1 || si.State != SessionLive {
		t.Fatalf("before the next file: %+v", si)
	}
	cut2 := lineCuts(part2, 0.4)[0]
	os.WriteFile(p2, part2[:cut2], 0o644)
	waitLog(t, logs, "continues in "+next+"; following it")
	si := le.waitBytes(int64(len(part1)) + cut2)
	if len(si.Files) != 2 || si.Files[1].Path != p2 || si.Files[0].Size != int64(len(part1)) || si.Files[1].Size != cut2 {
		t.Fatalf("files after the switch: %+v", si.Files)
	}
	appendFile(t, p2, part2[cut2:])
	si = le.waitBytes(int64(len(part1) + len(part2)))

	ref, m := reference(t, []string{p1}, model.BindsKeep, "")
	if len(m.File.Files) != 2 {
		t.Fatalf("the reference did not follow the chain: %d files", len(m.File.Files))
	}
	doc := le.req("GET", "/s/"+le.id+"/api/doc", nil)
	if want := get(ref, "/api/doc").body; !bytes.Equal(generatedRe.ReplaceAll(want, nil), generatedRe.ReplaceAll(doc.body, nil)) {
		t.Fatalf("document differs from a normal open of the chain (%d vs %d bytes)", len(want), len(doc.body))
	}
	n := 0
	for _, q := range queries(t, m, ref) {
		r, g := get(ref, q), le.req("GET", "/s/"+le.id+q, nil)
		if r.code != g.code || !bytes.Equal(r.body, g.body) {
			t.Errorf("%s: %d %.200s\nlive %d %.200s", q, r.code, r.body, g.code, g.body)
			continue
		}
		n++
	}
	t.Logf("%d answers equal, rev %d", n, si.Rev)
	if r := le.req("DELETE", "/engine/sessions/"+le.id, nil); r.code != 204 {
		t.Fatalf("delete %d", r.code)
	}
	if d := e.liveDirs(); len(d) != 0 {
		t.Errorf("spill left after DELETE: %v", d)
	}
}

// TestLiveFollowBackwardChain: a followed file that starts with TRACE
// CONTINUED FROM is read after the earlier file (found next to it by the
// name in its header); the snapshots list both, head to tail, and every
// slice and line endpoint answers what a normal open of the followed file
// (which pulls in the earlier one too) answers.
func TestLiveFollowBackwardChain(t *testing.T) {
	part1, part2, next := chainFixture(t)
	e, ts := newServed(t)
	logs := logWatch(t, openSSE(t, ts))
	dir := t.TempDir()
	p1, p2 := filepath.Join(dir, "part1.trc"), filepath.Join(dir, next)
	os.WriteFile(p1, part1, 0o644)
	cut := lineCuts(part2, 0.4)[0]
	os.WriteFile(p2, part2[:cut], 0o644)
	r := e.open([]string{p2}, map[string]any{"follow": true, "batchMs": 50})
	le := &liveEnv{env: e, path: p2, id: r.Session.ID}
	waitLog(t, logs, next+" continues part1.trc; reading it first")
	si := le.waitBytes(int64(len(part1)) + cut)
	if len(si.Files) != 2 || si.Files[0].Path != p1 || si.Files[1].Path != p2 || si.Files[0].Size != int64(len(part1)) || si.Files[1].Size != cut {
		t.Fatalf("files: %+v", si.Files)
	}
	appendFile(t, p2, part2[cut:])
	si = le.waitBytes(int64(len(part1) + len(part2)))

	ref, m := reference(t, []string{p2}, model.BindsKeep, "")
	if len(m.File.Files) != 2 || !m.File.Files[0].Followed {
		t.Fatalf("the reference did not follow the chain back: %+v", m.File.Files)
	}
	doc := le.req("GET", "/s/"+le.id+"/api/doc", nil)
	if want := get(ref, "/api/doc").body; !bytes.Equal(generatedRe.ReplaceAll(want, nil), generatedRe.ReplaceAll(doc.body, nil)) {
		t.Fatalf("document differs from a normal open of the followed file (%d vs %d bytes)", len(want), len(doc.body))
	}
	n := 0
	for _, q := range queries(t, m, ref) {
		r, g := get(ref, q), le.req("GET", "/s/"+le.id+q, nil)
		if r.code != g.code || !bytes.Equal(r.body, g.body) {
			t.Errorf("%s: %d %.200s\nlive %d %.200s", q, r.code, r.body, g.code, g.body)
			continue
		}
		n++
	}
	t.Logf("%d answers equal, rev %d", n, si.Rev)
	if r := le.req("DELETE", "/engine/sessions/"+le.id, nil); r.code != 204 {
		t.Fatalf("delete %d", r.code)
	}
	if d := e.liveDirs(); len(d) != 0 {
		t.Errorf("spill left after DELETE: %v", d)
	}
}

// liveDirs are the live spill directories left.
func (e *env) liveDirs() []string {
	ents, _ := os.ReadDir(e.srv.liveDir())
	var out []string
	for _, x := range ents {
		out = append(out, x.Name())
	}
	return out
}

// TestLiveFollowRemoteChain: a remote follow whose file continues in
// another one starts the mirror of the next file on the same connection
// once the host has it, stops the first mirror, and parses both; DELETE
// stops the second mirror, and no process outlives its channel.
func TestLiveFollowRemoteChain(t *testing.T) {
	isolate(t)
	part1, part2, next := chainFixture(t)
	srv := sshtest.Start(t, sshtest.Options{Password: "pw"})
	e, ts := newServed(t)
	autoAnswer(t, e, ts, map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "pw"})
	call(t, ts, "POST", "/engine/connections", map[string]any{"id": "lab", "kind": "ssh", "host": srv.Host, "port": srv.Port, "user": "oracle", "transport": "lib"})
	hostDir := t.TempDir()
	h1, h2 := filepath.Join(hostDir, "part1.trc"), filepath.Join(hostDir, next)
	os.WriteFile(h1, part1, 0o640) // complete: ends with the marker
	r := call(t, ts, "POST", "/engine/connections/lab/follow", map[string]any{"path": h1, "options": map[string]any{"batchMs": 50}})
	if r.code != 202 {
		t.Fatalf("follow %d %s", r.code, r.body)
	}
	fr := decode[struct {
		Session   SessionInfo
		Job       JobInfo
		LocalPath string
	}](t, r.body)
	le := &liveEnv{env: e, path: fr.LocalPath, id: fr.Session.ID}
	le.waitBytes(int64(len(part1)))
	time.Sleep(700 * time.Millisecond) // the next mirror polls for the file meanwhile
	if j := jobOf(t, ts, fr.Job.ID); j.State != JobRunning {
		t.Fatalf("first mirror before the next file: %+v", j)
	}
	os.WriteFile(h2, part2, 0o640)
	si := le.waitBytes(int64(len(part1) + len(part2)))
	if len(si.Files) != 2 || si.Files[1].Path != filepath.Join(filepath.Dir(fr.LocalPath), next) {
		t.Fatalf("files: %+v", si.Files)
	}
	if j := waitJob(t, ts, fr.Job.ID); j.State != JobCancelled {
		t.Errorf("first mirror after the switch: %+v", j)
	}
	var second JobInfo
	for _, j := range decode[struct{ Jobs []JobInfo }](t, call(t, ts, "GET", "/engine/jobs", nil).body).Jobs {
		if j.Kind == "follow" && j.State == JobRunning {
			second = j
		}
	}
	if second.ID == "" || second.LocalPaths[0] != si.Files[1].Path {
		t.Fatalf("no mirror of the next file: %+v", second)
	}
	other := newEnv(t)
	id := other.openReady([]string{fr.LocalPath}, nil)
	want := other.req("GET", "/s/"+id+"/api/doc", nil).body
	if got := le.req("GET", "/s/"+le.id+"/api/doc", nil).body; !bytes.Equal(generatedRe.ReplaceAll(want, nil), generatedRe.ReplaceAll(got, nil)) {
		t.Errorf("live document differs from a normal open of the mirrors")
	}
	if r := call(t, ts, "DELETE", "/engine/sessions/"+le.id, nil); r.code != 204 {
		t.Fatalf("delete %d", r.code)
	}
	if j := waitJob(t, ts, second.ID); j.State != JobCancelled {
		t.Errorf("second mirror after DELETE: %+v", j)
	}
	time.Sleep(3500 * time.Millisecond)
	if l := srv.Lingered(); len(l) > 0 {
		t.Errorf("remote processes outlived their channel: %q", l)
	}
}

// TestLiveFollowRemoteChainBackward: a remote follow of a file that starts
// with TRACE CONTINUED FROM finds the earlier file on the host (by the name
// in its header: the host copy is renamed), fetches it once next to the
// mirror and reads it first; the session lists the local copies head to
// tail and equals a normal open of the mirror; DELETE stops the one mirror
// and nothing lingers on the host.
func TestLiveFollowRemoteChainBackward(t *testing.T) {
	isolate(t)
	part1, part2, next := chainFixture(t)
	srv := sshtest.Start(t, sshtest.Options{Password: "pw"})
	e, ts := newServed(t)
	autoAnswer(t, e, ts, map[string]string{remote.KindHostKey: "yes", remote.KindPassword: "pw"})
	call(t, ts, "POST", "/engine/connections", map[string]any{"id": "lab", "kind": "ssh", "host": srv.Host, "port": srv.Port, "user": "oracle", "transport": "lib"})
	hostDir := t.TempDir()
	h1, h2 := filepath.Join(hostDir, "part1.trc"), filepath.Join(hostDir, next)
	os.WriteFile(h1, part1, 0o640)
	cut := lineCuts(part2, 0.4)[0]
	os.WriteFile(h2, part2[:cut], 0o640)
	r := call(t, ts, "POST", "/engine/connections/lab/follow", map[string]any{"path": h2, "options": map[string]any{"batchMs": 50}})
	if r.code != 202 {
		t.Fatalf("follow %d %s", r.code, r.body)
	}
	fr := decode[struct {
		Session   SessionInfo
		Job       JobInfo
		LocalPath string
	}](t, r.body)
	le := &liveEnv{env: e, path: fr.LocalPath, id: fr.Session.ID}
	si := le.waitBytes(int64(len(part1)) + cut)
	l1 := filepath.Join(filepath.Dir(fr.LocalPath), "part1.trc")
	if len(si.Files) != 2 || si.Files[0].Path != l1 || si.Files[1].Path != fr.LocalPath {
		t.Fatalf("files: %+v", si.Files)
	}
	if b, err := os.ReadFile(l1); err != nil || !bytes.Equal(b, part1) {
		t.Fatalf("local copy of the earlier file: %v", err)
	}
	appendFile(t, h2, part2[cut:])
	le.waitBytes(int64(len(part1) + len(part2)))
	var running []JobInfo
	for _, j := range decode[struct{ Jobs []JobInfo }](t, call(t, ts, "GET", "/engine/jobs", nil).body).Jobs {
		if j.Kind == "follow" && j.State == JobRunning {
			running = append(running, j)
		}
	}
	if len(running) != 1 || running[0].ID != fr.Job.ID {
		t.Errorf("follow jobs running: %+v", running)
	}
	other := newEnv(t)
	id := other.openReady([]string{fr.LocalPath}, nil)
	want := other.req("GET", "/s/"+id+"/api/doc", nil).body
	if got := le.req("GET", "/s/"+le.id+"/api/doc", nil).body; !bytes.Equal(generatedRe.ReplaceAll(want, nil), generatedRe.ReplaceAll(got, nil)) {
		t.Errorf("live document differs from a normal open of the mirror")
	}
	if r := call(t, ts, "DELETE", "/engine/sessions/"+le.id, nil); r.code != 204 {
		t.Fatalf("delete %d", r.code)
	}
	if j := waitJob(t, ts, fr.Job.ID); j.State != JobCancelled {
		t.Errorf("mirror after DELETE: %+v", j)
	}
	time.Sleep(3500 * time.Millisecond)
	if l := srv.Lingered(); len(l) > 0 {
		t.Errorf("remote processes outlived their channel: %q", l)
	}
}

// jobOf is the job with id as GET /engine/jobs lists it.
func jobOf(t *testing.T, ts *httptest.Server, id string) JobInfo {
	t.Helper()
	for _, j := range decode[struct{ Jobs []JobInfo }](t, call(t, ts, "GET", "/engine/jobs", nil).body).Jobs {
		if j.ID == id {
			return j
		}
	}
	t.Fatalf("no job %s", id)
	return JobInfo{}
}
