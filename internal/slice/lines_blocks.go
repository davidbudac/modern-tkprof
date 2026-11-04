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
)

// linesBlocks answers {"blocks":[[from,to],...],"truncated":bool}: the
// foldable blocks of one kind in a file as sorted, 1-based, inclusive line
// ranges. stat: every plan dump (the STAT lines of a plan). binds: every BINDS
// header line of the file to the last line of its block (see bindBlockEnd),
// and in "bindLines" the `Bind#N` lines of each block (the formatted view
// shows a bind as one row, its attribute lines folded under it).
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
	default:
		return nil, bad("what: must be binds or stat")
	}
	return out, nil
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
