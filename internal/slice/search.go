package slice

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Limits of /api/search.
const (
	DefaultSearchLimit = 1000
	MaxSearchLimit     = 10000
	searchTextMax      = 400 // bytes of the line sent with a hit
	searchFlushHits    = 64
	searchFlushEvery   = 100 * time.Millisecond
	searchCtxLines     = 256 // regex mode: lines between two looks at the context
)

// searchChunk is the bytes read per round (a variable so tests can use a small
// one and exercise the line carry-over between chunks).
var searchChunk = 4 << 20

// search answers GET /api/search?file&q&regex=0|1&case=0|1&from&limit as
// NDJSON: one {"line":L,"col":C,"text":"..."} per matching line (col = byte
// offset of the first match in the line, 0-based; text = the line without its
// terminator, cut to 400 bytes) in line order, then {"done":true,"scanned":N,
// "truncated":B}. scanned counts the lines examined from `from`; truncated
// means the limit stopped the scan. case=1 (default) is case-sensitive; case=0
// folds ASCII letters (regex: (?i)). A bad regex is a 400. A request that is
// cancelled stops within a chunk or 256 lines and writes nothing more.
func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	fi, err := intParam(q, "file", 0, 0, 1<<30)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if int(fi) >= len(s.lis) {
		http.Error(w, "no such file", http.StatusNotFound)
		return
	}
	li := s.lis[fi]
	from, err1 := intParam(q, "from", 1, 1, 1<<40)
	limit, err2 := intParam(q, "limit", DefaultSearchLimit, 1, 1<<40)
	if err1 != nil || err2 != nil {
		http.Error(w, "from/limit: not an integer or out of range", http.StatusBadRequest)
		return
	}
	limit = min(limit, MaxSearchLimit)
	pat := q.Get("q")
	if pat == "" {
		http.Error(w, "q is required", http.StatusBadRequest)
		return
	}
	sc := &scanner{li: li, from: int(from), limit: int(limit)}
	sc.fold = q.Get("case") == "0"
	var re *regexp.Regexp
	if q.Get("regex") == "1" {
		expr := pat
		if sc.fold {
			expr = "(?i)" + expr
		}
		if re, err = regexp.Compile(expr); err != nil {
			http.Error(w, "regex: "+err.Error(), http.StatusBadRequest)
			return
		}
	} else {
		if strings.IndexByte(pat, '\n') >= 0 {
			http.Error(w, "q: a literal search cannot contain a newline", http.StatusBadRequest)
			return
		}
		sc.needle = []byte(pat)
		if sc.fold {
			sc.needle = foldASCII(nil, sc.needle)
		}
	}
	sc.re = re

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	sc.w = w
	sc.flusher, _ = w.(http.Flusher)
	sc.lastFlush = time.Now()
	err = sc.run(r.Context())
	if err != nil {
		// cancelled or I/O error: the status line is long sent, the stream
		// just ends without a done record
		return
	}
	sc.flush()
}

// scanner is one search run.
type scanner struct {
	li     *trace.LineIndex
	from   int
	limit  int
	needle []byte // literal mode (folded when fold)
	re     *regexp.Regexp
	fold   bool

	w         http.ResponseWriter
	flusher   http.Flusher
	out       []byte
	lastFlush time.Time
	pending   int
	hits      int
}

var foldTable = func() (t [256]byte) {
	for i := range t {
		t[i] = byte(i)
		if i >= 'A' && i <= 'Z' {
			t[i] = byte(i) + 'a' - 'A'
		}
	}
	return
}()

// foldASCII appends b with ASCII upper case letters lowered to dst[:0].
func foldASCII(dst, b []byte) []byte {
	dst = dst[:0]
	for _, c := range b {
		dst = append(dst, foldTable[c])
	}
	return dst
}

func (sc *scanner) flush() {
	if len(sc.out) > 0 {
		sc.w.Write(sc.out)
		sc.out = sc.out[:0]
	}
	if sc.flusher != nil {
		sc.flusher.Flush()
	}
	sc.lastFlush = time.Now()
	sc.pending = 0
}

// hit appends one hit record and flushes the first hit at once, then every 64
// hits or 100 ms.
func (sc *scanner) hit(line, col int, text []byte) {
	text = bytes.TrimSuffix(text, []byte{'\r'})
	if len(text) > searchTextMax {
		i := searchTextMax
		for i > 0 && !utf8.RuneStart(text[i]) { // do not cut a multi-byte rune
			i--
		}
		text = text[:i]
	}
	sc.out = append(sc.out, `{"line":`...)
	sc.out = strconv.AppendInt(sc.out, int64(line), 10)
	sc.out = append(sc.out, `,"col":`...)
	sc.out = strconv.AppendInt(sc.out, int64(col), 10)
	sc.out = append(sc.out, `,"text":`...)
	b, _ := json.Marshal(string(text))
	sc.out = append(sc.out, b...)
	sc.out = append(sc.out, "}\n"...)
	sc.hits++
	sc.pending++
	if sc.hits == 1 || sc.pending >= searchFlushHits || time.Since(sc.lastFlush) >= searchFlushEvery {
		sc.flush()
	}
}

func (sc *scanner) done(scanned int, truncated bool) {
	sc.out = append(sc.out, `{"done":true,"scanned":`...)
	sc.out = strconv.AppendInt(sc.out, int64(scanned), 10)
	sc.out = append(sc.out, `,"truncated":`...)
	sc.out = strconv.AppendBool(sc.out, truncated)
	sc.out = append(sc.out, "}\n"...)
}

// run scans the file from line `from` in 4 MB chunks that end on a line
// boundary (the unfinished last line is carried to the next chunk), starting
// at the line index checkpoint nearest below `from`. It returns the context's
// error when cancelled.
func (sc *scanner) run(ctx context.Context) error {
	total := sc.li.Lines()
	if sc.from > total {
		sc.done(0, false)
		return nil
	}
	line, off := sc.li.Checkpoint(sc.from) // number of the first line of buf, and where it starts
	size := sc.li.Size()
	buf := make([]byte, searchChunk)
	var folded []byte
	have := 0 // bytes of buf in use: whole lines, then maybe the start of an unfinished one
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if have == len(buf) { // one line longer than the buffer: grow
			buf = append(buf, make([]byte, len(buf))...)
		}
		n, err := sc.li.ReadAt(buf[have:], off+int64(have))
		have += n
		eof := err == io.EOF || off+int64(have) >= size
		if err != nil && err != io.EOF {
			return err
		}
		// the complete lines are buf[:end]; at EOF the last one needs no '\n'
		end := bytes.LastIndexByte(buf[:have], '\n') + 1
		if eof {
			end = have
		}
		if end > 0 {
			chunk := buf[:end]
			for line < sc.from && len(chunk) > 0 { // advance to line `from`
				i := bytes.IndexByte(chunk, '\n')
				if i < 0 { // the unterminated last line of the file
					chunk = nil
				} else {
					chunk = chunk[i+1:]
				}
				line++
			}
			next, stop, err := sc.chunk(ctx, chunk, line, &folded)
			if err != nil {
				return err
			}
			if stop {
				return nil
			}
			line = next
			off += int64(end)
			copy(buf, buf[end:have])
			have -= end
			if sc.pending > 0 && time.Since(sc.lastFlush) >= searchFlushEvery {
				sc.flush()
			}
		}
		if eof {
			sc.done(total-sc.from+1, false)
			return nil
		}
	}
}

// chunk searches the whole lines in b, the first of which is line number
// `line`. It returns the number of the line after the last one, and stop when
// the limit was reached (the done record is written).
func (sc *scanner) chunk(ctx context.Context, b []byte, line int, folded *[]byte) (next int, stop bool, err error) {
	if sc.re != nil {
		return sc.chunkRegex(ctx, b, line)
	}
	hay := b
	if sc.fold {
		*folded = foldASCII(*folded, b)
		hay = *folded
	}
	pos := 0     // start of the line being searched
	counted := 0 // bytes of b whose newlines are in `line`
	for pos < len(hay) {
		i := bytes.Index(hay[pos:], sc.needle)
		if i < 0 {
			break
		}
		at := pos + i
		line += bytes.Count(b[counted:at], []byte{'\n'})
		counted = at
		ls := bytes.LastIndexByte(b[:at], '\n') + 1
		le := bytes.IndexByte(b[at:], '\n')
		if le < 0 {
			le = len(b)
		} else {
			le += at
		}
		sc.hit(line, at-ls, b[ls:le])
		if sc.hits >= sc.limit {
			sc.done(line-sc.from+1, true)
			return 0, true, nil
		}
		pos = le + 1
		if err := ctx.Err(); err != nil {
			return 0, false, err
		}
	}
	line += bytes.Count(b[counted:], []byte{'\n'})
	if len(b) > 0 && b[len(b)-1] != '\n' { // the unterminated last line of the file
		line++
	}
	return line, false, nil
}

func (sc *scanner) chunkRegex(ctx context.Context, b []byte, line int) (int, bool, error) {
	n := 0
	for len(b) > 0 {
		i := bytes.IndexByte(b, '\n')
		var l []byte
		if i < 0 {
			l, b = b, nil
		} else {
			l, b = b[:i], b[i+1:]
		}
		if n++; n%searchCtxLines == 0 {
			if err := ctx.Err(); err != nil {
				return 0, false, err
			}
		}
		if loc := sc.re.FindIndex(bytes.TrimSuffix(l, []byte{'\r'})); loc != nil {
			sc.hit(line, loc[0], l)
			if sc.hits >= sc.limit {
				sc.done(line-sc.from+1, true)
				return 0, true, nil
			}
		}
		line++
	}
	return line, false, nil
}
