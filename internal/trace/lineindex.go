package trace

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
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
	size  int64 // bytes indexed
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
	li.size = base
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

// lineIndexMagic and lineIndexVersion head a saved LineIndex (Save).
const (
	lineIndexMagic   = "MTKPLIDX"
	lineIndexVersion = 1
)

// LineIndexVersion is the format version of LineIndex.Save.
const LineIndexVersion = lineIndexVersion

// ErrLineIndexFormat is returned (wrapped) by LoadLineIndex for a file of
// another format, version or stride.
var ErrLineIndexFormat = errors.New("unsupported or corrupt line index file")

// Save writes the checkpoints (for the index cache): magic, version, stride,
// file size, line count and the checkpoint offsets as little-endian uint64.
// The file size lets LoadLineIndex reject an index of another file.
func (li *LineIndex) Save(w io.Writer) error {
	size := li.size
	bw := bufio.NewWriterSize(w, 256<<10)
	bw.WriteString(lineIndexMagic)
	var b [8]byte
	for _, v := range []uint64{lineIndexVersion, lineStride, uint64(size), uint64(li.lines), uint64(len(li.cps))} {
		binary.LittleEndian.PutUint64(b[:], v)
		bw.Write(b[:])
	}
	for _, c := range li.cps {
		binary.LittleEndian.PutUint64(b[:], uint64(c))
		bw.Write(b[:])
	}
	return bw.Flush()
}

// LoadLineIndex reads what Save wrote and opens path to read the lines from;
// the file must have the size it had when the index was saved.
func LoadLineIndex(path string, r io.Reader) (*LineIndex, error) {
	br := bufio.NewReaderSize(r, 256<<10)
	head := make([]byte, len(lineIndexMagic)+5*8)
	if _, err := io.ReadFull(br, head); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrLineIndexFormat, err)
	}
	if string(head[:len(lineIndexMagic)]) != lineIndexMagic {
		return nil, fmt.Errorf("%w: bad magic", ErrLineIndexFormat)
	}
	var v [5]uint64
	for i := range v {
		v[i] = binary.LittleEndian.Uint64(head[len(lineIndexMagic)+8*i:])
	}
	version, stride, size, lines, ncp := v[0], v[1], int64(v[2]), v[3], v[4]
	switch {
	case version != lineIndexVersion:
		return nil, fmt.Errorf("%w: version %d, want %d", ErrLineIndexFormat, version, lineIndexVersion)
	case stride != lineStride:
		return nil, fmt.Errorf("%w: stride %d, want %d", ErrLineIndexFormat, stride, lineStride)
	case lines > math.MaxInt32*lineStride || ncp != (lines+lineStride-1)/lineStride:
		return nil, fmt.Errorf("%w: %d checkpoints for %d lines", ErrLineIndexFormat, ncp, lines)
	}
	cps := make([]int64, ncp)
	buf := make([]byte, 8)
	for i := range cps {
		if _, err := io.ReadFull(br, buf); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrLineIndexFormat, err)
		}
		cps[i] = int64(binary.LittleEndian.Uint64(buf))
	}
	if _, err := br.ReadByte(); err != io.EOF {
		return nil, fmt.Errorf("%w: trailing data", ErrLineIndexFormat)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	if fi, err := f.Stat(); err != nil || fi.Size() != size {
		f.Close()
		return nil, fmt.Errorf("%w: %s is not the file the index was built from", ErrLineIndexFormat, path)
	}
	return &LineIndex{f: f, cps: cps, lines: int(lines), size: size}, nil
}
