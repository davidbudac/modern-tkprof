package db

import (
	"bufio"
	"context"
	"database/sql"
	"fmt"
	"io"
	"strings"
)

// FetchChunk is the number of trace lines one Fetch query asks for.
const FetchChunk = 50000

const fetchSQL = "select line_number, payload from v$diag_trace_file_contents where adr_home = :h and trace_filename = :f and line_number between :a and :b order by line_number"

// Fetch copies a trace file out of V$DIAG_TRACE_FILE_CONTENTS into w, one
// payload per line (a newline is added unless the payload ends with one),
// FetchChunk lines per query, starting at line fromLine (1-based; <= 1 =
// from the start). It stops when a chunk returns fewer lines than asked.
// w has every line of a chunk before progress(lines so far) is called, so
// after an error the copy can be resumed with fromLine + lines.
func (c *Client) Fetch(ctx context.Context, adrHome, traceFilename string, w io.Writer, fromLine int64, progress func(lines int64)) (lines int64, err error) {
	if adrHome == "" || traceFilename == "" {
		return 0, fmt.Errorf("db: fetch: want adr_home and trace file name")
	}
	if fromLine < 1 {
		fromLine = 1
	}
	bw := bufio.NewWriterSize(w, 1<<20)
	for a := fromLine; ; a += FetchChunk {
		b := a + FetchChunk - 1
		n, err := c.fetchChunk(ctx, bw, adrHome, traceFilename, a, b)
		lines += n
		if ferr := bw.Flush(); err == nil {
			err = ferr
		}
		if err != nil {
			return lines, fmt.Errorf("db: fetch %s lines %d-%d: %w", traceFilename, a, b, err)
		}
		if progress != nil {
			progress(lines)
		}
		if n < FetchChunk {
			return lines, nil
		}
	}
}

// fetchChunk writes lines a..b. A failed chunk writes nothing (the rows are
// buffered first), so lines stays an exact resume point.
func (c *Client) fetchChunk(ctx context.Context, w *bufio.Writer, adrHome, name string, a, b int64) (int64, error) {
	rows, err := c.conn.Query(ctx, fetchSQL, adrHome, name, a, b)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var buf strings.Builder
	var n int64
	for rows.Next() {
		var ln int64
		var payload sql.NullString
		if err := rows.Scan(&ln, &payload); err != nil {
			return 0, err
		}
		buf.WriteString(payload.String)
		if !strings.HasSuffix(payload.String, "\n") {
			buf.WriteByte('\n')
		}
		n++
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if _, err := w.WriteString(buf.String()); err != nil {
		return 0, err
	}
	return n, nil
}
