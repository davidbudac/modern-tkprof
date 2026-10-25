package slice

import (
	"net/http"
	"strconv"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// MaxLines caps one /api/lines answer.
const MaxLines = 2000

// LinesHandler answers GET /api/lines?file=i&from=L&n=N: up to N (at most
// MaxLines) raw lines of input file i (0 = first) starting at 1-based line L,
// as text/plain with the file's line count in X-Total-Lines. With annot=1 the
// answer is JSON {"from","total","lines":[{"t","k"}]}: each line without its
// terminator and its kind (trace.Kind.String(), see trace.Classify and
// annotate for how the SQL-text state of a page that starts mid-file is seeded).
func LinesHandler(lis []*trace.LineIndex) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fi, _ := strconv.Atoi(r.URL.Query().Get("file"))
		if fi < 0 || fi >= len(lis) {
			http.Error(w, "no such file", http.StatusNotFound)
			return
		}
		li := lis[fi]
		from, _ := strconv.Atoi(r.URL.Query().Get("from"))
		n, err := strconv.Atoi(r.URL.Query().Get("n"))
		if err != nil || n > MaxLines {
			n = MaxLines
		}
		if r.URL.Query().Get("annot") == "1" {
			serveAnnotated(w, li, from, n)
			return
		}
		b, err := li.Read(from, n)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Total-Lines", strconv.Itoa(li.Lines()))
		w.Write(b)
	})
}
