package trace

import (
	"bytes"
	"io"
	"os"
)

// LineIndex maps 1-based line numbers of a trace file to byte offsets so a
// range of raw lines can be read back without keeping the file in memory.
// It splits on '\n' exactly like Parser.Run (a final unterminated line counts).
type LineIndex struct {
	f    *os.File
	offs []int64 // offs[i] = start of line i+1; one extra entry = file size
}

// OpenLineIndex scans path once and keeps 8 bytes per line.
func OpenLineIndex(path string) (*LineIndex, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	li := &LineIndex{f: f, offs: []int64{0}}
	buf := make([]byte, 1<<20)
	var pos int64
	for {
		n, err := f.Read(buf)
		for b := buf[:n]; ; {
			i := bytes.IndexByte(b, '\n')
			if i < 0 {
				break
			}
			li.offs = append(li.offs, pos+int64(i)+1)
			pos += int64(i) + 1
			b = b[i+1:]
			n -= i + 1
		}
		pos += int64(n)
		if err == io.EOF {
			break
		}
		if err != nil {
			f.Close()
			return nil, err
		}
	}
	if last := li.offs[len(li.offs)-1]; last != pos { // unterminated final line
		li.offs = append(li.offs, pos)
	}
	return li, nil
}

// Lines is the number of lines in the file.
func (li *LineIndex) Lines() int { return len(li.offs) - 1 }

// Close releases the file.
func (li *LineIndex) Close() error { return li.f.Close() }

// Read returns up to n raw lines starting at 1-based line from, including
// their line terminators. A start past the end yields an empty result.
func (li *LineIndex) Read(from, n int) ([]byte, error) {
	if from < 1 {
		from = 1
	}
	last := from + n - 1
	if last > li.Lines() {
		last = li.Lines()
	}
	if n <= 0 || from > last {
		return nil, nil
	}
	start, end := li.offs[from-1], li.offs[last]
	buf := make([]byte, end-start)
	if _, err := li.f.ReadAt(buf, start); err != nil && err != io.EOF {
		return nil, err
	}
	return buf, nil
}
