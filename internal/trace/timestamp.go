package trace

import (
	"time"
)

// parseTimestamp parses the wall-clock formats used in "*** " lines:
//
//	2026-10-22T13:14:15.123456+02:00   (12.2 and later)
//	2026-10-22 13:14:15.123            (up to 12.1)
//
// The returned time keeps the zone offset of the trace file.
func parseTimestamp(b []byte) (time.Time, bool) {
	n := len(b)
	if n < 19 {
		return time.Time{}, false
	}
	// Fast structural check before handing over to time.Parse.
	if !(isDigit(b[0]) && isDigit(b[1]) && isDigit(b[2]) && isDigit(b[3]) && b[4] == '-' &&
		isDigit(b[5]) && isDigit(b[6]) && b[7] == '-' && isDigit(b[8]) && isDigit(b[9]) &&
		(b[10] == 'T' || b[10] == ' ') && isDigit(b[11]) && isDigit(b[12]) && b[13] == ':') {
		return time.Time{}, false
	}
	s := string(b)
	if b[10] == 'T' {
		if t, err := time.Parse("2006-01-02T15:04:05.999999999Z07:00", s); err == nil {
			return t, true
		}
		if t, err := time.Parse("2006-01-02T15:04:05.999999999", s); err == nil {
			return t, true
		}
		return time.Time{}, false
	}
	if t, err := time.Parse("2006-01-02 15:04:05.999999999", s); err == nil {
		return t, true
	}
	return time.Time{}, false
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// timestampEnd returns the length of the leading timestamp token in b. The
// pre-12.2 format "2016-03-01 10:20:30.123" contains one space, so the first
// space is skipped when the character after the date is a space.
func timestampEnd(b []byte) int {
	start := 0
	if len(b) > 10 && b[10] == ' ' {
		start = 11
	}
	for i := start; i < len(b); i++ {
		if b[i] == ' ' {
			return i
		}
	}
	return len(b)
}
