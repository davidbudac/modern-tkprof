package engine

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/ui"
)

// cliModels are the models `mtkprof` builds for a trace: the full one
// (report, export) and the aggregation-only one (`-aggregate`) a session has.
func cliModels(t *testing.T, path string) (full, agg *model.Model) {
	t.Helper()
	path = absPaths(t, []string{path})[0]
	full, err := model.BuildFiles([]string{path}, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	// the session's model: aggregation-only, bind sets in the spill (not in the model)
	sp, err := slice.NewSpill(slice.SpillOptions{Dir: t.TempDir(), Key: slice.SpillKey([]string{path}), BindMode: model.BindsKeep})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sp.Close() })
	agg, err = model.BuildFiles([]string{path}, model.Options{NoFacts: true, Aggregate: true, SpillBinds: true,
		NewSink: func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, analyze.DefaultThresholds()) },
		NewTee:  sp.Attach})
	if err != nil {
		t.Fatal(err)
	}
	return full, agg
}

func mask(b []byte) []byte { return generatedRe.ReplaceAll(b, []byte(`"generated":""`)) }

// TestReportEndpoint: GET /s/{id}/api/report answers what the CLI writes for
// the same model and options, byte for byte (the document's timestamp
// apart), for a session opened from scratch and one opened from the cache.
func TestReportEndpoint(t *testing.T) {
	e := newEnv(t)
	for _, fx := range []string{"basic_binds.trc", "io_waits.trc"} {
		full, agg := cliModels(t, traces+fx)
		base := strings.TrimSuffix(fx, ".trc")
		for _, pass := range []string{"parsed", "cached"} {
			sid := e.openReady([]string{traces + fx}, nil)
			if hit := e.wait(sid).Hit; hit != (pass == "cached") {
				t.Fatalf("%s %s: hit %v", fx, pass, hit)
			}
			rq := func(q string) resp {
				t.Helper()
				r := e.req("GET", "/s/"+sid+"/api/report"+q, nil)
				if r.code != 200 {
					t.Fatalf("%s %s %s: %d %s", fx, pass, q, r.code, r.body)
				}
				return r
			}
			disp := func(r resp, ext string) {
				t.Helper()
				if d := r.hdr.Get("Content-Disposition"); d != `attachment; filename="`+base+ext+`"` {
					t.Errorf("%s: Content-Disposition %q", fx, d)
				}
			}

			// text: the defaults are the CLI's, every option reaches the report
			for _, tc := range []struct {
				q string
				o report.TextOptions
			}{
				{"", report.TextOptions{Sort: "elapsed", Execs: 20, Binds: 5, Sys: true, Width: 120}},
				{"?format=text&sort=cpu&top=3&execs=-1&binds=0&sys=0&width=100", report.TextOptions{Sort: "cpu", Top: 3, Execs: -1, Binds: 0, Sys: false, Width: 100}},
				{"?format=text&sort=line&execs=0&width=160", report.TextOptions{Sort: "line", Execs: 0, Binds: 5, Sys: true, Width: 160}},
			} {
				var want bytes.Buffer
				if err := report.Text(&want, agg, tc.o); err != nil {
					t.Fatal(err)
				}
				r := rq(tc.q)
				if !bytes.Equal(r.body, want.Bytes()) {
					t.Errorf("%s text %s: %d bytes, want %d", fx, tc.q, len(r.body), want.Len())
				}
				if ct := r.hdr.Get("Content-Type"); ct != "text/plain; charset=utf-8" {
					t.Errorf("Content-Type %q", ct)
				}
				disp(r, ".txt")
			}
			// against the CLI's own full report: the same but for the executions
			// tables and the bind set count of the Volume line (the sets are in the spill)
			o := report.TextOptions{Sort: "elapsed", Execs: 0, Binds: 0, Sys: true, Width: 120}
			var cli bytes.Buffer
			if err := report.Text(&cli, full, o); err != nil {
				t.Fatal(err)
			}
			setsRe := regexp.MustCompile(`bind sets [0-9,]+`)
			got := strings.Split(setsRe.ReplaceAllString(string(rq("?execs=0&binds=0").body), "bind sets N"), "\n")
			want := strings.Split(setsRe.ReplaceAllString(cli.String(), "bind sets N"), "\n")
			if len(got) != len(want) {
				t.Fatalf("%s: text report has %d lines, the CLI's %d", fx, len(got), len(want))
			}
			for i := range want {
				if got[i] != want[i] && !strings.HasPrefix(want[i], "Notes") {
					t.Errorf("%s: text line %d differs:\n  cli    %s\n  engine %s", fx, i+1, want[i], got[i])
				}
			}

			// json: `mtkprof json -aggregate`
			var doc bytes.Buffer
			if err := report.JSON(&doc, agg, report.DocOptions{PlanVizURL: report.DefaultPlanVizURL}); err != nil {
				t.Fatal(err)
			}
			r := rq("?format=json")
			if !bytes.Equal(mask(r.body), mask(doc.Bytes())) {
				t.Errorf("%s json: %d bytes, want %d", fx, len(r.body), doc.Len())
			}
			if ct := r.hdr.Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type %q", ct)
			}
			disp(r, ".json")

			// csv: the files of `mtkprof export` on the full model, in a zip
			dir := t.TempDir()
			written, err := report.ExportCSV(full, dir)
			if err != nil {
				t.Fatal(err)
			}
			r = rq("?format=csv")
			if ct := r.hdr.Get("Content-Type"); ct != "application/zip" {
				t.Errorf("Content-Type %q", ct)
			}
			disp(r, ".csv.zip")
			zr, err := zip.NewReader(bytes.NewReader(r.body), int64(len(r.body)))
			if err != nil {
				t.Fatal(err)
			}
			if len(zr.File) != len(written) {
				t.Errorf("%s csv: %d files in the zip, %d exported", fx, len(zr.File), len(written))
			}
			for i, f := range zr.File {
				rc, err := f.Open()
				if err != nil {
					t.Fatal(err)
				}
				b, _ := io.ReadAll(rc)
				rc.Close()
				wb, err := os.ReadFile(filepath.Join(dir, f.Name))
				if err != nil || filepath.Base(written[i]) != f.Name {
					t.Fatalf("%s csv: zip entry %d %q vs exported %v (%v)", fx, i, f.Name, written, err)
				}
				if !bytes.Equal(b, wb) {
					t.Errorf("%s %s: %d bytes, the CLI's %d", fx, f.Name, len(b), len(wb))
				}
			}

			// html: the document of `json` (packed) in the UI page
			if ui.Built() {
				var page bytes.Buffer
				err := ui.WriteStandalone(&page, func(w io.Writer) error {
					return report.WriteDocument(w, agg, report.DocOptions{Packed: true, PlanVizURL: report.DefaultPlanVizURL})
				})
				if err != nil {
					t.Fatal(err)
				}
				r = rq("?format=html")
				if !bytes.Equal(mask(r.body), mask(page.Bytes())) {
					t.Errorf("%s html: %d bytes, want %d", fx, len(r.body), page.Len())
				}
				if ct := r.hdr.Get("Content-Type"); ct != "text/html; charset=utf-8" {
					t.Errorf("Content-Type %q", ct)
				}
				disp(r, ".html")
			}
		}
	}
}

func TestReportEndpointErrors(t *testing.T) {
	e := newEnv(t)
	sid := e.openReady([]string{traces + "basic_binds.trc"}, nil)
	for _, q := range []string{"?format=pdf", "?format=", "?sort=nope", "?top=-1", "?top=x", "?execs=-2", "?binds=-1", "?width=5000", "?sys=maybe"} {
		r := e.req("GET", "/s/"+sid+"/api/report"+q, nil)
		want := 400
		if q == "?format=" { // empty = the default
			want = 200
		}
		if r.code != want {
			t.Errorf("%s: %d %.100s, want %d", q, r.code, r.body, want)
		} else if want == 400 && decode[struct{ Error Error }](t, r.body).Error.Code != CodeBadRequest {
			t.Errorf("%s: not the bad_request envelope: %s", q, r.body)
		}
	}
	// redacted and dropped bind values: every format still answers
	for _, binds := range []string{"redact", "none"} {
		bid := e.openReady([]string{traces + "basic_binds.trc"}, map[string]any{"binds": binds})
		for _, f := range []string{"text", "json", "csv", "html"} {
			if r := e.req("GET", "/s/"+bid+"/api/report?format="+f, nil); r.code != 200 || len(r.body) == 0 {
				t.Errorf("binds %s, format %s: %d %.100s", binds, f, r.code, r.body)
			}
		}
	}
	if r := e.req("GET", "/s/nosuch/api/report", nil); r.code != 404 {
		t.Errorf("unknown session: %d", r.code)
	}
	if r := e.req("GET", "/s/"+sid+"/api/report", nil, "Authorization", ""); r.code != 401 {
		t.Errorf("no token: %d", r.code)
	}
	if got := contentDisposition("a\"b é.txt"); got != `attachment; filename="a_b _.txt"; filename*=UTF-8''a%22b%20%C3%A9.txt` {
		t.Errorf("contentDisposition: %s", got)
	}
}

// TestReportBigTiming measures api/report on a large trace:
// MTKPROF_BIG=/path/to/big_loop.trc go test ./internal/engine -run ReportBig -v
func TestReportBigTiming(t *testing.T) {
	p := os.Getenv("MTKPROF_BIG")
	if p == "" {
		t.Skip("MTKPROF_BIG not set")
	}
	e := newEnv(t)
	start := time.Now()
	sid := e.openReady([]string{p}, nil)
	t.Logf("open (parse + persist) %v", time.Since(start).Round(time.Millisecond))
	for _, f := range []string{"text", "text&execs=0", "json", "html", "csv"} {
		for i := 0; i < 2; i++ {
			start = time.Now()
			r := e.req("GET", "/s/"+sid+"/api/report?format="+f, nil)
			t.Logf("format=%s: %d, %.1f MB, %v", f, r.code, float64(len(r.body))/1e6, time.Since(start).Round(time.Millisecond))
		}
	}
}
