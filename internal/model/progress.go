package model

import (
	"bytes"
	"io"
	"os"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// progressStep is how much input is consumed between two OnProgress calls.
const progressStep = 64 << 20

// progress counts the input of a BuildFiles run and reports it through
// Options.OnProgress. It wraps the file reader rather than the parser, so a
// build without OnProgress has no extra work at all (a nil *progress is the
// "off" state and parseFile does not wrap anything). The counters are those
// of the bytes handed to the parser so far, cumulative over the files of the
// set; the parser's own read-ahead (1 MiB) makes them run slightly ahead of
// the records already delivered. The final call carries the exact totals.
type progress struct {
	fn      func(bytes, lines, statements int64)
	stmts   func() int64
	bytes   int64
	lines   int64
	lastRep int64 // bytes at the last call
}

func (p *progress) Read(r io.Reader, buf []byte) (int, error) {
	n, err := r.Read(buf)
	if n > 0 {
		p.bytes += int64(n)
		p.lines += int64(bytes.Count(buf[:n], []byte{'\n'}))
		if p.bytes-p.lastRep >= progressStep {
			p.lastRep = p.bytes
			p.fn(p.bytes, p.lines, p.stmts())
		}
	}
	return n, err
}

// done reports the final totals (nil-safe).
func (p *progress) done(bytes, lines, statements int64) {
	if p != nil {
		p.fn(bytes, lines, statements)
	}
}

type progressReader struct {
	r io.Reader
	p *progress
}

func (pr progressReader) Read(buf []byte) (int, error) { return pr.p.Read(pr.r, buf) }

// parseFile is trace.ParseFile with optional progress reporting.
func parseFile(path string, h trace.Handler, p *progress) (trace.Stats, error) {
	if p == nil {
		return trace.ParseFile(path, h)
	}
	f, err := os.Open(path)
	if err != nil {
		return trace.Stats{}, err
	}
	defer f.Close()
	return trace.Parse(progressReader{f, p}, h)
}
