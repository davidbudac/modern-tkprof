package trace

import (
	"bufio"
	"io"
	"os"
)

// FileKind says what a trace file holds: 10046 records, optimizer (10053)
// dumps, or both (a session with both events on writes one interleaved file).
type FileKind uint8

const (
	FileKindNone FileKind = iota // no 10046 record and no dump (empty, or not a trace)
	FileKind10046
	FileKind10053 // at least one dump and no 10046 record
	FileKindBoth
)

func (k FileKind) String() string {
	switch k {
	case FileKind10046:
		return "10046"
	case FileKind10053:
		return "10053"
	case FileKindBoth:
		return "10046+10053"
	}
	return "none"
}

// Has10046 reports whether the kind includes 10046 records.
func (k FileKind) Has10046() bool { return k == FileKind10046 || k == FileKindBoth }

// Has10053 reports whether the kind includes optimizer dumps.
func (k FileKind) Has10053() bool { return k == FileKind10053 || k == FileKindBoth }

// SniffOptions bound a Sniff.
type SniffOptions struct {
	// StopAtRecord ends the read at the first 10046 record. That is all a
	// decision "is this file 10053 only" needs, and it is cheap for a 10046
	// trace (its first record is near the start). The kind is then exact for
	// "10053 only" (the whole file was read, no record) and for a file with a
	// dump before its first record (Both), but a file whose first record
	// precedes its first dump reads as 10046: telling that one from a plain
	// 10046 trace takes the whole file.
	StopAtRecord bool
	// MaxBytes stops the read after about this many bytes (0: no limit); the
	// result is then not Complete and its Kind is what was seen so far.
	MaxBytes int64
}

// Sniff is what SniffFile found.
type Sniff struct {
	Kind  FileKind
	Dumps []Dump // the dumps begun in the part read; a cut one has Cut set
	Lines int    // lines read
	// Complete: the read reached the end of the file (not stopped by
	// StopAtRecord or MaxBytes).
	Complete bool
}

// SniffFile reads the file at path as SniffReader does.
func SniffFile(path string, o SniffOptions) (Sniff, error) {
	f, err := os.Open(path)
	if err != nil {
		return Sniff{}, err
	}
	defer f.Close()
	return SniffReader(f, o)
}

// SniffReader classifies the lines of r with the parser's rules (a record is a
// line recordKind accepts, a dump the lines between its start and END
// banners) without delivering anything: it only finds out the FileKind and
// the dumps.
func SniffReader(r io.Reader, o SniffOptions) (Sniff, error) {
	var res Sniff
	var dumps []Dump
	ids := map[string]string{}
	t := optTracker{dumps: &dumps, id: func(b []byte) string {
		if s, ok := ids[string(b)]; ok {
			return s
		}
		s := string(b)
		ids[s] = s
		return s
	}}
	br := bufio.NewReaderSize(r, 256<<10)
	var read int64
	record, stopped, inLong := false, false, false
	for !stopped {
		chunk, err := br.ReadSlice('\n')
		full := err == bufio.ErrBufferFull // a line longer than the buffer: its start decides
		if full {
			err = nil
		}
		read += int64(len(chunk))
		if len(chunk) > 0 && !inLong {
			res.Lines++
			line := chunk
			if n := len(line); n > 0 && line[n-1] == '\n' {
				line = line[:n-1]
			}
			line = trimCR(line)
			rk := recordKind(line)
			if t.st != optOut || rk.kind == KindUnknown {
				t.line(res.Lines, line, rk)
			}
			if isRecordKind(rk.kind) {
				// a record inside a dump (event 10046 on) or outside it
				record = true
				stopped = o.StopAtRecord
			}
		}
		inLong = full
		if o.MaxBytes > 0 && read >= o.MaxBytes {
			stopped = true
		}
		if err == io.EOF {
			res.Complete = !stopped
			break
		}
		if err != nil {
			return res, err
		}
	}
	t.finish(res.Lines)
	res.Dumps = dumps
	switch {
	case record && len(dumps) > 0:
		res.Kind = FileKindBoth
	case record:
		res.Kind = FileKind10046
	case len(dumps) > 0:
		res.Kind = FileKind10053
	}
	return res, nil
}

// isRecordKind: the kinds of lines that only event 10046 (or another SQL
// trace) writes. Markers, separators, blank and unknown lines are not records.
func isRecordKind(k Kind) bool {
	switch k {
	case KindParsingInCursor, KindParseError, KindCall, KindWait, KindStat,
		KindBinds, KindXctend, KindError, KindLob, KindRPC:
		return true
	}
	return false
}

// FileKind is the kind of the file the statistics describe: it has 10046
// records when the parser counted any, optimizer dumps when it found any.
func (s Stats) FileKind() FileKind {
	record := false
	for k := Kind(0); k < kindCount; k++ {
		if isRecordKind(k) && s.Kinds[k] > 0 {
			record = true
			break
		}
	}
	switch {
	case record && len(s.Dumps) > 0:
		return FileKindBoth
	case record:
		return FileKind10046
	case len(s.Dumps) > 0:
		return FileKind10053
	}
	return FileKindNone
}
