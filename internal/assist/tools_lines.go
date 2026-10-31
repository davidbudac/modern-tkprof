package assist

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/slice"
)

const (
	defaultLines, maxLinesAsked = 100, 500
	maxLineBytes                = 500
	defaultHits, maxHits        = 30, 200
	maxHitBytes                 = 300
)

// lineMasker reads the BINDS blocks of one file and masks the lines in them.
func (e Env) lineMasker(ctx context.Context, file int) (*LineMasker, error) {
	if e.Redact == nil {
		return nil, nil
	}
	b, err := getJSON[struct {
		Blocks [][2]int `json:"blocks"`
	}](ctx, e, "/api/lines/blocks", url.Values{"file": {strconv.Itoa(file)}, "what": {"binds"}})
	if err != nil {
		return nil, err
	}
	return &LineMasker{R: e.Redact, Blocks: b.Blocks, Read: func(from, to int) ([]string, error) { return e.readLines(ctx, file, from, to) }}, nil
}

// readLines reads lines from..to of an input file.
func (e Env) readLines(ctx context.Context, file, from, to int) ([]string, error) {
	var out []string
	for from <= to {
		n := min(to-from+1, slice.MaxLines)
		b, err := e.get(ctx, "/api/lines", url.Values{"file": {strconv.Itoa(file)}, "from": {strconv.Itoa(from)}, "n": {strconv.Itoa(n)}})
		if err != nil {
			return nil, err
		}
		lines := strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
		if len(b) == 0 {
			lines = nil
		}
		for i := range lines {
			lines[i] = strings.TrimSuffix(lines[i], "\r")
		}
		out = append(out, lines...)
		if len(lines) < n {
			break
		}
		from += n
	}
	return out, nil
}

func (e Env) fileName(file int) (string, error) {
	files := e.Model.File.Files
	if file < 0 || file >= len(files) {
		return "", argErrorf("file: %d is not an input file (0 to %d)", file, len(files)-1)
	}
	return files[file].Name, nil
}

func (e Env) bindValues() string {
	if e.Redact != nil {
		return "masked"
	}
	return "as traced"
}

// ---- lines -----------------------------------------------------------------------

type linesArgs struct {
	File int `json:"file"`
	From int `json:"from"`
	N    int `json:"n"`
}

type linesOut struct {
	File       int    `json:"file"`
	Name       string `json:"name"`
	From       int    `json:"from"`
	Total      int    `json:"totalLines"`
	Count      int    `json:"lines"`
	BindValues string `json:"bindValues"`
	Text       string `json:"text"` // one line per trace line: its number, a tab, its text
	Next       int    `json:"next,omitempty"`
	Truncated  bool   `json:"truncated,omitempty"`
	Hint       string `json:"hint,omitempty"`
}

var linesTool = Tool{
	Name: "lines",
	Description: "Raw lines of a trace file, each with its line number, to read what the trace itself says around a call, a wait or a plan " +
		"(evidence and statements name trace lines). At most 500 lines; next is the line to continue from. " +
		"Bind values in BINDS blocks are masked like the other tools' unless the conversation shows them.",
	Schema: schema(`"file":{"type":"integer","minimum":0,"default":0,"description":"input file index (see overview.files)"},` +
		`"from":{"type":"integer","minimum":1,"default":1,"description":"first line, 1-based"},` +
		`"n":{"type":"integer","minimum":1,"maximum":500,"default":100}`),
	Run: runLines,
}

func runLines(ctx context.Context, e Env, raw json.RawMessage) (Result, error) {
	var a linesArgs
	if err := decodeArgs(raw, &a); err != nil {
		return Result{}, err
	}
	if a.From == 0 {
		a.From = 1
	}
	if a.N == 0 {
		a.N = defaultLines
	}
	if a.From < 1 || a.N < 1 || a.N > maxLinesAsked {
		return Result{}, argErrorf("from: want 1 or more; n: want 1 to %d", maxLinesAsked)
	}
	name, err := e.fileName(a.File)
	if err != nil {
		return Result{}, err
	}
	page, err := getJSON[struct {
		Total int `json:"total"`
		Lines []struct {
			T string `json:"t"`
			K string `json:"k"`
		} `json:"lines"`
	}](ctx, e, "/api/lines", url.Values{"file": {strconv.Itoa(a.File)}, "from": {strconv.Itoa(a.From)}, "n": {strconv.Itoa(a.N)}, "annot": {"1"}})
	if err != nil {
		return Result{}, err
	}
	lines := make([]string, len(page.Lines))
	for i, l := range page.Lines {
		lines[i] = l.T
	}
	if e.Redact != nil {
		orig := append([]string(nil), lines...)
		mk, err := e.lineMasker(ctx, a.File)
		if err != nil {
			return Result{}, err
		}
		if err := mk.Mask(a.From, lines); err != nil {
			return Result{}, err
		}
		for i, l := range page.Lines { // a value line no known block covered
			if l.K == "bind-line" && lines[i] == orig[i] && isValueLine(l.T) {
				lines[i] = l.T[:strings.Index(l.T, "value=")+len("value=")] + maskedValue
			}
		}
	}
	for i := range lines {
		if t, cut := cutText(lines[i], maxLineBytes); cut {
			lines[i] = t + fmt.Sprintf("… (+%d bytes)", len(lines[i])-len(t))
		}
	}
	out := linesOut{File: a.File, Name: name, From: a.From, Total: page.Total, BindValues: e.bindValues()}
	return e.listResult(len(lines), func(n int) any {
		var b strings.Builder
		for i := 0; i < n; i++ {
			fmt.Fprintf(&b, "%d\t%s\n", a.From+i, lines[i])
		}
		out.Text, out.Count = b.String(), n
		out.Next = 0
		if a.From+n <= page.Total {
			out.Next = a.From + n
		}
		out.Truncated = n < len(lines)
		out.Hint = ""
		if out.Truncated {
			out.Hint = cutHint(n, len(lines), "lines", e.maxBytes())
		}
		return out
	})
}

// ---- search_lines ------------------------------------------------------------------

type searchArgs struct {
	File       int    `json:"file"`
	Q          string `json:"q"`
	Regex      bool   `json:"regex"`
	IgnoreCase bool   `json:"ignore_case"`
	From       int    `json:"from"`
	Limit      int    `json:"limit"`
}

type hitOut struct {
	Line int    `json:"line"`
	Col  int    `json:"col"` // byte offset of the match in the line, 0-based
	Text string `json:"text"`
}

type searchOut struct {
	File       int      `json:"file"`
	Name       string   `json:"name"`
	Q          string   `json:"q"`
	BindValues string   `json:"bindValues"`
	Scanned    int      `json:"linesScanned"`
	Hits       []hitOut `json:"hits"`
	Next       int      `json:"next,omitempty"` // from, to look for more
	Truncated  bool     `json:"truncated,omitempty"`
	Hint       string   `json:"hint,omitempty"`
}

var searchLinesTool = Tool{
	Name: "search_lines",
	Description: "Find the lines of a trace file that contain a text (or match a regular expression), in file order, with line numbers. " +
		"A match inside a BINDS block shows the masked bind value, not the traced one. At most 200 hits; next is the line to continue from.",
	Schema: schema(`"q":{"type":"string","minLength":1,"description":"the text to find"},`+
		`"regex":{"type":"boolean","default":false,"description":"q is a Go regular expression"},`+
		`"ignore_case":{"type":"boolean","default":false},`+
		`"file":{"type":"integer","minimum":0,"default":0,"description":"input file index (see overview.files)"},`+
		`"from":{"type":"integer","minimum":1,"default":1,"description":"line to start at"},`+
		`"limit":{"type":"integer","minimum":1,"maximum":200,"default":30}`, "q"),
	Run: runSearchLines,
}

func runSearchLines(ctx context.Context, e Env, raw json.RawMessage) (Result, error) {
	var a searchArgs
	if err := decodeArgs(raw, &a); err != nil {
		return Result{}, err
	}
	if a.Q == "" {
		return Result{}, argErrorf("q: required")
	}
	if a.From == 0 {
		a.From = 1
	}
	if a.Limit == 0 {
		a.Limit = defaultHits
	}
	if a.From < 1 || a.Limit < 1 || a.Limit > maxHits {
		return Result{}, argErrorf("from: want 1 or more; limit: want 1 to %d", maxHits)
	}
	name, err := e.fileName(a.File)
	if err != nil {
		return Result{}, err
	}
	b2i := map[bool]string{false: "0", true: "1"}
	body, err := e.get(ctx, "/api/search", url.Values{"file": {strconv.Itoa(a.File)}, "q": {a.Q}, "regex": {b2i[a.Regex]}, "case": {b2i[!a.IgnoreCase]},
		"from": {strconv.Itoa(a.From)}, "limit": {strconv.Itoa(a.Limit)}})
	if err != nil {
		return Result{}, err
	}
	out := searchOut{File: a.File, Name: name, Q: a.Q, BindValues: e.bindValues(), Hits: []hitOut{}}
	var routeCut bool
	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		var rec struct {
			Line      int    `json:"line"`
			Col       int    `json:"col"`
			Text      string `json:"text"`
			Done      bool   `json:"done"`
			Scanned   int    `json:"scanned"`
			Truncated bool   `json:"truncated"`
		}
		if err := json.Unmarshal(sc.Bytes(), &rec); err != nil {
			return Result{}, fmt.Errorf("search: %w", err)
		}
		if rec.Done {
			out.Scanned, routeCut = rec.Scanned, rec.Truncated
			continue
		}
		out.Hits = append(out.Hits, hitOut{Line: rec.Line, Col: rec.Col, Text: rec.Text})
	}
	if err := sc.Err(); err != nil {
		return Result{}, fmt.Errorf("search: %w", err)
	}
	if len(out.Hits) > 0 {
		mk, err := e.lineMasker(ctx, a.File)
		if err != nil {
			return Result{}, err
		}
		for i := range out.Hits {
			h := &out.Hits[i]
			ls := []string{h.Text}
			if err := mk.Mask(h.Line, ls); err != nil {
				return Result{}, err
			}
			h.Text, _ = cutText(ls[0], maxHitBytes)
		}
	}
	hits := out.Hits
	if routeCut && len(hits) > 0 {
		out.Next = hits[len(hits)-1].Line + 1
	}
	res, err := e.listResult(len(hits), func(n int) any {
		out.Hits = hits[:n]
		out.Truncated = routeCut || n < len(hits)
		out.Hint = ""
		if n < len(hits) {
			out.Next = hits[n-1].Line + 1
			if n == 0 {
				out.Next = a.From
			}
			out.Hint = cutHint(n, len(hits), "hits", e.maxBytes())
		} else if routeCut {
			out.Hint = fmt.Sprintf("the search stopped at the limit of %d hits; continue from line %d", a.Limit, out.Next)
		}
		return out
	})
	return res, err
}
