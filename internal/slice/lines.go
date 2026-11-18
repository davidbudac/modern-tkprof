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
// annotate for how the SQL-text state of a page that starts mid-file is seeded;
// the lines of optimizer dumps and diagnostic dump sections are "optimizer"
// and "diagnostic" where the server knows them).
//
// With annot=2 (only where a Server serves it, see Server.Handler; otherwise
// it answers like annot=1) every line also carries the ids `at` would answer
// for it, see annotate2.
func LinesHandler(lis []*trace.LineIndex) http.Handler { return linesHandler(lis, nil, nil) }

// LinesHandlerDumps is LinesHandler for a server that has no model but knows the
// optimizer (10053) dumps of each file (dumps[fi]): their lines are annotated as
// optimizer lines.
func LinesHandlerDumps(lis []*trace.LineIndex, dumps [][]trace.Dump) http.Handler {
	return LinesHandlerRanges(lis, dumps, nil)
}

// LinesHandlerRanges is LinesHandlerDumps for a server that also knows the
// diagnostic dump sections of each file (sections[fi]): their lines are
// annotated as diagnostic lines.
func LinesHandlerRanges(lis []*trace.LineIndex, dumps [][]trace.Dump, sections [][]trace.Section) http.Handler {
	return linesHandler(lis, func(fi int) *marks {
		var mk marks
		if fi < len(dumps) {
			mk.dumps = dumps[fi]
		}
		if fi < len(sections) {
			mk.sections = sections[fi]
		}
		if len(mk.dumps) == 0 && len(mk.sections) == 0 {
			return nil
		}
		return &mk
	}, nil)
}

// linesHandler is LinesHandler; marksOf (when not nil) gives the optimizer dumps and diagnostic sections of file fi; ann2 (when not nil) serves annot=2 of file fi.
func linesHandler(lis []*trace.LineIndex, marksOf func(fi int) *marks, ann2 func(w http.ResponseWriter, fi int, from, n int)) http.Handler {
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
		annot := r.URL.Query().Get("annot")
		if annot == "2" && ann2 != nil {
			ann2(w, fi, from, n)
			return
		}
		if annot == "1" || annot == "2" {
			var mk *marks
			if marksOf != nil {
				mk = marksOf(fi)
			}
			serveAnnotated(w, li, from, n, mk)
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
