package opt

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
)

// LineReader gives the text of a file's lines by number. It keeps an index of every 256th line start, so a
// line costs one read of at most 256 lines, and the last chunk read is kept. It is what the text digest takes
// as its line function when the caller has no line index of its own (tests, the CLI).
type LineReader struct {
	f     *os.File
	offs  []int64 // start offset of line 256*k+1
	lines int
	size  int64

	chunk int
	buf   []string
}

const lineChunk = 256

// OpenLines indexes the file at path in one pass.
func OpenLines(path string) (*LineReader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	r := &LineReader{f: f, chunk: -1}
	br := bufio.NewReaderSize(f, 1<<20)
	var off, start int64
	cont := false
	n := 0
	for {
		frag, err := br.ReadSlice('\n')
		if !cont {
			start = off
		}
		off += int64(len(frag))
		if errors.Is(err, bufio.ErrBufferFull) {
			cont = true
			continue
		}
		cont = false
		if len(frag) > 0 {
			if n%lineChunk == 0 {
				r.offs = append(r.offs, start)
			}
			n++
		}
		if err != nil {
			if err != io.EOF {
				f.Close()
				return nil, err
			}
			break
		}
	}
	r.lines, r.size = n, off
	return r, nil
}

// Lines is the number of lines of the file.
func (r *LineReader) Lines() int { return r.lines }

// Close closes the file.
func (r *LineReader) Close() error { return r.f.Close() }

// Line returns line n (1-based) without its line terminator.
func (r *LineReader) Line(n int) (string, bool) {
	if n < 1 || n > r.lines {
		return "", false
	}
	c := (n - 1) / lineChunk
	if r.chunk != c {
		if !r.load(c) {
			return "", false
		}
	}
	k := (n - 1) % lineChunk
	if k >= len(r.buf) {
		return "", false
	}
	return r.buf[k], true
}

func (r *LineReader) load(c int) bool {
	start := r.offs[c]
	end := r.size
	if c+1 < len(r.offs) {
		end = r.offs[c+1]
	}
	b := make([]byte, end-start)
	if _, err := r.f.ReadAt(b, start); err != nil && err != io.EOF {
		return false
	}
	r.buf = r.buf[:0]
	for len(b) > 0 {
		i := bytes.IndexByte(b, '\n')
		var l []byte
		if i < 0 {
			l, b = b, nil
		} else {
			l, b = b[:i], b[i+1:]
		}
		if n := len(l); n > 0 && l[n-1] == '\r' {
			l = l[:n-1]
		}
		r.buf = append(r.buf, string(l))
	}
	r.chunk = c
	return true
}
