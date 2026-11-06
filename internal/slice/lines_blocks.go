package slice

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

const (
	// maxBlocks caps the blocks of one /api/lines/blocks answer.
	maxBlocks = 20000
	// maxBindBlock caps the lines of one BINDS block (header included).
	maxBindBlock = 4096
	// maxFrame caps the ranges of one `frame` answer: two per cursor.
	maxFrame = 100000
	// maxStmtLines is how far `frame` looks for the END OF STMT of a statement.
	maxStmtLines = 4096
)

// linesBlocks answers {"blocks":[[from,to],...],"truncated":bool}: the
// foldable blocks of one kind in a file as sorted, 1-based, inclusive line
// ranges. stat: every plan dump (the STAT lines of a plan). binds: every BINDS
// header line of the file to the last line of its block (see bindBlockEnd),
// and in "bindLines" the `Bind#N` lines of each block (the formatted view
// shows a bind as one row, its attribute lines folded under it). frame: the
// lines the formatted view folds away (see frameBlocks), as the ranges to hide.
func (s *Server) linesBlocks(ctx context.Context, q url.Values) (any, error) {
	fi, li, f, err := s.fileParam(q)
	if err != nil {
		return nil, err
	}
	out := struct {
		Blocks    [][2]int `json:"blocks"`
		BindLines [][]int  `json:"bindLines,omitempty"`
		Truncated bool     `json:"truncated"`
	}{Blocks: [][2]int{}}
	switch q.Get("what") {
	case "stat":
		for _, p := range f.plans {
			if n := int(s.m.Plans[p.id].N); n > 0 {
				if len(out.Blocks) == maxBlocks {
					out.Truncated = true
					break
				}
				out.Blocks = append(out.Blocks, [2]int{p.line, p.line + n - 1})
			}
		}
	case "binds":
		hdrs, err := s.bindHeaders(ctx, fi, f)
		if err != nil {
			return nil, err
		}
		for i, h := range hdrs {
			if len(out.Blocks) == maxBlocks {
				out.Truncated = true
				break
			}
			if i&255 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
			}
			end, binds, ok, err := bindBlockEnd(li, h)
			if err != nil {
				return nil, err
			}
			if ok {
				out.Blocks = append(out.Blocks, [2]int{h, end})
				if binds == nil {
					binds = []int{}
				}
				out.BindLines = append(out.BindLines, binds)
			}
		}
	case "frame":
		fr, trunc, err := s.frameBlocks(ctx, li, f)
		if err != nil {
			return nil, err
		}
		out.Blocks, out.Truncated = fr, trunc
	default:
		return nil, bad("what: must be binds, stat or frame")
	}
	return out, nil
}

// frameBlocks are the framing lines of the PARSING IN CURSOR blocks of a file,
// as sorted 1-based inclusive ranges: the `=====` line before each one and its
// END OF STMT line. The formatted view folds them away (the rule becomes a
// hairline above the CURSOR row, the end of the statement says nothing the SQL
// text does not). Each is verified by classifying the lines, so a statement
// whose text holds such a line, or a parse that is not preceded by a rule, only
// loses the fold that would have been wrong.
func (s *Server) frameBlocks(ctx context.Context, li *trace.LineIndex, f *fileInfo) (blocks [][2]int, truncated bool, err error) {
	blocks = [][2]int{}
	for i, c := range f.cursors {
		if i&255 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, false, err
			}
		}
		if len(blocks)+2 > maxFrame {
			return blocks, true, nil
		}
		p := c.line
		if p < 1 {
			continue
		}
		// the rule: the line before the parse (a rule that is line 1 has no line above to fold into)
		first := max(1, p-1)
		cl := trace.NewClassifier(first == 1)
		chunk := 64
		pos := first // next line to read
		found := false
		var rule [2]int
		var haveRule bool
	scan:
		for pos-p < maxStmtLines && pos <= li.Lines() {
			n := min(chunk, li.Lines()-pos+1)
			raw, err := li.Read(pos, n)
			if err != nil {
				return nil, false, err
			}
			lines := splitLines(raw)
			if len(lines) == 0 {
				break
			}
			for j, l := range lines {
				line := pos + j
				k := cl.Next(l)
				switch {
				case line == p-1:
					if k == trace.KindSeparator && p-1 > 1 {
						rule, haveRule = [2]int{p - 1, p - 1}, true
					}
				case line == p:
					if k != trace.KindParsingInCursor {
						haveRule = false
						break scan // the cursor's line is not a PARSING IN CURSOR: leave this one alone
					}
				case line > p && k == trace.KindEndOfStmt:
					if haveRule {
						blocks = append(blocks, rule)
					}
					blocks = append(blocks, [2]int{line, line})
					found = true
					break scan
				case line > p && k != trace.KindSQLText:
					break scan // the text did not end with END OF STMT
				}
			}
			pos += len(lines)
			chunk = min(chunk*2, 512)
		}
		if !found && haveRule {
			blocks = append(blocks, rule)
		}
	}
	return blocks, false, nil
}

// bindHeaders are the sorted, distinct trace lines of the BINDS blocks of the
// bind sets that the calls of file fi own; computed once per file.
func (s *Server) bindHeaders(ctx context.Context, fi int, f *fileInfo) ([]int, error) {
	s.bindMu.Lock()
	defer s.bindMu.Unlock()
	if h, ok := s.bindHdr[fi]; ok {
		return h, nil
	}
	hdrs := []int{}
	for row := f.calls.lo; row < f.calls.hi; row++ {
		if row&4095 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		c, ok := s.src.CallAt(row)
		if !ok {
			return nil, fmt.Errorf("read call row %d", row)
		}
		if c.BindSet < 0 {
			continue
		}
		if l, ok := s.src.BindSetLine(c.BindSet); ok && l > 0 {
			hdrs = append(hdrs, l)
		}
	}
	sort.Ints(hdrs)
	w := 0
	for i, h := range hdrs {
		if i == 0 || h != hdrs[i-1] {
			hdrs[w] = h
			w++
		}
	}
	hdrs = hdrs[:w]
	if s.bindHdr == nil {
		s.bindHdr = map[int][]int{}
	}
	s.bindHdr[fi] = hdrs
	return hdrs, nil
}

var bindHash = []byte("Bind#")

// bindBlockEnd is the last line of the BINDS block whose header is at line
// `hdr`, or ok=false when that line is not a BINDS header. The block goes on
// over bind lines and over the unrecognised and blank lines that continue them
// (dump rows, multi-line values: the rule of continuesBinds) and ends before
// the first other recognised line or another BINDS header; trailing blank lines
// are left out. At most maxBindBlock lines, the header included. binds are the
// block's `Bind#N` lines.
func bindBlockEnd(li *trace.LineIndex, hdr int) (end int, binds []int, ok bool, err error) {
	last := hdr // last line that is not blank
	chunk := 32
	for next := hdr; next-hdr < maxBindBlock && next <= li.Lines(); {
		n := min(chunk, maxBindBlock-(next-hdr), li.Lines()-next+1)
		raw, err := li.Read(next, n)
		if err != nil {
			return 0, nil, false, err
		}
		lines := splitLines(raw)
		if len(lines) == 0 {
			break
		}
		for i, l := range lines {
			line := next + i
			k, _ := trace.Classify(l, false)
			if line == hdr {
				if k != trace.KindBinds {
					return 0, nil, false, nil
				}
				continue
			}
			switch k {
			case trace.KindBlank:
			case trace.KindUnknown, trace.KindBindLine:
				last = line
				if k == trace.KindBindLine && bytes.HasPrefix(bytes.TrimLeft(l, " \t"), bindHash) {
					binds = append(binds, line)
				}
			default:
				return last, binds, true, nil
			}
		}
		next += len(lines)
		chunk = min(chunk*2, 512)
	}
	return last, binds, true, nil
}
