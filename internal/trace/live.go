package trace

import (
	"bytes"
	"os"
	"slices"
)

// Live parsing (a growing file, internal/engine live sessions): Run is fed by
// a reader that blocks at the end of the file instead of returning EOF, so a
// line that is still being written waits for its newline. The parser only
// calls Read when no complete line is buffered, so inside Read the records
// of every complete line have been delivered and the handler is quiescent:
// that is where a snapshot is taken, with Stats and Pending below.

// Stats are the statistics of the lines processed so far.
func (p *Parser) Stats() Stats {
	st := p.stats
	if d, ok := p.opt.open(p.line); ok { // a dump in progress counts as cut
		st.Dumps = append(slices.Clone(st.Dumps), d)
	}
	return st
}

// Pending hands what the parser still holds open (a PARSING IN CURSOR or
// PARSE ERROR text, a BINDS block) to h as the end of the input would, and
// leaves the parser as it is: a snapshot sees the records that a parse of
// the input so far would have delivered.
func (p *Parser) Pending(h Handler) {
	if p.cur != nil {
		c := *p.cur
		c.Text = string(p.textBuf)
		h.Cursor(c)
	}
	if p.perr != nil {
		e := *p.perr
		e.Text = string(bytes.TrimRight(p.textBuf, "\n"))
		h.ParseError(e)
	}
	if p.binds != nil {
		bs := *p.binds
		bs.Binds = slices.Clone(bs.Binds)
		h.Binds(bs)
	}
}

// LineScan builds the checkpoints of a LineIndex from the bytes of a file as
// they arrive (Feed), so the index of a growing file is never rescanned.
type LineScan struct {
	cps    []int64
	lines  int
	base   int64 // bytes fed
	inLine bool
}

// Feed takes the next bytes of the file.
func (s *LineScan) Feed(b []byte) {
	for off := 0; off < len(b); {
		if !s.inLine {
			if s.lines%lineStride == 0 {
				s.cps = append(s.cps, s.base+int64(off))
			}
			s.inLine = true
		}
		i := bytes.IndexByte(b[off:], '\n')
		if i < 0 {
			break
		}
		s.lines++
		s.inLine = false
		off += i + 1
	}
	s.base += int64(len(b))
}

// View is the LineIndex of the first lines lines (size bytes) of the file
// read through f; lines must not exceed the complete lines fed. Views share
// f and their checkpoints with the scan (which only appends): Close of a
// view closes f, so the owner of f closes it once instead.
func (s *LineScan) View(f *os.File, lines int, size int64) *LineIndex {
	n := min((lines+lineStride-1)/lineStride, len(s.cps))
	return &LineIndex{f: f, cps: s.cps[:n:n], lines: lines, size: size}
}
