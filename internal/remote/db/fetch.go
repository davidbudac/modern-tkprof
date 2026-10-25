package db

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

// FetchChunk is the number of line numbers one Fetch query covers
// (line_number between a and a+FetchChunk-1; about 43 700 rows on a real
// trace, see docs/REMOTE.md).
const FetchChunk = 50000

// ResumeBack is how many line numbers before the end of the local copy a
// resumed Fetch reads again, to find where the copy stops.
const ResumeBack = 64

// ResumeTail is how many bytes of the end of the local copy OpenResume keeps
// for that. Payloads are at most 4000 bytes, so ResumeBack+1 records fit.
const ResumeTail = 256 << 10

// Resume describes the part of a trace already copied locally: Lines is its
// number of '\n' and Tail its last bytes (up to ResumeTail), which end with
// '\n'. The zero value starts from the beginning.
type Resume struct {
	Lines int64
	Tail  []byte
}

const fetchSQL = "select line_number, payload from (select line_number, payload, rownum rn from v$diag_trace_file_contents where adr_home = :h and trace_filename = :f and line_number between :a and :b) order by line_number, rn"

const fetchMaxSQL = "select max(line_number) from v$diag_trace_file_contents where adr_home = :h and trace_filename = :f"

// Fetch copies a trace file out of V$DIAG_TRACE_FILE_CONTENTS into w.
//
// A row of the view is a record, not a line: its payload holds one or more
// lines, usually ending in a newline, and is NULL (or empty) for some records
// that add nothing to the file. Writing every payload as it is, in row order,
// gives the file byte for byte. line_number is the file's line count at the
// end of the record (one less for some STAT lines; several records share a
// number), so it is only a coarse position: Fetch reads max(line_number)
// first and walks 1..max in FetchChunk ranges, every range a query of its
// own, ordered by line_number and then by the order the view returned the
// rows in.
//
// from continues a partial copy: the first range starts ResumeBack line
// numbers before from.Lines, and its rows are matched against from.Tail, at
// the rows whose line_number is about from.Lines, to find the first byte w
// does not have yet (an error if they do not match: the local file is not a
// prefix of this trace). Only the rest is written, so w must append to the
// local copy. The line_number is not enough alone: a STAT line has its FETCH's
// number, and a copy cut inside a record has part of a row.
//
// lines counts the '\n' written; w has every line of a range before
// progress(lines so far) is called, so after an error the copy can be
// resumed with a Resume made from w's file (OpenResume).
func (c *Client) Fetch(ctx context.Context, adrHome, traceFilename string, w io.Writer, from Resume, progress func(lines int64)) (lines int64, err error) {
	if adrHome == "" || traceFilename == "" {
		return 0, fmt.Errorf("db: fetch: want adr_home and trace file name")
	}
	var max sql.NullInt64
	if _, err := c.queryRow(ctx, fetchMaxSQL, []any{adrHome, traceFilename}, &max); err != nil {
		return 0, fmt.Errorf("db: fetch %s: %w", traceFilename, err)
	}
	a := int64(1)
	if from.Lines > ResumeBack {
		a = from.Lines - ResumeBack
	}
	bw := bufio.NewWriterSize(w, 1<<20)
	first := from.Lines > 0
	for ; first || a <= max.Int64; a += FetchChunk {
		b := a + FetchChunk - 1
		data, recs, err := c.fetchChunk(ctx, adrHome, traceFilename, a, b)
		if err == nil && first {
			var skip int
			if skip, err = resumeSkip(data, recs, from); err == nil {
				data = data[skip:]
			}
		}
		first = false
		if err == nil {
			_, err = bw.Write(data)
		}
		if ferr := bw.Flush(); err == nil {
			err = ferr
		}
		if err != nil {
			return lines, fmt.Errorf("db: fetch %s lines %d-%d: %w", traceFilename, a, b, err)
		}
		lines += int64(bytes.Count(data, []byte{'\n'}))
		if progress != nil {
			progress(lines)
		}
	}
	return lines, nil
}

// rec is the end of one row's payload in a range's data, and its line_number.
type rec struct {
	end int
	ln  int64
}

// fetchChunk returns the payloads of the records with line numbers a..b,
// concatenated, and where each ends. A failed range returns nothing.
func (c *Client) fetchChunk(ctx context.Context, adrHome, name string, a, b int64) ([]byte, []rec, error) {
	rows, err := c.conn.Query(ctx, fetchSQL, adrHome, name, a, b)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var buf strings.Builder
	var recs []rec
	for rows.Next() {
		var ln int64
		var payload sql.NullString
		if err := rows.Scan(&ln, &payload); err != nil {
			return nil, nil, err
		}
		buf.WriteString(payload.String)
		recs = append(recs, rec{buf.Len(), ln})
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return []byte(buf.String()), recs, nil
}

var errResumeMismatch = errors.New("the local copy does not match the database's trace (a different or changed file); start again without resume")

// resumeSkip returns how many bytes at the start of data (rows read from
// before the end of the local copy on) the copy already has: the longest
// whole-line prefix of data that is a suffix of from.Tail and ends in a row
// numbered like the end of the copy. That number is from.Lines (or one less,
// for a STAT line), or higher when the copy ends inside a multi-line record;
// without this check a trace that repeats itself would match too far.
func resumeSkip(data []byte, recs []rec, from Resume) (int, error) {
	if from.Lines == 0 {
		return 0, nil
	}
	k := len(data)
	if len(from.Tail) < k {
		k = len(from.Tail)
	}
	for ; k > 0; k = bytes.LastIndexByte(data[:k-1], '\n') + 1 {
		if data[k-1] != '\n' {
			continue
		}
		i := sort.Search(len(recs), func(i int) bool { return recs[i].end >= k })
		start := 0
		if i > 0 {
			start = recs[i-1].end
		}
		if ln := recs[i].ln; ln >= from.Lines-1 && ln <= from.Lines+int64(bytes.Count(data[start:recs[i].end], []byte{'\n'})) &&
			bytes.HasSuffix(from.Tail, data[:k]) {
			return k, nil
		}
	}
	return 0, errResumeMismatch
}
