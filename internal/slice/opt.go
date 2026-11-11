package slice

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"

	"github.com/davidbudac/modern-tkprof/internal/opt"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// The two routes of a 10053 file (docs/PLAN-10053.md § Build contract):
//
//	GET /api/opt/dump?i=N   opt.Dump of dump N as JSON
//	GET /api/opt/text?i=N   the lines ViewFrom..ViewTo of dump N, joined by \n, no \r
//
// 404 when the server is not for a 10053 file or N is not a dump of it.

// OptRoutes are the paths an OptServer serves (GET).
func OptRoutes() []string { return []string{"/api/opt/dump", "/api/opt/text"} }

// OptServer serves the routes of one 10053 file. The scan of the file is
// made once (at about 300 MB/s) and kept; the text is read through the line
// index of the file when the server has one, else through one the server
// makes on first use. A nil *OptServer is a server for a file that is not a
// 10053 one: both routes answer 404.
type OptServer struct {
	// AllowOrigin is the Access-Control-Allow-Origin as Server.AllowOrigin
	// has it: "" is "*", NoCORS sets no CORS headers.
	AllowOrigin string

	path  string
	lines *trace.LineIndex

	once sync.Once
	scan *opt.Scan
	err  error

	lrMu sync.Mutex
	lr   *opt.LineReader // when there is no line index

	mu    sync.Mutex
	dumps map[int][]byte // the JSON of the dumps served
}

// NewOptServer returns the server for the 10053 file at path. scan is the
// file's scan when the caller has it already (nil: made on first use); lines
// is its line index (nil: the server indexes the file itself when the text is
// first asked for).
func NewOptServer(path string, scan *opt.Scan, lines *trace.LineIndex) *OptServer {
	o := &OptServer{path: path, lines: lines, scan: scan, dumps: map[int][]byte{}}
	if scan != nil {
		o.once.Do(func() {})
	}
	return o
}

// Scan is the scan of the file, made on the first call.
func (o *OptServer) Scan() (*opt.Scan, error) {
	o.once.Do(func() { o.scan, o.err = opt.ScanFile(o.path) })
	return o.scan, o.err
}

// SQLIDs are the distinct sql_ids of the file's dumps in file order (a dump
// whose sql_id was not found has none).
func (o *OptServer) SQLIDs() []string {
	sc, err := o.Scan()
	if err != nil {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for _, d := range sc.Dumps {
		if d.SQLID != "" && !seen[d.SQLID] {
			seen[d.SQLID] = true
			out = append(out, d.SQLID)
		}
	}
	return out
}

// Close releases the line reader the server made for itself.
func (o *OptServer) Close() {
	if o == nil {
		return
	}
	o.lrMu.Lock()
	defer o.lrMu.Unlock()
	if o.lr != nil {
		o.lr.Close()
		o.lr = nil
	}
}

// DumpHandler serves GET /api/opt/dump.
func (o *OptServer) DumpHandler() http.Handler { return o.handler(o.serveDump) }

// TextHandler serves GET /api/opt/text.
func (o *OptServer) TextHandler() http.Handler { return o.handler(o.serveText) }

// Handler serves both routes.
func (o *OptServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/opt/dump", o.DumpHandler())
	mux.Handle("/api/opt/text", o.TextHandler())
	return mux
}

func (o *OptServer) handler(h func(w http.ResponseWriter, i int)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o != nil && o.AllowOrigin != NoCORS {
			origin := o.AllowOrigin
			if origin == "" {
				origin = "*"
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "*")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "GET only", http.StatusMethodNotAllowed)
			return
		}
		if o == nil {
			http.Error(w, "not a 10053 file", http.StatusNotFound)
			return
		}
		i, err := strconv.Atoi(r.URL.Query().Get("i"))
		if err != nil {
			http.Error(w, "i: want the number of a dump", http.StatusNotFound)
			return
		}
		h(w, i)
	})
}

func (o *OptServer) dump(w http.ResponseWriter, i int) *opt.Dump {
	sc, err := o.Scan()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return nil
	}
	if i < 0 || i >= len(sc.Dumps) {
		http.Error(w, "no such dump", http.StatusNotFound)
		return nil
	}
	return sc.Dumps[i]
}

func (o *OptServer) serveDump(w http.ResponseWriter, i int) {
	d := o.dump(w, i)
	if d == nil {
		return
	}
	o.mu.Lock()
	b, ok := o.dumps[i]
	o.mu.Unlock()
	if !ok {
		var err error
		if b, err = json.Marshal(d); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		o.mu.Lock()
		o.dumps[i] = b
		o.mu.Unlock()
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

func (o *OptServer) serveText(w http.ResponseWriter, i int) {
	d := o.dump(w, i)
	if d == nil {
		return
	}
	b, err := o.readLines(d.ViewFrom, d.LineCount)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(b)
}

// readLines is n lines from line from, joined by \n, without \r and without a
// final line terminator: exactly n lines.
func (o *OptServer) readLines(from, n int) ([]byte, error) {
	var raw []byte
	if o.lines != nil {
		var err error
		if raw, err = o.lines.Read(from, n); err != nil {
			return nil, err
		}
	} else {
		o.lrMu.Lock()
		defer o.lrMu.Unlock()
		if o.lr == nil {
			lr, err := opt.OpenLines(o.path)
			if err != nil {
				return nil, err
			}
			o.lr = lr
		}
		var buf bytes.Buffer
		for k := 0; k < n; k++ {
			s, ok := o.lr.Line(from + k)
			if !ok {
				break
			}
			buf.WriteString(s)
			buf.WriteByte('\n')
		}
		raw = buf.Bytes()
	}
	raw = bytes.ReplaceAll(raw, []byte("\r\n"), []byte("\n"))
	raw = bytes.TrimSuffix(raw, []byte("\n"))
	return raw, nil
}
