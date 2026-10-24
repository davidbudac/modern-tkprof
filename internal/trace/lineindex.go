package trace

import (
	"bytes"
	"io"
	"os"
)

// LineIndex maps 1-based line numbers of a trace file to byte offsets so a
// range of raw lines can be read back without keeping the file in memory.
// It splits on '\n' exactly like Parser.Run (a final unterminated line counts).
// Only the offset of every lineStride-th line is kept (an eighth of a byte per
// line: 32 MB for a 10 GB trace of 259 million lines instead of 2 GB); Read
// scans forward from the nearest one.
type LineIndex struct {
	f     *os.File
	cps   []int64 // cps[i] = start of line i*lineStride+1
	lines int
}

const lineStride = 64

// OpenLineIndex scans path once.
func OpenLineIndex(path string) (*LineIndex, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	li := &LineIndex{f: f}
	buf := make([]byte, 1<<20)
	var base int64 // offset of buf[0]
	inLine := false
	for {
		n, err := f.Read(buf)
		for off := 0; off < n; {
			if !inLine {
				if li.lines%lineStride == 0 {
					li.cps = append(li.cps, base+int64(off))
				}
				inLine = true
			}
			i := bytes.IndexByte(buf[off:n], '\n')
			if i < 0 {
				break
			}
			li.lines++
			inLine = false
			off += i + 1
		}
		base += int64(n)
		if err == io.EOF {
			break
		}
		if err != nil {
			f.Close()
			return nil, err
		}
	}
	if inLine { // unterminated final line
		li.lines++
	}
	return li, nil
}

// Lines is the number of lines in the file.
func (li *LineIndex) Lines() int { return li.lines }

// Close releases the file.
func (li *LineIndex) Close() error { return li.f.Close() }

// Read returns up to n raw lines starting at 1-based line from, including
// their line terminators. A start past the end yields an empty result.
func (li *LineIndex) Read(from, n int) ([]byte, error) {
	if from < 1 {
		from = 1
	}
	last := from + n - 1
	if last > li.lines {
		last = li.lines
	}
	if n <= 0 || from > last {
		return nil, nil
	}
	k := (from - 1) / lineStride
	pos := li.cps[k]
	skip := from - 1 - k*lineStride // lines before the first wanted one
	want := last - from + 1         // lines still to copy
	var out []byte
	buf := make([]byte, 64<<10)
	for want > 0 {
		m, err := li.f.ReadAt(buf, pos)
		chunk := buf[:m]
		for len(chunk) > 0 && want > 0 {
			i := bytes.IndexByte(chunk, '\n')
			switch {
			case skip > 0:
				if i < 0 {
					chunk = nil
				} else {
					skip--
					chunk = chunk[i+1:]
				}
			case i < 0: // a wanted line goes on in the next chunk (or ends the file)
				out = append(out, chunk...)
				chunk = nil
			default:
				out = append(out, chunk[:i+1]...)
				want--
				chunk = chunk[i+1:]
			}
		}
		pos += int64(m)
		if err != nil {
			if err == io.EOF {
				break
			}
			return nil, err
		}
		if m == 0 {
			break
		}
	}
	return out, nil
}
