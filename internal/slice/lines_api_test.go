package slice

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// lineEnv serves one trace set from its model's own tables and from spill
// files, both with the same line indexes.
type lineEnv struct {
	paths     []string
	full      *model.Model // all facts
	mem, disk http.Handler
	lis       []*trace.LineIndex
}

func fixtureSets(t *testing.T) map[string][]string {
	t.Helper()
	files, _ := filepath.Glob("../../testdata/traces/*/*.trc")
	if len(files) == 0 {
		t.Skip("no fixtures")
	}
	sets := map[string][]string{}
	for _, f := range files {
		sets[filepath.Base(filepath.Dir(f))+"/"+filepath.Base(f)] = []string{f}
	}
	sets["19c/multisession_a+b"] = []string{traces + "multisession_a.trc", traces + "multisession_b.trc"}
	return sets
}

func newLineEnv(t *testing.T, paths []string) *lineEnv {
	t.Helper()
	full, err := model.BuildFiles(paths, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	agg, sp := buildSpilled(t, paths, t.TempDir())
	t.Cleanup(func() { sp.Close() })
	src, err := sp.Source()
	if err != nil {
		t.Fatal(err)
	}
	e := &lineEnv{paths: paths, full: full}
	for _, fe := range full.File.Files {
		li, err := trace.OpenLineIndex(fe.Path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { li.Close() })
		e.lis = append(e.lis, li)
	}
	e.mem = New(full).WithLines(e.lis).Handler()
	e.disk = NewServer(agg, src).WithLines(e.lis).Handler()
	return e
}

// both fetches the URL from the model-backed and the spill-backed server and
// requires the same status and the same bytes.
func (e *lineEnv) both(t *testing.T, url string) (int, []byte) {
	t.Helper()
	c1, b1 := fetch(e.mem, url)
	c2, b2 := fetch(e.disk, url)
	if c1 != c2 || !bytes.Equal(b1, b2) {
		t.Fatalf("%s: model %d %s\n spill %d %s", url, c1, b1, c2, b2)
	}
	return c1, b1
}

func sample[T any](x []T, n int) []T {
	if len(x) <= n {
		return x
	}
	out := make([]T, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, x[i*len(x)/n])
	}
	return out
}

type atResp struct {
	Call, Stmt, Cursor, ExecNo, Wait, BindSet, Ctx, PlanLine int
	Kind                                                     string
}

func (e *lineEnv) at(t *testing.T, file, line int) atResp {
	t.Helper()
	code, b := e.both(t, fmt.Sprintf("/api/at?file=%d&line=%d", file, line))
	if code != 200 {
		t.Fatalf("at file %d line %d: %d %s", file, line, code, b)
	}
	var r atResp
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

// fileOf is the input file of a context.
func fileOf(m *model.Model, ctx model.ID) int { return m.Contexts[ctx].FileIdx }

func TestAtMatchesModel(t *testing.T) {
	for name, paths := range fixtureSets(t) {
		t.Run(name, func(t *testing.T) {
			e := newLineEnv(t, paths)
			m := e.full
			for _, c := range sample(m.Calls, 200) {
				r := e.at(t, fileOf(m, c.Context), int(c.Line))
				if r.Call != int(c.ID) {
					// another call on the same line (none expected): it must be on that line
					if r.Call < 0 || m.Calls[r.Call].Line != c.Line || fileOf(m, m.Calls[r.Call].Context) != fileOf(m, c.Context) {
						t.Fatalf("call %d (line %d): at says call %d", c.ID, c.Line, r.Call)
					}
					continue
				}
				if r.Stmt != int(c.Statement) || r.Cursor != int(c.Cursor) || r.ExecNo != int(c.ExecNo) || r.BindSet != int(c.BindSet) || r.Ctx != int(c.Context) {
					t.Fatalf("call %d: at = %+v, call = stmt %d cursor %d exec %d bind %d ctx %d", c.ID, r, c.Statement, c.Cursor, c.ExecNo, c.BindSet, c.Context)
				}
			}
			for _, w := range sample(m.Waits, 200) {
				r := e.at(t, fileOf(m, w.Context), int(w.Line))
				if r.Wait != int(w.ID) || r.Call != int(w.Call) || r.Stmt != int(w.Statement) || r.Cursor != int(w.Cursor) || r.Kind != "wait" {
					t.Fatalf("wait %d (line %d): at = %+v, wait = call %d stmt %d cursor %d", w.ID, w.Line, r, w.Call, w.Statement, w.Cursor)
				}
			}
			for _, c := range m.Cursors {
				if c.Implicit {
					continue
				}
				r := e.at(t, fileOf(m, c.Context), c.Line)
				if r.Kind != "parsing-in-cursor" { // a cursor made for an XCTEND, LOB or parse error line
					continue
				}
				if r.Cursor != int(c.ID) || r.Stmt != int(c.Statement) || r.Kind != "parsing-in-cursor" || r.Call != -1 {
					t.Fatalf("cursor %d (line %d): at = %+v", c.ID, c.Line, r)
				}
				// the line below is statement text (or END OF STMT of an empty one)
				if r2 := e.at(t, fileOf(m, c.Context), c.Line+1); r2.Cursor != int(c.ID) {
					t.Fatalf("cursor %d text line %d: at = %+v", c.ID, c.Line+1, r2)
				}
			}
			for _, bs := range sample(m.BindSets, 100) {
				if bs.Call < 0 {
					continue
				}
				call := m.Calls[bs.Call]
				r := e.at(t, fileOf(m, call.Context), bs.Line)
				if r.BindSet != int(bs.ID) || r.Call != int(bs.Call) || r.Kind != "binds" && r.Kind != "rpc" {
					t.Fatalf("bind set %d (line %d): at = %+v", bs.ID, bs.Line, r)
				}
			}
			// the file of a plan: plans are created in file order, so take the
			// first file from the current one on that has a STAT at its line
			statLines := make([]map[int]string, len(e.lis))
			for i, fe := range m.File.Files {
				rec := &kindRecorder{kinds: map[int]string{}}
				if _, err := trace.ParseFile(fe.Path, rec); err != nil {
					t.Fatal(err)
				}
				statLines[i] = rec.kinds
			}
			f := 0
			for _, p := range m.Plans {
				for f < len(statLines) && statLines[f][p.Line] != "stat" {
					f++
				}
				if f == len(statLines) {
					t.Fatalf("plan %d line %d is no STAT line in any file", p.ID, p.Line)
				}
				if p.N == 0 {
					continue
				}
				for i := 0; i < int(p.N); i++ {
					r := e.at(t, f, p.Line+i)
					if r.Kind != "stat" || r.PlanLine != int(p.First)+i || r.Stmt != int(p.Statement) {
						t.Fatalf("plan %d line %d+%d: at = %+v, want planLine %d", p.ID, p.Line, i, r, int(p.First)+i)
					}
				}
			}
		})
	}
}

func TestAtEveryLineConsistent(t *testing.T) {
	// every line of a small multi-file set answers, with the kind the
	// annotation gives, and a call that is never after the line
	e := newLineEnv(t, []string{traces + "multisession_a.trc", traces + "multisession_b.trc"})
	m := e.full
	for fi, li := range e.lis {
		for line := 1; line <= li.Lines(); line += 7 {
			r := e.at(t, fi, line)
			if r.Call >= 0 {
				c := m.Calls[r.Call]
				if fileOf(m, c.Context) != fi {
					t.Fatalf("file %d line %d: call %d belongs to file %d", fi, line, c.ID, fileOf(m, c.Context))
				}
			}
			if r.Ctx >= 0 && fileOf(m, model.ID(r.Ctx)) != fi {
				t.Fatalf("file %d line %d: ctx %d belongs to file %d", fi, line, r.Ctx, fileOf(m, model.ID(r.Ctx)))
			}
		}
	}
	if code, _ := e.both(t, "/api/at?file=2&line=1"); code != 404 {
		t.Errorf("no such file: %d", code)
	}
	if code, _ := e.both(t, "/api/at?file=0&line=99999999"); code != 404 {
		t.Errorf("line past the end: %d", code)
	}
	for _, q := range []string{"/api/at?file=0", "/api/at?file=0&line=0", "/api/at?file=0&line=x", "/api/lines/at?file=0", "/api/lines/at?tim=x"} {
		if code, _ := e.both(t, q); code != 400 {
			t.Errorf("%s: %d, want 400", q, code)
		}
	}
}

func TestLinesAt(t *testing.T) {
	for name, paths := range fixtureSets(t) {
		t.Run(name, func(t *testing.T) {
			e := newLineEnv(t, paths)
			m := e.full
			for fi := range e.lis {
				// the expected answer by linear scan
				var recs []timLine
				var calls, waits []timLine
				for _, c := range m.Calls {
					if fileOf(m, c.Context) == fi {
						calls = append(calls, timLine{c.Tim, c.Line})
					}
				}
				for _, w := range m.Waits {
					if fileOf(m, w.Context) == fi {
						waits = append(waits, timLine{w.Tim, w.Line})
					}
				}
				recs = append(append(recs, calls...), waits...)
				if len(recs) == 0 {
					if code, _ := e.both(t, fmt.Sprintf("/api/lines/at?file=%d&tim=1", fi)); code != 404 {
						t.Errorf("file %d without rows: %d", fi, code)
					}
					continue
				}
				want := func(tim int64) int32 {
					best, last := int32(-1), int32(-1)
					for _, set := range [][]timLine{calls, waits} {
						for _, r := range set {
							last = max(last, r.line)
							if r.tim >= tim && (best < 0 || r.line < best) {
								// first row with tim >= tim has the smallest line
								// only when tim is monotone; the scan takes the
								// smallest line among all such rows
								best = r.line
							}
						}
					}
					if best < 0 {
						return last
					}
					return best
				}
				tims := []int64{-5, 0}
				for _, r := range sample(recs, 100) {
					tims = append(tims, r.tim, r.tim-1, r.tim+1)
				}
				var maxTim int64
				for _, r := range recs {
					maxTim = max(maxTim, r.tim)
				}
				tims = append(tims, maxTim+1_000_000)
				sort.Slice(tims, func(i, j int) bool { return tims[i] < tims[j] })
				prev := int32(0)
				for _, tim := range tims {
					code, b := e.both(t, fmt.Sprintf("/api/lines/at?file=%d&tim=%d", fi, tim))
					if code != 200 {
						t.Fatalf("tim %d: %d %s", tim, code, b)
					}
					var r struct{ Line int32 }
					json.Unmarshal(b, &r)
					if r.Line < prev {
						t.Errorf("file %d: tim %d -> line %d, after tim before -> %d", fi, tim, r.Line, prev)
					}
					prev = r.Line
					// tim is monotone along the rows of a file in the fixtures
					// that matter; elsewhere the binary search may differ from
					// the scan, so only the monotone case is compared
					if w := want(tim); r.Line != w && sortedTims(calls) && sortedTims(waits) {
						t.Errorf("file %d tim %d: line %d, scan says %d", fi, tim, r.Line, w)
					}
				}
			}
		})
	}
}

type timLine struct {
	tim  int64
	line int32
}

func sortedTims(x []timLine) bool {
	for i := 1; i < len(x); i++ {
		if x[i].tim < x[i-1].tim {
			return false
		}
	}
	return true
}

// ---- search ------------------------------------------------------------------

type hit struct {
	Line int    `json:"line"`
	Col  int    `json:"col"`
	Text string `json:"text"`
}

type searchEnd struct {
	Done      bool `json:"done"`
	Scanned   int  `json:"scanned"`
	Truncated bool `json:"truncated"`
}

func runSearch(t *testing.T, h http.Handler, query string) ([]hit, searchEnd, int) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/search?"+query, nil))
	if rec.Code != 200 {
		return nil, searchEnd{}, rec.Code
	}
	var hits []hit
	var end searchEnd
	sc := bufio.NewScanner(rec.Body)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		if bytes.HasPrefix(sc.Bytes(), []byte(`{"done"`)) {
			if err := json.Unmarshal(sc.Bytes(), &end); err != nil {
				t.Fatal(err)
			}
			continue
		}
		var h hit
		if err := json.Unmarshal(sc.Bytes(), &h); err != nil {
			t.Fatalf("%q: %v", sc.Text(), err)
		}
		hits = append(hits, h)
	}
	if !end.Done {
		t.Fatalf("%s: no done record", query)
	}
	return hits, end, 200
}

func fileLines(t *testing.T, path string) []string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := strings.TrimSuffix(string(b), "\n")
	return strings.Split(s, "\n")
}

func TestSearch(t *testing.T) {
	const file = "../../testdata/traces/19c/io_waits.trc"
	e := newLineEnv(t, []string{file})
	h := e.disk
	lines := fileLines(t, file)
	var wantWait []int
	for i, l := range lines {
		if strings.HasPrefix(l, "WAIT #") {
			wantWait = append(wantWait, i+1)
		}
	}
	if len(wantWait) < 1000 {
		t.Fatalf("fixture has %d WAIT lines", len(wantWait))
	}
	check := func(label string, hits []hit, want []int) {
		t.Helper()
		if len(hits) != len(want) {
			t.Fatalf("%s: %d hits, want %d", label, len(hits), len(want))
		}
		for i, h := range hits {
			if h.Line != want[i] {
				t.Fatalf("%s: hit %d at line %d, want %d", label, i, h.Line, want[i])
			}
			l := lines[h.Line-1]
			if h.Col < 0 || h.Col+1 > len(l) || !strings.HasPrefix(strings.ToLower(l[h.Col:]), strings.ToLower("WAIT #")) && label != "regex" {
				t.Fatalf("%s: line %d col %d: %q", label, h.Line, h.Col, l)
			}
			if h.Text != strings.TrimSuffix(l, "\r") && len(l) <= searchTextMax {
				t.Fatalf("%s: line %d text %q, line %q", label, h.Line, h.Text, l)
			}
		}
	}

	// every chunk size gives the same answer (lines carried over chunk ends)
	for _, chunk := range []int{4 << 20, 100_000, 4096, 777} {
		old := searchChunk
		searchChunk = chunk
		hits, end, code := runSearch(t, h, "q=WAIT+%23&limit=10000")
		searchChunk = old
		if code != 200 {
			t.Fatal(code)
		}
		check(fmt.Sprintf("literal chunk %d", chunk), hits, wantWait)
		if end.Truncated || end.Scanned != len(lines) {
			t.Errorf("chunk %d: end %+v, %d lines", chunk, end, len(lines))
		}
	}
	// case folding
	hits, _, _ := runSearch(t, h, "q=wait+%23&case=0&limit=10000")
	check("fold", hits, wantWait)
	if hits, _, _ = runSearch(t, h, "q=wait+%23&case=1&limit=10000"); len(hits) != 0 {
		t.Errorf("case-sensitive 'wait #': %d hits", len(hits))
	}
	// regex
	re := regexp.MustCompile(`^WAIT #\d+: nam='db file`)
	var wantRe []int
	for i, l := range lines {
		if re.MatchString(l) {
			wantRe = append(wantRe, i+1)
		}
	}
	hits, _, _ = runSearch(t, h, "q="+`%5EWAIT+%23%5Cd%2B%3A+nam%3D%27db+file`+"&regex=1&limit=10000")
	check("regex", hits, wantRe)
	hits, _, _ = runSearch(t, h, "q="+`%5Ewait+%23%5Cd%2B%3A+nam%3D%27DB+FILE`+"&regex=1&case=0&limit=10000")
	check("regex", hits, wantRe)
	// limit and from
	hits, end, _ := runSearch(t, h, "q=WAIT+%23&limit=10")
	if len(hits) != 10 || !end.Truncated || end.Scanned != wantWait[9] {
		t.Errorf("limit 10: %d hits, end %+v (want scanned %d)", len(hits), end, wantWait[9])
	}
	mid := wantWait[len(wantWait)/2] + 1
	hits, end, _ = runSearch(t, h, fmt.Sprintf("q=WAIT+%%23&limit=10000&from=%d", mid))
	var wantFrom []int
	for _, l := range wantWait {
		if l >= mid {
			wantFrom = append(wantFrom, l)
		}
	}
	check("from", hits, wantFrom)
	if end.Scanned != len(lines)-mid+1 {
		t.Errorf("from %d: scanned %d, want %d", mid, end.Scanned, len(lines)-mid+1)
	}
	if hits, end, _ = runSearch(t, h, "q=WAIT&from=99999999"); len(hits) != 0 || end.Scanned != 0 {
		t.Errorf("from past the end: %d hits, %+v", len(hits), end)
	}
	// the mem-backed server serves the same
	hm, _, _ := runSearch(t, e.mem, "q=WAIT+%23&limit=10000")
	check("mem", hm, wantWait)
	// bad requests
	for _, q := range []string{"q=", "", "q=(&regex=1", "q=a%0Ab", "q=x&file=9", "q=x&limit=zero"} {
		if _, _, code := runSearch(t, h, q); code < 400 {
			t.Errorf("search %q: %d, want an error", q, code)
		}
	}
}

func TestSearchCRLFAndLongLines(t *testing.T) {
	dir := t.TempDir()
	long := strings.Repeat("é", 300) // 600 bytes
	text := "WAIT #1: a\r\nnothing\r\n" + long + " WAIT #2\r\nWAIT #3 last no newline"
	p := filepath.Join(dir, "x.trc")
	os.WriteFile(p, []byte(text), 0o600)
	li, err := trace.OpenLineIndex(p)
	if err != nil {
		t.Fatal(err)
	}
	defer li.Close()
	s := &Server{lis: []*trace.LineIndex{li}}
	for _, chunk := range []int{4 << 20, 5, 1} {
		old := searchChunk
		searchChunk = chunk
		hits, end, _ := runSearch(t, http.HandlerFunc(s.search), "q=WAIT+%23&limit=100")
		searchChunk = old
		if len(hits) != 3 || hits[0].Line != 1 || hits[1].Line != 3 || hits[2].Line != 4 || end.Scanned != 4 {
			t.Fatalf("chunk %d: %+v %+v", chunk, hits, end)
		}
		if hits[0].Text != "WAIT #1: a" {
			t.Errorf("CR kept: %q", hits[0].Text)
		}
		if len(hits[1].Text) > searchTextMax || !strings.HasPrefix(long, strings.TrimSuffix(hits[1].Text, "")) || hits[1].Col != 601 {
			t.Errorf("long line: %d bytes, col %d", len(hits[1].Text), hits[1].Col)
		}
	}
}

// slowWriter cancels the request on the first hit and notes when the handler
// returns.
type cancelWriter struct {
	header http.Header
	cancel context.CancelFunc
	at     time.Time
	n      int
}

func (w *cancelWriter) Header() http.Header { return w.header }
func (w *cancelWriter) WriteHeader(int)     {}
func (w *cancelWriter) Write(b []byte) (int, error) {
	if w.n++; w.n == 1 {
		w.at = time.Now()
		w.cancel()
	}
	return len(b), nil
}
func (w *cancelWriter) Flush() {}

func TestSearchCancel(t *testing.T) {
	path := "../../testdata/big/big_loop.trc"
	if _, err := os.Stat(path); err != nil {
		// the biggest fixture
		files, _ := filepath.Glob("../../testdata/traces/*/*.trc")
		var size int64
		for _, f := range files {
			if st, err := os.Stat(f); err == nil && st.Size() > size {
				path, size = f, st.Size()
			}
		}
		t.Logf("no big_loop.trc: using %s (%d bytes)", path, size)
	}
	li, err := trace.OpenLineIndex(path)
	if err != nil {
		t.Skip(err)
	}
	defer li.Close()
	s := &Server{lis: []*trace.LineIndex{li}}
	for _, q := range []string{
		"q=WAIT+%23&limit=10000000",                      // literal
		"q=wait+%23&case=0&limit=10000000",               // folded literal
		"q=%5EWAIT.%2B%5Cd%2B%24&regex=1&limit=10000000", // regex
	} {
		ctx, cancel := context.WithCancel(context.Background())
		w := &cancelWriter{header: http.Header{}, cancel: cancel}
		req := httptest.NewRequest("GET", "/api/search?"+q, nil).WithContext(ctx)
		s.search(w, req)
		stopped := time.Since(w.at)
		cancel()
		if w.n == 0 {
			t.Fatalf("%s: no hit", q)
		}
		if stopped > 100*time.Millisecond {
			t.Errorf("%s: stopped %v after the cancel, want < 100ms", q, stopped)
		}
		if w.n > 3 {
			t.Errorf("%s: %d writes after the cancel", q, w.n)
		}
		t.Logf("%s: stopped %v after the first hit", q, stopped)
	}
}

// TestSearchCancelMidScan cancels a scan that has no hits to stop on.
func TestSearchCancelMidScan(t *testing.T) {
	path := "../../testdata/big/big_loop.trc"
	if _, err := os.Stat(path); err != nil {
		t.Skip("no big_loop.trc")
	}
	li, err := trace.OpenLineIndex(path)
	if err != nil {
		t.Skip(err)
	}
	defer li.Close()
	s := &Server{lis: []*trace.LineIndex{li}}
	for _, q := range []string{
		"q=zzzqqq-not-there&case=0",
		"q=zzzqqq.%2Bnot-there&regex=1",
	} {
		ctx, cancel := context.WithCancel(context.Background())
		w := &cancelWriter{header: http.Header{}, cancel: func() {}}
		req := httptest.NewRequest("GET", "/api/search?"+q, nil).WithContext(ctx)
		var stamp atomic.Int64
		timer := time.AfterFunc(20*time.Millisecond, func() { stamp.Store(time.Now().UnixNano()); cancel() })
		start := time.Now()
		s.search(w, req)
		end := time.Now()
		timer.Stop()
		if stamp.Load() == 0 {
			t.Logf("%s: finished in %v before the cancel", q, end.Sub(start))
			continue
		}
		if d := end.Sub(time.Unix(0, stamp.Load())); d > 100*time.Millisecond {
			t.Errorf("%s: stopped %v after the cancel", q, d)
		} else {
			t.Logf("%s: stopped %v after the cancel", q, d)
		}
		if w.n != 0 {
			t.Errorf("%s: %d writes", q, w.n)
		}
	}
}

// ---- lines annot -------------------------------------------------------------

// kindRecorder maps line numbers to the kind the parser reported them as.
type kindRecorder struct {
	trace.NopHandler
	kinds map[int]string
}

func (r *kindRecorder) HeaderLine(h trace.Header)   { r.kinds[h.Line] = "header" }
func (r *kindRecorder) Marker(m trace.Marker)       { r.kinds[m.Line] = "marker" }
func (r *kindRecorder) Cursor(c trace.CursorHeader) { r.kinds[c.Line] = "parsing-in-cursor" }
func (r *kindRecorder) Wait(w trace.Wait)           { r.kinds[w.Line] = "wait" }
func (r *kindRecorder) Stat(s trace.Stat)           { r.kinds[s.Line] = "stat" }
func (r *kindRecorder) Binds(b trace.BindSet) {
	if b.IsRPC {
		r.kinds[b.Line] = "rpc"
	} else {
		r.kinds[b.Line] = "binds"
	}
}
func (r *kindRecorder) Xctend(x trace.Xctend)         { r.kinds[x.Line] = "xctend" }
func (r *kindRecorder) Error(e trace.Error)           { r.kinds[e.Line] = "error" }
func (r *kindRecorder) ParseError(p trace.ParseError) { r.kinds[p.Line] = "parse-error" }
func (r *kindRecorder) RPCCall(c trace.RPCCall)       { r.kinds[c.Line] = "rpc" }
func (r *kindRecorder) Separator(line int)            { r.kinds[line] = "separator" }
func (r *kindRecorder) Unknown(line int, _ []byte)    { r.kinds[line] = "unknown" }
func (r *kindRecorder) Call(c trace.Call) {
	switch {
	case c.Kind >= trace.CallLobRead && c.Kind <= trace.CallLobOther:
		r.kinds[c.Line] = "lob"
	case c.Kind == trace.CallRPCExec:
		r.kinds[c.Line] = "rpc"
	default:
		r.kinds[c.Line] = "call"
	}
}

func TestLinesAnnot(t *testing.T) {
	for name, paths := range fixtureSets(t) {
		if len(paths) > 1 {
			continue
		}
		t.Run(name, func(t *testing.T) {
			rec := &kindRecorder{kinds: map[int]string{}}
			if _, err := trace.ParseFile(paths[0], rec); err != nil {
				t.Fatal(err)
			}
			li, err := trace.OpenLineIndex(paths[0])
			if err != nil {
				t.Fatal(err)
			}
			defer li.Close()
			h := LinesHandler([]*trace.LineIndex{li})
			type page struct {
				From, Total int
				Lines       []struct{ T, K string }
			}
			get := func(from, n int) page {
				code, b := fetch(h, fmt.Sprintf("/api/lines?file=0&from=%d&n=%d&annot=1", from, n))
				if code != 200 {
					t.Fatalf("%d %s", code, b)
				}
				var p page
				if err := json.Unmarshal(b, &p); err != nil {
					t.Fatal(err)
				}
				return p
			}
			// one big page and small odd-sized pages must agree with each
			// other and with the parser on every record line
			whole := get(1, MaxLines)
			if whole.From != 1 || whole.Total != li.Lines() || len(whole.Lines) != min(li.Lines(), MaxLines) {
				t.Fatalf("whole page: from %d total %d lines %d (file has %d)", whole.From, whole.Total, len(whole.Lines), li.Lines())
			}
			raw, _ := li.Read(1, MaxLines)
			for i, l := range splitLines(raw) {
				if whole.Lines[i].T != string(l) {
					t.Fatalf("line %d text %q, want %q", i+1, whole.Lines[i].T, l)
				}
				if want, ok := rec.kinds[i+1]; ok && whole.Lines[i].K != want {
					t.Fatalf("line %d %q: kind %s, parser %s", i+1, l, whole.Lines[i].K, want)
				}
			}
			wrong := 0
			for from := 1; from <= li.Lines(); from += 97 {
				p := get(from, 97)
				for i, l := range p.Lines {
					if want, ok := rec.kinds[from+i]; ok && l.K != want {
						wrong++
						if wrong < 4 {
							t.Logf("page from %d: line %d %q: kind %s, parser %s", from, from+i, l.T, l.K, want)
						}
					}
				}
			}
			if wrong > 0 && !strings.Contains(name, "nasty") {
				t.Errorf("%d lines of small pages differ from the parser", wrong)
			}
			if p := get(li.Lines()+1, 10); len(p.Lines) != 0 || p.Total != li.Lines() {
				t.Errorf("past the end: %+v", p)
			}
		})
	}
}

func TestLinesPlainUnchanged(t *testing.T) {
	li, err := trace.OpenLineIndex(traces + "io_waits.trc")
	if err != nil {
		t.Fatal(err)
	}
	defer li.Close()
	h := LinesHandler([]*trace.LineIndex{li})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/lines?file=0&from=5&n=10", nil))
	want, _ := li.Read(5, 10)
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), want) || rec.Header().Get("Content-Type") != "text/plain; charset=utf-8" || rec.Header().Get("X-Total-Lines") == "" {
		t.Errorf("plain answer changed: %d %q", rec.Code, rec.Header())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/lines?file=0&from=5&n=2&annot=1", nil))
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("annot Content-Type %q", ct)
	}
}

func TestClassifyRunSeedsSQLState(t *testing.T) {
	// a page that starts inside a long statement: the END OF STMT within the
	// page reveals it
	lines := [][]byte{[]byte("  from dual"), []byte("  where x = 1"), []byte("END OF STMT"), []byte("PARSE #1:c=0,e=0,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=1")}
	got := classifyRun(lines, 500)
	want := []trace.Kind{trace.KindSQLText, trace.KindSQLText, trace.KindEndOfStmt, trace.KindCall}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d: %s, want %s", i, got[i], want[i])
		}
	}
	// at the start of a file END OF STMT without a statement is not seeded
	if got := classifyRun(lines, 1); got[0] != trace.KindHeader && got[0] != trace.KindUnknown {
		t.Errorf("file start: %s", got[0])
	}
}

// TestMeasureBig prints the timings of the line endpoints on testdata/big
// (MTKPROF_MEASURE=1; they are the budgets of docs/PLAN-DESKTOP.md § 9).
func TestMeasureBig(t *testing.T) {
	path := "../../testdata/big/big_loop.trc"
	if os.Getenv("MTKPROF_MEASURE") == "" {
		t.Skip("set MTKPROF_MEASURE=1")
	}
	if _, err := os.Stat(path); err != nil {
		t.Skip("no big_loop.trc")
	}
	t0 := time.Now()
	agg, sp := buildSpilled(t, []string{path}, t.TempDir())
	defer sp.Close()
	src, _ := sp.Source()
	li, err := trace.OpenLineIndex(path)
	if err != nil {
		t.Fatal(err)
	}
	defer li.Close()
	t.Logf("build + spill + index: %v; %d lines, %d calls, %d waits", time.Since(t0).Round(time.Millisecond), li.Lines(), src.NumCalls(), src.NumWaits())
	h := NewServer(agg, src).WithLines([]*trace.LineIndex{li}).Handler()

	// a rare string: a token of the last line with a statement
	tail, _ := li.Read(li.Lines()-3, 1)
	rare := strings.Fields(string(tail))
	needle := rare[len(rare)-1]
	for _, q := range []struct{ name, query string }{
		{"literal rare", "q=" + needle + "&limit=10"},
		{"literal rare, fold", "q=" + needle + "&case=0&limit=10"},
		{"literal common (WAIT #), limit 1000", "q=WAIT+%23"},
		{"regex rare", "q=" + needle + "&regex=1&limit=10"},
	} {
		for i := 0; i < 2; i++ {
			rec := &timedWriter{header: http.Header{}}
			start := time.Now()
			h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/search?"+q.query, nil))
			total := time.Since(start)
			first := time.Duration(0)
			if !rec.first.IsZero() {
				first = rec.first.Sub(start)
			}
			if i == 1 {
				t.Logf("search %-38s total %v, first write %v, %d writes", q.name, total.Round(time.Millisecond), first.Round(time.Microsecond), rec.n)
			}
		}
	}
	for _, from := range []int{1, 1_000_001, li.Lines() - 2000} {
		var worst, sum time.Duration
		for i := 0; i < 10; i++ {
			start := time.Now()
			code, b := fetch(h, fmt.Sprintf("/api/lines?file=0&from=%d&n=2000&annot=1", from+i*2000))
			d := time.Since(start)
			if code != 200 {
				t.Fatal(code, b)
			}
			sum += d
			worst = max(worst, d)
		}
		t.Logf("annot page 2000 lines from %d: avg %v, worst %v", from, (sum / 10).Round(time.Microsecond), worst.Round(time.Microsecond))
	}
	var sum, worst time.Duration
	n := 200
	for i := 0; i < n; i++ {
		line := 1 + (i*977+13)*li.Lines()/(n*977+13)
		start := time.Now()
		code, b := fetch(h, fmt.Sprintf("/api/at?file=0&line=%d", line))
		d := time.Since(start)
		if code != 200 {
			t.Fatal(code, b)
		}
		sum += d
		worst = max(worst, d)
	}
	t.Logf("at: avg %v, worst %v over %d lines", (sum / time.Duration(n)).Round(time.Microsecond), worst.Round(time.Microsecond), n)
	sum, worst = 0, 0
	for i := 0; i < n; i++ {
		start := time.Now()
		code, b := fetch(h, fmt.Sprintf("/api/lines/at?file=0&tim=%d", int64(i)*1_000_000+agg.File.Files[0].FirstTim))
		d := time.Since(start)
		if code != 200 {
			t.Fatal(code, b)
		}
		sum += d
		worst = max(worst, d)
	}
	t.Logf("lines/at: avg %v, worst %v over %d tims", (sum / time.Duration(n)).Round(time.Microsecond), worst.Round(time.Microsecond), n)
}

type timedWriter struct {
	header http.Header
	first  time.Time
	n      int
}

func (w *timedWriter) Header() http.Header { return w.header }
func (w *timedWriter) WriteHeader(int)     {}
func (w *timedWriter) Write(b []byte) (int, error) {
	if w.first.IsZero() {
		w.first = time.Now()
	}
	w.n++
	return len(b), nil
}
func (w *timedWriter) Flush() {}
