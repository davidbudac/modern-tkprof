package slice

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"

	"github.com/davidbudac/modern-tkprof/internal/diag"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// The three routes of a diag session (docs/PLAN-DIAG.md § Build contract), beside api/lines and api/search,
// which any session serves for the text of its file:
//
//	GET /api/diag/file                  diag.File: facts of the file, its sections and its top-level outline
//	GET /api/diag/outline?node=ID[&after=N]   {node, children, more, next}: the children of a node, read from
//	                                    the lines of that node alone, at most diag.Cap of them; "root" is the top level
//	GET /api/diag/reading?node=ID       the reading of a node: {kind, ...} (diag.HeapReading, PGASummary, PGADetail);
//	                                    404 "no reading for this kind of section" for a node whose kind has none;
//	                                    400 without node; 404 for an id that is not a node of the file
//	GET /api/diag/reading/lines?node=ID&comment=TEXT[&type=T][&after=N]
//	                                    for a heap reading: the numbers of the chunk lines of the extents whose
//	                                    comment group is TEXT (HeapComment.comment; "comment=" is the blank
//	                                    comment) and, with type, whose type is T (grouped: recr, or as printed),
//	                                    ascending, after line N, at most diag.LinesCap per answer:
//	                                    {node, lines, more, next, total}. comment or type is required.
//
// Errors are the engine's envelope {"error": {"code", "message"}}, also here: a diag session is the only
// one that serves these routes; for any other session they answer 404 "not a diag session".

// DiagRoutes are the paths a DiagServer serves (GET).
func DiagRoutes() []string {
	return []string{"/api/diag/file", "/api/diag/outline", "/api/diag/reading", "/api/diag/reading/lines"}
}

// DiagServer serves the routes of one diag file. The scan of the file is made once and kept; the lines the
// outline reads are read through the line index of the file when the server has one, else through one the
// server makes on first use. A nil *DiagServer is a server for a session that is not a diag one: all three
// routes answer 404.
type DiagServer struct {
	// AllowOrigin is the Access-Control-Allow-Origin as Server.AllowOrigin has it: "" is "*", NoCORS sets no
	// CORS headers.
	AllowOrigin string

	path string

	once sync.Once
	scan *diag.Scan
	err  error

	mu     sync.Mutex
	lines  *trace.LineIndex // the engine's, or made here
	own    bool             // lines is ours to close
	reader *diag.Reader
	file   []byte // the JSON of diag.File
}

// NewDiagServer returns the server for the file at path. scan is the file's scan when the caller has it
// already (nil: made on first use); lines is its line index (nil: made on first use).
func NewDiagServer(path string, scan *diag.Scan, lines *trace.LineIndex) *DiagServer {
	d := &DiagServer{path: path, scan: scan, lines: lines}
	if scan != nil {
		d.once.Do(func() {})
	}
	return d
}

// Scan is the scan of the file, made on the first call.
func (d *DiagServer) Scan() (*diag.Scan, error) {
	d.once.Do(func() { d.scan, d.err = diag.ScanFile(d.path) })
	return d.scan, d.err
}

// Reader is the reader of the file: its scan and its lines.
func (d *DiagServer) Reader() (*diag.Reader, error) {
	sc, err := d.Scan()
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.reader == nil {
		if d.lines == nil {
			li, err := trace.OpenLineIndex(d.path)
			if err != nil {
				return nil, err
			}
			d.lines, d.own = li, true
		}
		d.reader = diag.NewReader(sc, d.lines)
	}
	return d.reader, nil
}

// Close releases the line index the server made for itself.
func (d *DiagServer) Close() {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.own && d.lines != nil {
		d.lines.Close()
		d.lines, d.own, d.reader = nil, false, nil
	}
}

// FileHandler serves GET /api/diag/file.
func (d *DiagServer) FileHandler() http.Handler { return d.handler(d.serveFile) }

// OutlineHandler serves GET /api/diag/outline.
func (d *DiagServer) OutlineHandler() http.Handler { return d.handler(d.serveOutline) }

// ReadingHandler serves GET /api/diag/reading.
func (d *DiagServer) ReadingHandler() http.Handler { return d.handler(d.serveReading) }

// ReadingLinesHandler serves GET /api/diag/reading/lines.
func (d *DiagServer) ReadingLinesHandler() http.Handler { return d.handler(d.serveReadingLines) }

// Handler serves the routes.
func (d *DiagServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/diag/file", d.FileHandler())
	mux.Handle("/api/diag/outline", d.OutlineHandler())
	mux.Handle("/api/diag/reading", d.ReadingHandler())
	mux.Handle("/api/diag/reading/lines", d.ReadingLinesHandler())
	return mux
}

func (d *DiagServer) handler(h func(w http.ResponseWriter, r *http.Request)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if d != nil && d.AllowOrigin != NoCORS {
			origin := d.AllowOrigin
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
			writeEnvelope(w, http.StatusMethodNotAllowed, "bad_request", "GET only")
			return
		}
		if d == nil {
			writeEnvelope(w, http.StatusNotFound, "not_found", "not a diag session")
			return
		}
		h(w, r)
	})
}

// writeEnvelope writes the engine's error envelope.
func writeEnvelope(w http.ResponseWriter, status int, code, msg string) {
	b, _ := json.Marshal(struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{Error: struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{code, msg}})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(b)
}

func writeJSONBytes(w http.ResponseWriter, b []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

func (d *DiagServer) serveFile(w http.ResponseWriter, r *http.Request) {
	sc, err := d.Scan()
	if err != nil {
		writeEnvelope(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	d.mu.Lock()
	b := d.file
	d.mu.Unlock()
	if b == nil {
		if b, err = json.Marshal(sc.File); err != nil {
			writeEnvelope(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		d.mu.Lock()
		d.file = b
		d.mu.Unlock()
	}
	writeJSONBytes(w, b)
}

func (d *DiagServer) serveOutline(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	node := q.Get("node")
	if node == "" {
		writeEnvelope(w, http.StatusBadRequest, "bad_request", "node: want the id of a node (diag.Node.id), or root")
		return
	}
	after := 0
	if a := q.Get("after"); a != "" {
		n, err := strconv.Atoi(a)
		if err != nil || n < 0 {
			writeEnvelope(w, http.StatusBadRequest, "bad_request", "after: want a number of children, 0 or more")
			return
		}
		after = n
	}
	rd, err := d.Reader()
	if err != nil {
		writeEnvelope(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	o, err := rd.Children(node, after)
	if err != nil {
		code, status := "internal", http.StatusInternalServerError
		if isNoNode(err) {
			code, status = "not_found", http.StatusNotFound
		}
		writeEnvelope(w, status, code, err.Error())
		return
	}
	b, err := json.Marshal(o)
	if err != nil {
		writeEnvelope(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSONBytes(w, b)
}

// readerError answers an error of the reader: 404 for an unknown node or a node without a reading.
func readerError(w http.ResponseWriter, err error) {
	switch {
	case isNoNode(err):
		writeEnvelope(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, diag.ErrNoReading):
		writeEnvelope(w, http.StatusNotFound, "not_found", err.Error())
	default:
		writeEnvelope(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func (d *DiagServer) serveReading(w http.ResponseWriter, r *http.Request) {
	node := r.URL.Query().Get("node")
	if node == "" {
		writeEnvelope(w, http.StatusBadRequest, "bad_request", "node: want the id of a node (diag.Node.id)")
		return
	}
	rd, err := d.Reader()
	if err != nil {
		writeEnvelope(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	out, err := rd.Reading(node)
	if err != nil {
		readerError(w, err)
		return
	}
	b, err := json.Marshal(out)
	if err != nil {
		writeEnvelope(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSONBytes(w, b)
}

func (d *DiagServer) serveReadingLines(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	node := q.Get("node")
	if node == "" {
		writeEnvelope(w, http.StatusBadRequest, "bad_request", "node: want the id of a node (diag.Node.id)")
		return
	}
	if !q.Has("comment") && q.Get("type") == "" {
		writeEnvelope(w, http.StatusBadRequest, "bad_request", "comment or type: want the comment group and/or the type of the chunks")
		return
	}
	after := 0
	if a := q.Get("after"); a != "" {
		n, err := strconv.Atoi(a)
		if err != nil || n < 0 {
			writeEnvelope(w, http.StatusBadRequest, "bad_request", "after: want a line number, 0 or more")
			return
		}
		after = n
	}
	rd, err := d.Reader()
	if err != nil {
		writeEnvelope(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	out, err := rd.HeapLines(node, q.Get("comment"), q.Has("comment"), q.Get("type"), after)
	if err != nil {
		readerError(w, err)
		return
	}
	b, err := json.Marshal(out)
	if err != nil {
		writeEnvelope(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSONBytes(w, b)
}

func isNoNode(err error) bool { return errors.Is(err, diag.ErrNoNode) }
