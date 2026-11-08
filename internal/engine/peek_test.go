package engine

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/peek"
)

// POST /engine/files lists a folder's *.trc files by name and the files
// asked for by themselves; POST /engine/peek summarises each, an unreadable
// one with its error.
func TestListAndPeek(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	src, err := os.ReadFile(traces + "multisession_a.trc")
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"b.trc", "a.TRC", "notes.txt", "c.trm"} {
		if err := os.WriteFile(filepath.Join(dir, n), src, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "sub.trc"), 0o755); err != nil {
		t.Fatal(err)
	}
	one, _ := filepath.Abs(traces + "io_waits.trc")
	r := e.req("POST", "/engine/files", map[string]any{"paths": []string{dir, one}})
	if r.code != http.StatusOK {
		t.Fatalf("%d %s", r.code, r.body)
	}
	l := decode[FileList](t, r.body)
	want := []string{filepath.Join(dir, "a.TRC"), filepath.Join(dir, "b.trc"), one}
	if len(l.Files) != len(want) || len(l.Dirs) != 1 || l.Dirs[0] != dir {
		t.Fatalf("got %+v", l)
	}
	for i, f := range l.Files {
		if f.Path != want[i] || f.Size == 0 || f.Modified.IsZero() || (f.Dir == "") != (i == 2) {
			t.Errorf("file %d: %+v, want %s", i, f, want[i])
		}
	}

	r = e.req("POST", "/engine/peek", map[string]any{"paths": []string{want[0], filepath.Join(dir, "gone.trc"), one}})
	if r.code != http.StatusOK {
		t.Fatalf("%d %s", r.code, r.body)
	}
	p := decode[struct{ Files []peek.Summary }](t, r.body)
	if len(p.Files) != 3 || p.Files[0].Error != "" || p.Files[1].Error == "" || p.Files[2].Error != "" {
		t.Fatalf("got %+v", p.Files)
	}
	if s := p.Files[0]; !s.SQLTrace || s.SessionCount == 0 || s.Start == nil || s.ElapsedUs <= 0 || s.Size != int64(len(src)) {
		t.Errorf("summary %+v", s)
	}

	for _, body := range []map[string]any{{"paths": []string{}}, {"paths": []string{filepath.Join(dir, "gone")}}, {"path": dir}} {
		if r := e.req("POST", "/engine/files", body); r.code != http.StatusBadRequest {
			t.Errorf("files %v: %d", body, r.code)
		}
	}
	if r := e.req("POST", "/engine/peek", map[string]any{"paths": []string{}}); r.code != http.StatusBadRequest {
		t.Errorf("peek without paths: %d", r.code)
	}
}
