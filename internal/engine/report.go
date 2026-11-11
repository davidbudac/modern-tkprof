package engine

import (
	"bufio"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/opt"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/ui"
)

// reportSorts are the statement orders of the text report (`mtkprof report -sort`).
var reportSorts = []string{"elapsed", "self", "cpu", "execs", "disk", "query", "rows", "line"}

// sessionReport serves GET /s/{id}/api/report: the outputs of `mtkprof
// report`, `json`, `export` and `html` for the session's model. The model is
// the aggregate one `serve -spill` has, so: the text report leaves out the
// executions tables (as `report -aggregate`), the JSON and HTML documents
// carry no fact tables (the HTML report's drill-downs have nothing to show),
// and the CSV tables calls, waits and binds are read from the spill.
type sessionReport struct {
	m       *model.Model
	src     slice.FactSource
	th      *analyze.Thresholds
	base    string // download name without extension
	planViz string
	ss      *Session
	opt     *slice.OptServer // the session's 10053 file; nil for any other
}

func newSessionReport(ss *Session, co *CacheOpened, planViz string, ot *slice.OptServer) *sessionReport {
	base := "mtkprof"
	if len(ss.paths) > 0 {
		base = filepath.Base(strings.TrimSuffix(strings.TrimRight(ss.paths[0], "/\\"), ".trc"))
	}
	if planViz == "" {
		planViz = report.DefaultPlanVizURL
	}
	return &sessionReport{m: co.Model, src: co.Source, th: ss.th, base: base, planViz: planViz, ss: ss, opt: ot}
}

// optInput is the input of the documents and the text report of a 10053
// session, made for a client without a server: with the digest. The returned
// function closes the file's line reader.
func (sr *sessionReport) optInput() (*report.OptInput, func(), error) {
	in := sr.ss.optInput(sr.opt, true)
	if in == nil {
		return nil, nil, errorf(CodeInternal, "the 10053 file cannot be read")
	}
	line, closeFn, err := opt.FileLines(sr.m.File.Files[0].Path)
	if err != nil {
		return nil, nil, errorf(CodeInternal, "%v", err)
	}
	in.Line = line
	return in, func() { closeFn() }, nil
}

// countWriter counts the bytes that reached the response, to tell a failure
// before the first byte (an error envelope) from one in the middle.
type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func (sr *sessionReport) serve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	format := q.Get("format")
	if format == "" {
		format = "text"
	}
	var (
		ctype, ext string
		write      func(w io.Writer) error
	)
	switch format {
	case "text":
		o, err := textOptions(q, sr.th)
		if err != nil {
			writeError(w, err)
			return
		}
		ctype, ext = "text/plain; charset=utf-8", ".txt"
		write = func(w io.Writer) error { return report.Text(w, sr.m, o) }
		if sr.opt != nil { // a 10053 file: its digest
			write = func(w io.Writer) error {
				in, done, err := sr.optInput()
				if err != nil {
					return err
				}
				defer done()
				return report.OptText(w, in)
			}
		}
	case "json":
		ctype, ext = "application/json", ".json"
		write = func(w io.Writer) error {
			do := report.DocOptions{Facts: false, Packed: false, PlanVizURL: sr.planViz, Thresholds: sr.th}
			if sr.opt != nil {
				in, done, err := sr.optInput()
				if err != nil {
					return err
				}
				defer done()
				do.Opt = in
			}
			return report.JSON(w, sr.m, do)
		}
	case "csv":
		if sr.opt != nil {
			writeError(w, errorf(CodeBadRequest, "%s is a 10053 file: nothing to export as tables; format=text is its digest", sr.m.File.Files[0].Name))
			return
		}
		ctype, ext = "application/zip", ".csv.zip"
		write = func(w io.Writer) error { return report.ExportCSVZip(r.Context(), w, sr.m, sr.src) }
	case "html":
		if !ui.Built() {
			writeError(w, errorf(CodeInternal, "built without the web UI (make web, then rebuild)"))
			return
		}
		ctype, ext = "text/html; charset=utf-8", ".html"
		write = func(w io.Writer) error {
			do := report.DocOptions{Facts: false, Packed: true, PlanVizURL: sr.planViz, Thresholds: sr.th}
			if sr.opt != nil {
				in, done, err := sr.optInput()
				if err != nil {
					return err
				}
				defer done()
				do.Opt = in
			}
			return ui.WriteStandalone(w, func(w io.Writer) error {
				return report.WriteDocument(w, sr.m, do)
			})
		}
	default:
		writeError(w, errorf(CodeBadRequest, "format: want text, json, csv or html"))
		return
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Content-Disposition", contentDisposition(sr.base+ext))
	h.Set("Cache-Control", "no-store")
	cw := &countWriter{w: w}
	bw := bufio.NewWriterSize(cw, 256<<10)
	err := write(bw)
	if err == nil {
		err = bw.Flush()
	}
	if err != nil && cw.n == 0 && r.Context().Err() == nil {
		h.Del("Content-Disposition")
		writeError(w, err)
	}
	// else: the status line is long sent, the answer just ends short
}

// textOptions are the TextOptions of the query, the defaults those of the CLI
// (`mtkprof report`): sort=elapsed, top=0 (all), execs=20 (-1 = all, 0 =
// none), binds=5 (bind sets per statement; the bind value mode is the
// session's), sys=1, width=120 (below 80: 120).
func textOptions(q url.Values, th *analyze.Thresholds) (report.TextOptions, error) {
	o := report.TextOptions{Sort: "elapsed", Execs: 20, Binds: 5, Sys: true, Width: 120, Thresholds: th}
	if v := q.Get("sort"); v != "" {
		if !slices.Contains(reportSorts, v) {
			return o, errorf(CodeBadRequest, "sort: want one of %s", strings.Join(reportSorts, ", "))
		}
		o.Sort = v
	}
	for _, p := range []struct {
		name     string
		dst      *int
		min, max int
	}{{"top", &o.Top, 0, 1 << 30}, {"execs", &o.Execs, -1, 1 << 30}, {"binds", &o.Binds, 0, 1 << 30}, {"width", &o.Width, 0, 1000}} {
		v := q.Get(p.name)
		if v == "" {
			continue
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < p.min || n > p.max {
			return o, errorf(CodeBadRequest, "%s: %q is not an integer in %d..%d", p.name, v, p.min, p.max)
		}
		*p.dst = n
	}
	if v := q.Get("sys"); v != "" {
		switch v {
		case "1", "true":
			o.Sys = true
		case "0", "false":
			o.Sys = false
		default:
			return o, errorf(CodeBadRequest, "sys: want 0 or 1")
		}
	}
	return o, nil
}

// contentDisposition is an attachment header for name, with an ASCII fallback
// and the RFC 5987 form for the real name.
func contentDisposition(name string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' || r == '%' {
			return '_'
		}
		return r
	}, name)
	s := `attachment; filename="` + ascii + `"`
	if ascii != name {
		s += "; filename*=UTF-8''" + url.PathEscape(name)
	}
	return s
}
