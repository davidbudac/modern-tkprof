package slice

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// annotLookback is how many lines before the page are classified to seed the
// "inside SQL text" state of the page's first line.
const annotLookback = 64

// annotLine is one line of an annotated page.
type annotLine struct {
	T string `json:"t"`
	K string `json:"k"`
}

// annotPage is the answer of /api/lines?annot=1.
type annotPage struct {
	From  int         `json:"from"`
	Total int         `json:"total"`
	Lines []annotLine `json:"lines"`
}

// splitLines splits raw lines (each with its terminator, the last perhaps
// without) into lines without '\n' or a trailing '\r'.
func splitLines(b []byte) [][]byte {
	var out [][]byte
	for len(b) > 0 {
		i := bytes.IndexByte(b, '\n')
		var l []byte
		if i < 0 {
			l, b = b, nil
		} else {
			l, b = b[:i], b[i+1:]
		}
		out = append(out, bytes.TrimSuffix(l, []byte{'\r'}))
	}
	return out
}

// classifyRun classifies lines in order, seeding the SQL-text state: a page
// that starts in the middle of a file does not know whether its first line is
// inside a statement. `lo` is the number of the first line of `lines`.
//
// The state is seeded by classifying up to annotLookback lines before the page
// (the caller read them), and corrected once more: when the first thing the
// run meets is an END OF STMT with no PARSING IN CURSOR before it, the run
// started inside SQL text, so it is classified again from the start as SQL
// text. That covers statements longer than the lookback as long as their end
// is within the page. Beyond that the lines of a statement that starts and
// ends outside the lookback and the page are wrong only for the lines before
// the next END OF STMT (they come out as whatever their text looks like,
// usually unknown). The prologue is only known from line 1.
func classifyRun(lines [][]byte, lo int) []trace.Kind {
	kinds := make([]trace.Kind, len(lines))
	run := func(inSQL bool) (retry bool) {
		c := trace.NewClassifier(lo == 1)
		c.InSQL = inSQL
		sawPIC := false
		for i, l := range lines {
			k := c.Next(l)
			kinds[i] = k
			switch {
			case k == trace.KindParsingInCursor:
				sawPIC = true
			case !inSQL && lo > 1 && !sawPIC && k == trace.KindUnknown && string(l) == "END OF STMT":
				return true
			}
		}
		return false
	}
	if run(false) {
		run(true)
	}
	return kinds
}

// annotate returns up to n lines from line `from` (1-based) with their kinds.
func annotate(li *trace.LineIndex, from, n int) ([]annotLine, error) {
	lo := max(1, from-annotLookback)
	raw, err := li.Read(lo, from-lo+n)
	if err != nil {
		return nil, err
	}
	lines := splitLines(raw)
	kinds := classifyRun(lines, lo)
	lines, kinds = lines[from-lo:], kinds[from-lo:]
	out := make([]annotLine, len(lines))
	for i, l := range lines {
		out[i] = annotLine{T: string(l), K: kinds[i].String()}
	}
	return out, nil
}

// kindAt is the kind of line `line` (1-based, within the file) and its text.
func kindAt(li *trace.LineIndex, line int) (trace.Kind, []byte, error) {
	lo := max(1, line-annotLookback)
	raw, err := li.Read(lo, line-lo+1)
	if err != nil {
		return 0, nil, err
	}
	lines := splitLines(raw)
	if len(lines) != line-lo+1 {
		return trace.KindUnknown, nil, nil
	}
	kinds := classifyRun(lines, lo)
	return kinds[len(kinds)-1], lines[len(lines)-1], nil
}

// serveAnnotated answers /api/lines?...&annot=1.
func serveAnnotated(w http.ResponseWriter, li *trace.LineIndex, from, n int) {
	from = max(from, 1)
	page := annotPage{From: from, Total: li.Lines(), Lines: []annotLine{}}
	if from <= li.Lines() && n > 0 {
		lines, err := annotate(li, from, n)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		page.Lines = lines
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(page); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
	w.Write(buf.Bytes())
}
