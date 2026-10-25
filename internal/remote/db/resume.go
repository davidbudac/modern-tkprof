package db

import (
	"bufio"
	"bytes"
	"io"
	"os"
)

// BigFetch is the size past which a fetch through V$DIAG_TRACE_FILE_CONTENTS
// is slow enough that SSH should be offered instead (docs/REMOTE.md).
const BigFetch = 200 << 20

// OpenResume opens path for appending after its last complete line (a
// partial last line is cut) and returns what Fetch needs to continue the
// copy there: the '\n' count and the last bytes. The zero Resume for a new or
// empty file. perm applies to a file it creates.
func OpenResume(path string, perm os.FileMode) (*os.File, Resume, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, perm)
	if err != nil {
		return nil, Resume{}, err
	}
	var lines, end, off int64
	br := bufio.NewReaderSize(f, 1<<20)
	buf := make([]byte, 1<<20)
	for {
		k, err := br.Read(buf)
		for i := 0; i < k; {
			j := bytes.IndexByte(buf[i:k], '\n')
			if j < 0 {
				break
			}
			lines++
			i += j + 1
			end = off + int64(i)
		}
		off += int64(k)
		if err == io.EOF {
			break
		}
		if err != nil {
			f.Close()
			return nil, Resume{}, err
		}
	}
	if err := f.Truncate(end); err != nil {
		f.Close()
		return nil, Resume{}, err
	}
	if _, err := f.Seek(end, io.SeekStart); err != nil {
		f.Close()
		return nil, Resume{}, err
	}
	r := Resume{Lines: lines}
	if end > 0 {
		from := end - ResumeTail
		if from < 0 {
			from = 0
		}
		r.Tail = make([]byte, end-from)
		if _, err := f.ReadAt(r.Tail, from); err != nil {
			f.Close()
			return nil, Resume{}, err
		}
	}
	return f, r, nil
}
