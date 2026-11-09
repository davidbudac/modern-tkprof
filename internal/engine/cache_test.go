package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

func fetch(h http.Handler, url string) (int, []byte) {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", url, nil))
	return rec.Code, rec.Body.Bytes()
}

// directSpill builds the set as `serve -spill` does (temporary spill).
func directSpill(t *testing.T, paths []string) (*model.Model, slice.FactSource) {
	t.Helper()
	sp, err := slice.NewSpill(slice.SpillOptions{Dir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	th := analyze.DefaultThresholds()
	m, err := model.BuildFiles(paths, model.Options{Aggregate: true, SpillBinds: true,
		NewSink: func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, th) },
		NewTee:  sp.Attach})
	if err != nil {
		t.Fatal(err)
	}
	src, err := sp.Source()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { src.Close() })
	return m, src
}

func openCache(t *testing.T, dir string, capBytes int64) *Cache {
	t.Helper()
	c, err := OpenCache(dir, capBytes)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func openTrace(t *testing.T, c *Cache, paths []string, o CacheOpenOptions) *CacheOpened {
	t.Helper()
	op, err := c.OpenTrace(context.Background(), paths, o)
	if err != nil {
		t.Fatal(err)
	}
	return op
}

// sameLines compares the line indexes of an opened entry with fresh ones.
func sameLines(t *testing.T, op *CacheOpened) {
	t.Helper()
	if len(op.Lines) != len(op.Model.File.Files) {
		t.Fatalf("%d line indexes for %d files", len(op.Lines), len(op.Model.File.Files))
	}
	for i, fe := range op.Model.File.Files {
		fresh, err := trace.OpenLineIndex(fe.Path)
		if err != nil {
			t.Fatal(err)
		}
		li := op.Lines[i]
		if li.Lines() != fresh.Lines() {
			t.Errorf("file %d: %d lines, fresh index %d", i, li.Lines(), fresh.Lines())
		}
		n := fresh.Lines()
		for _, r := range [][2]int{{1, 2000}, {n / 2, 77}, {n - 3, 10}, {64, 64}, {n + 1, 5}} {
			a, _ := fresh.Read(r[0], r[1])
			b, _ := li.Read(r[0], r[1])
			if !bytes.Equal(a, b) {
				t.Errorf("file %d: lines %d+%d differ", i, r[0], r[1])
			}
		}
		fresh.Close()
	}
}

// TestCacheRoundTrip: for every fixture set, build into the cache, reopen
// it, and require every slicing endpoint, the document, the text report
// and the raw lines to equal those of a direct (temporary) spill build.
func TestCacheRoundTrip(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	sets := fixtureSets()
	for _, name := range sortedKeys(sets) {
		t.Run(name, func(t *testing.T) {
			paths := sets[name]
			dm, dsrc := directSpill(t, paths)
			hd := slice.NewServer(dm, dsrc).Handler()
			c := openCache(t, t.TempDir(), 0)
			miss := openTrace(t, c, paths, CacheOpenOptions{})
			if miss.Hit {
				t.Fatal("first open was a hit")
			}
			miss.Close()
			op := openTrace(t, c, paths, CacheOpenOptions{})
			defer op.Close()
			if !op.Hit {
				t.Fatal("second open was not a hit")
			}
			if got, want := op.Source.NumCalls(), dsrc.NumCalls(); got != want {
				t.Fatalf("calls: %d cached, %d direct", got, want)
			}
			if got, want := op.Source.NumWaits(), dsrc.NumWaits(); got != want {
				t.Fatalf("waits: %d cached, %d direct", got, want)
			}
			sameOutputs(t, dm, op.Model)
			sameLines(t, op)
			hc := slice.NewServer(op.Model, op.Source).Handler()
			qs, err := slice.ParityQueries(dm, hd)
			if err != nil {
				t.Fatal(err)
			}
			n := 0
			for _, q := range qs {
				cd, bd := fetch(hd, q)
				cc, bc := fetch(hc, q)
				if cd != cc {
					t.Errorf("%s: status %d direct, %d cached: %s", q, cd, cc, bc)
					continue
				}
				if !bytes.Equal(bd, bc) {
					t.Errorf("%s differs\n direct %.400s\n cached %.400s", q, firstDiff(bd, bc), firstDiff(bc, bd))
				}
				n++
			}
			if n < 50 {
				t.Errorf("only %d queries", n)
			}
			t.Logf("%d queries equal", n)
		})
	}
}

// copyFixture copies a fixture to dir/name.
func copyFixture(t *testing.T, src, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

const fx = "../../testdata/traces/19c/"

func TestCacheHitAfterMoveAndRename(t *testing.T) {
	work := t.TempDir()
	a := copyFixture(t, fx+"io_waits.trc", work, "a.trc")
	c := openCache(t, t.TempDir(), 0)
	op := openTrace(t, c, []string{a}, CacheOpenOptions{})
	want, _ := outputs(t, op.Model)
	op.Close()
	b := filepath.Join(work, "elsewhere", "b.trc")
	os.MkdirAll(filepath.Dir(b), 0o755)
	if err := os.Rename(a, b); err != nil {
		t.Fatal(err)
	}
	op = openTrace(t, c, []string{b}, CacheOpenOptions{})
	defer op.Close()
	if !op.Hit {
		t.Fatal("moved file missed the cache")
	}
	if op.Model.File.Path != b || op.Model.File.Files[0].Name != "b.trc" {
		t.Errorf("model path %q / %q, want the new one", op.Model.File.Path, op.Model.File.Files[0].Name)
	}
	sameLines(t, op)
	got, _ := outputs(t, op.Model)
	if bytes.Equal(got, want) {
		t.Errorf("document still shows the old path")
	}
	if back := bytes.ReplaceAll(bytes.ReplaceAll(got, []byte(b), []byte(a)), []byte(`"b.trc"`), []byte(`"a.trc"`)); !bytes.Equal(back, want) {
		t.Errorf("document differs beyond the path")
	}
}

func TestCacheOptionsAreSeparateEntries(t *testing.T) {
	p := []string{fx + "basic_binds.trc"}
	c := openCache(t, t.TempDir(), 0)
	keep := openTrace(t, c, p, CacheOpenOptions{})
	defer keep.Close()
	red := openTrace(t, c, p, CacheOpenOptions{BindMode: model.BindsRedact, Salt: "s"})
	defer red.Close()
	none := openTrace(t, c, p, CacheOpenOptions{BindMode: model.BindsNone})
	defer none.Close()
	if keep.Identity == red.Identity || red.Identity == none.Identity || red.Hit || none.Hit {
		t.Fatalf("bind modes share an entry")
	}
	if _, n, _ := c.Stats(); n != 3 {
		t.Errorf("%d entries, want 3", n)
	}
	if red.Model.Diag.BindMode != "redacted" || none.Model.Diag.BindMode != "none" {
		t.Errorf("bind modes %q, %q", red.Model.Diag.BindMode, none.Model.Diag.BindMode)
	}
	sawKept, sawRedacted := false, false
	for set := model.ID(0); set < 50; set++ {
		for _, b := range keep.Source.Binds(set) {
			sawKept = sawKept || (!b.IsNull && !strings.HasPrefix(b.Value, "<"))
		}
		for _, b := range red.Source.Binds(set) {
			if !b.IsNull && !b.NoDef {
				sawRedacted = true
				if !strings.HasPrefix(b.Value, "<") {
					t.Fatalf("redacted entry holds the value %q", b.Value)
				}
			}
		}
		if none.Source.Binds(set) != nil {
			t.Fatal("binds=none entry holds binds")
		}
	}
	if !sawKept || !sawRedacted {
		t.Errorf("no bind values seen (kept %t, redacted %t)", sawKept, sawRedacted)
	}
	th := analyze.DefaultThresholds()
	th.MaxEvidenceRows = 3
	other := openTrace(t, c, p, CacheOpenOptions{Thresholds: &th})
	defer other.Close()
	if other.Hit || other.Identity == keep.Identity {
		t.Errorf("other thresholds hit the default entry")
	}
}

func entryBytes(t *testing.T, c *Cache, id string) int64 {
	t.Helper()
	for _, e := range c.Entries() {
		if e.Identity == id {
			return e.Bytes
		}
	}
	t.Fatalf("no entry %s", id)
	return 0
}

func TestCacheEvictLRU(t *testing.T) {
	dir := t.TempDir()
	c := openCache(t, dir, 0)
	var ids []string
	for _, f := range []string{"io_waits.trc", "errors.trc", "lobs.trc"} {
		op := openTrace(t, c, []string{fx + f}, CacheOpenOptions{})
		ids = append(ids, op.Identity)
		op.Close()
	}
	a, b, cc := ids[0], ids[1], ids[2]
	if err := c.Touch(a); err != nil { // a is now the most recently used, b the least
		t.Fatal(err)
	}
	if got := c.Entries(); len(got) != 3 || got[0].Identity != a || got[2].Identity != b {
		t.Fatalf("entries not in lastUsed order: %+v", got)
	}
	small := openCache(t, dir, entryBytes(t, c, a)+entryBytes(t, c, cc))
	if removed := small.Evict(); len(removed) != 1 || removed[0] != b {
		t.Fatalf("evicted %v, want [%s]", removed, b)
	}
	if _, ok := small.Lookup(b); ok {
		t.Fatal("evicted entry still found")
	}
	// open entries and pinned ones stay whatever the cap
	tiny := openCache(t, dir, 1)
	op := openTrace(t, tiny, []string{fx + "lobs.trc"}, CacheOpenOptions{})
	if !op.Hit {
		t.Fatal("lobs not a hit")
	}
	if removed := tiny.Evict(a); len(removed) != 0 {
		t.Fatalf("evicted %v while one is open and one pinned", removed)
	}
	if removed := tiny.Evict(); len(removed) != 1 || removed[0] != a {
		t.Fatalf("evicted %v, want [%s]", removed, a)
	}
	op.Close()
	if removed := tiny.Evict(); len(removed) != 1 || removed[0] != cc {
		t.Fatalf("evicted %v after close, want [%s]", removed, cc)
	}
	// a new build evicts the others but not itself
	op = openTrace(t, tiny, []string{fx + "errors.trc"}, CacheOpenOptions{})
	defer op.Close()
	if bytes, n, capBytes := tiny.Stats(); n != 1 || bytes == 0 || capBytes != 1 {
		t.Errorf("stats %d bytes, %d entries, cap %d", bytes, n, capBytes)
	}
}

func editManifest(t *testing.T, dir string, edit func(m *Manifest)) {
	t.Helper()
	m, err := readManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	edit(m)
	if err := writeManifest(dir, m); err != nil {
		t.Fatal(err)
	}
}

func TestCacheManifestMismatchIsMiss(t *testing.T) {
	p := []string{fx + "io_waits.trc"}
	c := openCache(t, t.TempDir(), 0)
	op := openTrace(t, c, p, CacheOpenOptions{})
	id, dir := op.Identity, op.Entry.Dir
	op.Close()
	for name, damage := range map[string]func(){
		"format":    func() { editManifest(t, dir, func(m *Manifest) { m.IndexFormat = 999 }) },
		"options":   func() { editManifest(t, dir, func(m *Manifest) { m.Options.BindMode = "redacted" }) },
		"inputs":    func() { editManifest(t, dir, func(m *Manifest) { m.Inputs = []string{"x"} }) },
		"truncated": func() { os.Truncate(filepath.Join(dir, "calls.bin"), 154) },
		"missing":   func() { os.Remove(filepath.Join(dir, "lines-0.idx")) },
		"manifest":  func() { os.WriteFile(filepath.Join(dir, manifestName), []byte("{"), 0o600) },
	} {
		t.Run(name, func(t *testing.T) {
			if _, ok := c.Lookup(id); !ok {
				t.Fatal("no entry before the damage")
			}
			damage()
			if _, ok := c.Lookup(id); ok {
				t.Fatal("damaged entry found")
			}
			if _, err := os.Stat(dir); !os.IsNotExist(err) {
				t.Errorf("damaged entry not removed")
			}
			op := openTrace(t, c, p, CacheOpenOptions{})
			if op.Hit {
				t.Errorf("open after the damage was a hit")
			}
			op.Close()
		})
	}
	// a file of another format version (same size) fails to decode: rebuilt, no crash
	for _, f := range []string{cacheDimsFile, cacheAggFile, "spill.idx", "lines-0.idx"} {
		t.Run("version-"+f, func(t *testing.T) {
			path := filepath.Join(dir, f)
			b, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			b[8]++ // the version follows the 8-byte magic
			os.WriteFile(path, b, 0o600)
			op := openTrace(t, c, p, CacheOpenOptions{})
			defer op.Close()
			if op.Hit {
				t.Errorf("open of an entry with a bad %s was a hit", f)
			}
		})
	}
	m, err := readManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !errors.Is(func() error { _, err := model.Decode(bytes.NewReader([]byte("MTKPDIMS\x07"))); return err }(), model.ErrFormat) {
		t.Errorf("model.Decode of version 7 is not ErrFormat")
	}
	if m.Identity != id || m.Bytes <= 0 || len(m.Sources) != 1 || !m.Sources[0].Named || !filepath.IsAbs(m.Sources[0].Path) {
		t.Errorf("manifest %+v", m)
	}
}

func TestCacheWipeAndRemove(t *testing.T) {
	c := openCache(t, t.TempDir(), 0)
	a := openTrace(t, c, []string{fx + "io_waits.trc"}, CacheOpenOptions{})
	b := openTrace(t, c, []string{fx + "errors.trc"}, CacheOpenOptions{})
	b.Close()
	if err := c.Remove(a.Identity); !errors.Is(err, ErrCacheInUse) {
		t.Errorf("remove of an open entry: %v", err)
	}
	if err := c.Wipe(); !errors.Is(err, ErrCacheInUse) {
		t.Errorf("wipe with an open entry: %v", err)
	}
	if es := c.Entries(); len(es) != 1 || es[0].Identity != a.Identity || !es[0].Open {
		t.Fatalf("after wipe: %+v", es)
	}
	// the open entry still answers
	if code, _ := fetch(slice.NewServer(a.Model, a.Source).Handler(), "/api/pivot?fact=calls&by=stmt"); code != 200 {
		t.Errorf("open entry broken by wipe: %d", code)
	}
	a.Close()
	if err := c.Wipe(); err != nil {
		t.Fatal(err)
	}
	if _, n, _ := c.Stats(); n != 0 {
		t.Errorf("%d entries after wipe", n)
	}
	if ents, _ := os.ReadDir(c.Dir()); len(ents) != 0 {
		t.Errorf("index dir not empty after wipe: %v", ents)
	}
	op := openTrace(t, c, []string{fx + "io_waits.trc"}, CacheOpenOptions{})
	op.Close()
	if err := c.Remove(op.Identity); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Lookup(op.Identity); ok {
		t.Errorf("removed entry found")
	}
}

func TestCacheCrashLeavesNoHalfEntry(t *testing.T) {
	root := t.TempDir()
	c := openCache(t, root, 0)
	// a build that fails half way leaves nothing behind
	_, err := c.OpenTrace(context.Background(), []string{fx + "io_waits.trc"}, CacheOpenOptions{
		Build: func(ctx context.Context, paths []string, mo model.Options) (*model.Model, error) {
			model.BuildFiles(paths, mo) // the spill files are written ...
			return nil, errors.New("killed")
		}})
	if err == nil || !strings.Contains(err.Error(), "killed") {
		t.Fatalf("err %v", err)
	}
	if ents, _ := os.ReadDir(c.Dir()); len(ents) != 0 {
		t.Fatalf("failed build left %v", ents)
	}
	// a canceled open builds nothing
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.OpenTrace(ctx, []string{fx + "io_waits.trc"}, CacheOpenOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled open: %v", err)
	}
	// what a kill -9 leaves: an entry directory without a manifest, the build
	// directory of a dead process; a live process's build is left alone
	id := strings.Repeat("ab", 32)
	half := filepath.Join(c.Dir(), id)
	dead := filepath.Join(c.Dir(), cacheBuildPfx+"2000000000-1")
	live := filepath.Join(c.Dir(), fmt.Sprintf("%s%d-2", cacheBuildPfx, os.Getppid()))
	// a folder that is not the cache's (a -cache pointed at a folder in use) is never touched
	foreign := filepath.Join(c.Dir(), "Documents")
	for _, d := range []string{half, dead, live, foreign} {
		os.MkdirAll(d, 0o700)
		os.WriteFile(filepath.Join(d, "calls.bin"), []byte("x"), 0o600)
	}
	if _, ok := c.Lookup(id); ok {
		t.Fatal("entry without manifest found")
	}
	os.MkdirAll(half, 0o700)
	openCache(t, root, 0)
	for d, want := range map[string]bool{half: false, dead: false, live: true, foreign: true} {
		if _, err := os.Stat(d); (err == nil) != want {
			t.Errorf("%s: exists %t, want %t", filepath.Base(d), err == nil, want)
		}
	}
}

func TestCacheModes(t *testing.T) {
	c := openCache(t, t.TempDir(), 0)
	op := openTrace(t, c, []string{fx + "io_waits.trc"}, CacheOpenOptions{})
	defer op.Close()
	for _, p := range []string{c.Dir(), op.Entry.Dir} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if mode := fi.Mode().Perm(); mode&0o077 != 0 && os.PathSeparator == '/' {
			t.Errorf("%s: mode %v", p, mode)
		}
	}
	ents, _ := os.ReadDir(op.Entry.Dir)
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
		fi, _ := e.Info()
		if mode := fi.Mode().Perm(); mode&0o077 != 0 && os.PathSeparator == '/' {
			t.Errorf("%s: mode %v", e.Name(), mode)
		}
	}
	for _, want := range append([]string{manifestName, cacheDimsFile, cacheAggFile, "lines-0.idx"}, slice.SpillFiles...) {
		if !strings.Contains(" "+strings.Join(names, " ")+" ", " "+want+" ") {
			t.Errorf("no %s in the entry (%v)", want, names)
		}
	}
	b, _ := os.ReadFile(filepath.Join(op.Entry.Dir, manifestName))
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"engine", "indexFormat", "protocol", "sources", "options", "created", "lastUsed", "bytes"} {
		if _, ok := m[k]; !ok {
			t.Errorf("manifest has no %q", k)
		}
	}
}

// TestCacheIndexFormatCoversParts fails when the version of a file of an
// entry changes: bump CacheIndexFormat and update the expectation.
func TestCacheIndexFormatCoversParts(t *testing.T) {
	want := map[string]int{"dims": 2, "agg": 4, "spill": 2, "lines": 1}
	if CacheIndexFormat != 7 {
		t.Skip("update want for the new CacheIndexFormat")
	}
	for k, v := range want {
		if cacheParts[k] != v {
			t.Errorf("%s version %d at CacheIndexFormat %d (expected %d): bump CacheIndexFormat", k, cacheParts[k], CacheIndexFormat, v)
		}
	}
}
