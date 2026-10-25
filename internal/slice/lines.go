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
// as text/plain with the file's line count in X-Total-Lines.
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
