package model

import (
	"encoding/binary"
	"strconv"
	"strings"
	"time"
)

// BindKind is the coarse type of a bind value, derived from its oacdty. It is
// what the JSON document's bind tables call "kind"; Bind.Typed gives the
// machine-readable form of date, timestamp, interval and rowid values.
type BindKind uint8

const (
	BindString    BindKind = iota // character types, CLOB, JSON, BOOLEAN
	BindNumber                    // NUMBER, BINARY_FLOAT, BINARY_DOUBLE, integers
	BindDate                      // DATE
	BindTimestamp                 // TIMESTAMP, TSTZ, TSLTZ
	BindInterval                  // INTERVAL YEAR TO MONTH / DAY TO SECOND
	BindRaw                       // RAW, LONG RAW
	BindRowid                     // ROWID, UROWID
	BindOther                     // objects, collections, LOBs, cursors
)

var bindKindNames = [...]string{"string", "number", "date", "timestamp", "interval", "raw", "rowid", "other"}

// String is the kind name used in the JSON document and the API.
func (k BindKind) String() string {
	if int(k) < len(bindKindNames) {
		return bindKindNames[k]
	}
	return "other"
}

// BindKindOf maps an oacdty to its kind.
func BindKindOf(dty int32) BindKind {
	switch dty {
	case 2, 3, 4, 6, 7, 21, 22, 25, 68, 100, 101:
		return BindNumber
	case 12:
		return BindDate
	case 178, 179, 180, 181, 231:
		return BindTimestamp
	case 182, 183:
		return BindInterval
	case 15, 23, 24, 29:
		return BindRaw
	case 11, 69, 104, 208:
		return BindRowid
	case 102, 108, 109, 110, 111, 113, 114, 115, 121, 122, 123:
		return BindOther
	}
	return BindString
}

// Kind is the coarse type of the bind (see BindKind).
func (b *Bind) Kind() BindKind { return BindKindOf(b.Dty) }

// Typed returns the ISO 8601 form of a DATE, TIMESTAMP (any flavour) or
// INTERVAL value ("2024-02-29T13:14:15.123456+02:00", "P3DT4H5M6.789S",
// "-P1Y6M") and the extended base-64 ROWID of a restricted rowid; "" when the
// value has no typed form (NULL, redacted, other types, an unknown NLS
// format). Numbers, strings and RAW values are their own typed form and
// return "". It is derived from Value on demand, so redacted values never
// produce one.
func (b *Bind) Typed() string {
	if b.IsNull || b.NoDef || b.IsDump || len(b.Value) == 0 {
		return ""
	}
	v := b.Value
	if v[0] == '<' && v[len(v)-1] == '>' { // RedactedValue token
		return ""
	}
	switch b.Dty {
	case 12:
		return isoOracleDate(v)
	case 178, 179, 180, 181, 231:
		return isoTimestamp(v)
	case 182:
		return isoIntervalYM(v)
	case 183:
		return isoIntervalDS(v)
	case 11, 69, 104, 208:
		return isoRowid(v)
	}
	return ""
}

// ---- memory dump decoding (build time) --------------------------------------

// decodeBindDump renders the memory dump of a TIMESTAMP, TSTZ, TSLTZ, DATE,
// INTERVAL YEAR TO MONTH or INTERVAL DAY TO SECOND bind value as text. Oracle
// prints "Unhandled datatype (-73) found in kxsbndinf" plus a hex dump of the
// internal representation for these types; the dump words are in host byte
// order (little endian on x86: "03000080" is the memory 80 00 00 03).
// scl is the fractional-seconds precision of the bind. ok is false when the
// dump is not a decodable value of that type, the caller keeps the dump.
func decodeBindDump(dty, scl int, dump string) (string, bool) {
	words, size, ok := dumpWords(dump)
	if !ok {
		return "", false
	}
	// try the little-endian host reading first, then the dump as printed (big-endian hosts)
	for _, swap := range [2]bool{true, false} {
		b := make([]byte, 0, len(words)*4)
		for _, w := range words {
			if swap {
				b = append(b, w[3], w[2], w[1], w[0])
			} else {
				b = append(b, w[0], w[1], w[2], w[3])
			}
		}
		if size >= 0 {
			if size > len(b) {
				return "", false
			}
			b = b[:size]
		}
		if s, ok := decodeInternal(dty, scl, b); ok {
			return s, true
		}
	}
	return "", false
}

// dumpWords extracts the 4-byte words of an Oracle memory dump
//
//	Dumping '' addr=0x7f713ee967a0 size=11 bytes
//	Dump of memory from 0x7f713ee967a0 to 0x7f713ee967ac
//	7F713EE967A0 03000080 AF424140 00402F07           [....@AB../@.]
//
// size is the "size=N bytes" of the Dumping line (-1: absent).
func dumpWords(dump string) (words [][4]byte, size int, ok bool) {
	size = -1
	started := false
	for _, ln := range strings.Split(dump, "\n") {
		switch {
		case strings.HasPrefix(ln, "Dumping "):
			if i := strings.Index(ln, " size="); i >= 0 {
				rest := ln[i+6:]
				if j := strings.IndexByte(rest, ' '); j > 0 {
					if n, err := strconv.Atoi(rest[:j]); err == nil {
						size = n
					}
				}
			}
		case strings.HasPrefix(ln, "Dump of memory from 0x"):
			rest := ln[len("Dump of memory from 0x"):]
			if j := strings.IndexByte(rest, ' '); j > 0 {
				a, err := strconv.ParseUint(rest[:j], 16, 64)
				if err != nil || a%4 != 0 { // unaligned start: the word layout is unknown
					return nil, 0, false
				}
			}
			started = true
		case started && len(ln) > 12 && isHexRun(ln[:12]) && ln[12] == ' ':
			for _, f := range strings.Fields(ln[13:]) {
				if f[0] == '[' {
					break
				}
				if len(f) != 8 || !isHexRun(f) {
					return nil, 0, false
				}
				var w [4]byte
				for k := 0; k < 4; k++ {
					v, _ := strconv.ParseUint(f[2*k:2*k+2], 16, 8)
					w[k] = byte(v)
				}
				words = append(words, w)
			}
		}
	}
	return words, size, started && len(words) > 0
}

func isHexRun(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'F' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return len(s) > 0
}

// decodeInternal decodes Oracle's internal byte layout of a datatype.
func decodeInternal(dty, scl int, b []byte) (string, bool) {
	switch dty {
	case 12: // DATE: century+100, year+100, month, day, hour+1, minute+1, second+1
		if len(b) != 7 {
			return "", false
		}
		y, mo, d, h, mi, s, ok := internalDate(b)
		if !ok {
			return "", false
		}
		return fmtDateTime(y, mo, d, h, mi, s), true
	case 180, 231: // TIMESTAMP, TSLTZ: DATE (+ nanoseconds, big endian) when 11 bytes
		if len(b) != 7 && len(b) != 11 {
			return "", false
		}
		y, mo, d, h, mi, s, ok := internalDate(b)
		if !ok {
			return "", false
		}
		out := fmtDateTime(y, mo, d, h, mi, s)
		if len(b) == 11 {
			ns := binary.BigEndian.Uint32(b[7:11])
			if ns > 999999999 {
				return "", false
			}
			out += fmtFraction(int(ns), scl)
		} else if scl > 0 {
			out += "." + strings.Repeat("0", scl)
		}
		if dty == 231 {
			out += " (database time zone)"
		}
		return out, true
	case 181: // TSTZ: UTC date, nanoseconds, tz hour+20, tz minute+60 (or region id when bit 7 of byte 11 is set)
		if len(b) != 13 {
			return "", false
		}
		y, mo, d, h, mi, s, ok := internalDate(b[:7])
		if !ok {
			return "", false
		}
		ns := binary.BigEndian.Uint32(b[7:11])
		if ns > 999999999 {
			return "", false
		}
		frac := fmtFraction(int(ns), scl)
		if b[11]&0x80 != 0 { // region: id = 7 bits of byte 11 and the top 6 bits of byte 12
			id := int(b[11]&0x7F)<<6 | int(b[12]>>2)
			return fmtDateTime(y, mo, d, h, mi, s) + frac + " UTC (time zone region id " + strconv.Itoa(id) + ")", true
		}
		th, tm := int(b[11])-20, int(b[12])-60
		off := th*60 + tm
		if th < -15 || th > 15 || tm < -59 || tm > 59 || th < 0 && tm > 0 || th > 0 && tm < 0 {
			return "", false
		}
		t := time.Date(y, time.Month(mo), d, h, mi, s, 0, time.UTC).Add(time.Duration(off) * time.Minute)
		sign := byte('+')
		if off < 0 {
			sign, off = '-', -off
		}
		return fmtDateTime(t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute(), t.Second()) + frac +
			" " + string(sign) + pad2(off/60) + ":" + pad2(off%60), true
	case 182: // INTERVAL YEAR TO MONTH: year int32 + 0x80000000, month + 60
		if len(b) != 5 {
			return "", false
		}
		y := int64(int32(binary.BigEndian.Uint32(b[:4]) ^ 0x80000000))
		m := int(b[4]) - 60
		if m < -11 || m > 11 {
			return "", false
		}
		neg := y < 0 || m < 0
		if y < 0 {
			y = -y
		}
		if m < 0 {
			m = -m
		}
		return signStr(neg) + pad2i(y) + "-" + pad2(m), true
	case 183: // INTERVAL DAY TO SECOND: days int32 + 0x80000000, hour/minute/second + 60, nanoseconds int32 + 0x80000000
		if len(b) != 11 {
			return "", false
		}
		days := int64(int32(binary.BigEndian.Uint32(b[:4]) ^ 0x80000000))
		h, mi, s := int(b[4])-60, int(b[5])-60, int(b[6])-60
		ns := int64(int32(binary.BigEndian.Uint32(b[7:11]) ^ 0x80000000))
		if h < -23 || h > 23 || mi < -59 || mi > 59 || s < -59 || s > 59 || ns <= -1000000000 || ns >= 1000000000 {
			return "", false
		}
		neg := days < 0 || h < 0 || mi < 0 || s < 0 || ns < 0
		if days < 0 {
			days = -days
		}
		if h < 0 {
			h = -h
		}
		if mi < 0 {
			mi = -mi
		}
		if s < 0 {
			s = -s
		}
		if ns < 0 {
			ns = -ns
		}
		return signStr(neg) + pad2i(days) + " " + pad2(h) + ":" + pad2(mi) + ":" + pad2(s) + fmtFraction(int(ns), scl), true
	}
	return "", false
}

// internalDate decodes the 7-byte DATE layout.
func internalDate(b []byte) (y, mo, d, h, mi, s int, ok bool) {
	if b[0] < 100 || b[1] < 100 {
		return
	}
	y = (int(b[0])-100)*100 + int(b[1]) - 100
	mo, d, h, mi, s = int(b[2]), int(b[3]), int(b[4])-1, int(b[5])-1, int(b[6])-1
	ok = y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59
	return
}

func fmtDateTime(y, mo, d, h, mi, s int) string {
	return pad4(y) + "-" + pad2(mo) + "-" + pad2(d) + " " + pad2(h) + ":" + pad2(mi) + ":" + pad2(s)
}

// fmtFraction is ".fffff" with at least scl digits (the bind's fractional
// seconds precision) and as many more as the nanoseconds need; "" when scl is
// 0 and there is no fraction.
func fmtFraction(ns, scl int) string {
	digits := strconv.Itoa(ns + 1000000000)[1:] // 9 digits
	n := len(strings.TrimRight(digits, "0"))
	if scl > 9 {
		scl = 9
	}
	if n < scl {
		n = scl
	}
	if n == 0 {
		return ""
	}
	return "." + digits[:n]
}

func signStr(neg bool) string {
	if neg {
		return "-"
	}
	return "+"
}

func pad2(n int) string { return pad2i(int64(n)) }

func pad2i(n int64) string {
	s := strconv.FormatInt(n, 10)
	if len(s) < 2 {
		return "0" + s
	}
	return s
}

func pad4(n int) string {
	s := strconv.Itoa(n)
	for len(s) < 4 {
		s = "0" + s
	}
	return s
}

// ---- ISO forms ----------------------------------------------------------------

var monthNames = [...]string{"JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"}

// numAt reads the decimal digits at s[i:], at most max of them.
func numAt(s string, i, max int) (n, next int, ok bool) {
	j := i
	for j < len(s) && j-i < max && s[j] >= '0' && s[j] <= '9' {
		n = n*10 + int(s[j]-'0')
		j++
	}
	return n, j, j > i
}

// isoOracleDate parses the DATE text Oracle prints in BINDS ("2/29/2024 0:0:0",
// no zero padding). Some bind paths cut the text at 18 characters, which can
// drop the second digit of the seconds ("10/22/2026 11:35:3" may be 11:35:30);
// an 18 character text therefore yields minute precision.
func isoOracleDate(s string) string {
	mo, i, ok := numAt(s, 0, 2)
	if !ok || i >= len(s) || s[i] != '/' {
		return ""
	}
	d, i, ok := numAt(s, i+1, 2)
	if !ok || i >= len(s) || s[i] != '/' {
		return ""
	}
	y, i, ok := numAt(s, i+1, 4)
	if !ok || i >= len(s) || s[i] != ' ' {
		return ""
	}
	h, i, ok := numAt(s, i+1, 2)
	if !ok || i >= len(s) || s[i] != ':' {
		return ""
	}
	mi, i, ok := numAt(s, i+1, 2)
	if !ok || i >= len(s) || s[i] != ':' {
		return ""
	}
	sec, i, ok := numAt(s, i+1, 2)
	if !ok || i != len(s) || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59 {
		return ""
	}
	out := pad4(y) + "-" + pad2(mo) + "-" + pad2(d) + "T" + pad2(h) + ":" + pad2(mi)
	if len(s) == 18 {
		return out
	}
	return out + ":" + pad2(sec)
}

// isoTimestamp parses a TIMESTAMP / TSTZ / TSLTZ text: either the form the
// decoder above produces ("2024-02-29 13:14:15.123456 +02:00") or Oracle's
// own NLS_TIMESTAMP_FORMAT text ("29-FEB-24 01.14.15.123456 PM +02:00").
func isoTimestamp(s string) string {
	if len(s) >= 19 && s[4] == '-' {
		return isoDecodedTimestamp(s)
	}
	return isoOracleTimestamp(s)
}

func isoDecodedTimestamp(s string) string {
	if len(s) < 19 || s[10] != ' ' {
		return ""
	}
	out, rest := s[:10]+"T"+s[11:19], s[19:]
	if strings.HasPrefix(rest, ".") {
		i := 1
		for i < len(rest) && rest[i] >= '0' && rest[i] <= '9' {
			i++
		}
		out, rest = out+rest[:i], rest[i:]
	}
	switch {
	case rest == "" || rest == " (database time zone)":
	case strings.HasPrefix(rest, " UTC (time zone region id "):
		out += "Z"
	case len(rest) == 7 && (rest[1] == '+' || rest[1] == '-') && rest[0] == ' ':
		out += rest[1:]
	default:
		return ""
	}
	return out
}

func isoOracleTimestamp(s string) string {
	d, i, ok := numAt(s, 0, 2)
	if !ok || i >= len(s) || s[i] != '-' || i+4 > len(s) {
		return ""
	}
	mon := strings.ToUpper(s[i+1 : i+4])
	mo := 0
	for k, n := range monthNames {
		if n == mon {
			mo = k + 1
		}
	}
	i += 4
	if mo == 0 || i >= len(s) || s[i] != '-' {
		return ""
	}
	y, j, ok := numAt(s, i+1, 4)
	if !ok || (j-i-1 != 2 && j-i-1 != 4) || j >= len(s) || s[j] != ' ' {
		return ""
	}
	if j-i-1 == 2 { // RR: 00-49 is 20xx, 50-99 is 19xx
		if y < 50 {
			y += 2000
		} else {
			y += 1900
		}
	}
	h, i, ok := numAt(s, j+1, 2)
	if !ok || i >= len(s) || s[i] != '.' {
		return ""
	}
	mi, i, ok := numAt(s, i+1, 2)
	if !ok || i >= len(s) || s[i] != '.' {
		return ""
	}
	sec, i, ok := numAt(s, i+1, 2)
	if !ok {
		return ""
	}
	frac := ""
	if i < len(s) && s[i] == '.' {
		k := i + 1
		for k < len(s) && s[k] >= '0' && s[k] <= '9' {
			k++
		}
		frac, i = s[i:k], k
	}
	if i+3 > len(s) || s[i] != ' ' || (s[i+1:i+3] != "AM" && s[i+1:i+3] != "PM") {
		return ""
	}
	pm := s[i+1] == 'P'
	i += 3
	if h < 1 || h > 12 || mo < 1 || d < 1 || d > 31 || mi > 59 || sec > 59 {
		return ""
	}
	h %= 12
	if pm {
		h += 12
	}
	out := pad4(y) + "-" + pad2(mo) + "-" + pad2(d) + "T" + pad2(h) + ":" + pad2(mi) + ":" + pad2(sec) + frac
	rest := s[i:]
	switch {
	case rest == "":
	case rest == " UTC":
		out += "Z"
	case len(rest) == 7 && (rest[1] == '+' || rest[1] == '-') && rest[0] == ' ':
		out += rest[1:]
	case len(rest) > 1 && rest[0] == ' ': // a region name; the offset is not in the text
		out += "[" + rest[1:] + "]"
	default:
		return ""
	}
	return out
}

// isoIntervalYM: "+01-06" -> "P1Y6M".
func isoIntervalYM(s string) string {
	if len(s) < 5 || (s[0] != '+' && s[0] != '-') {
		return ""
	}
	y, i, ok := numAt(s, 1, 9)
	if !ok || i >= len(s) || s[i] != '-' {
		return ""
	}
	m, i, ok := numAt(s, i+1, 2)
	if !ok || i != len(s) {
		return ""
	}
	out := "P"
	if y != 0 || m == 0 {
		out += strconv.Itoa(y) + "Y"
	}
	if m != 0 {
		out += strconv.Itoa(m) + "M"
	}
	if s[0] == '-' {
		out = "-" + out
	}
	return out
}

// isoIntervalDS: "+03 04:05:06.789000" -> "P3DT4H5M6.789S".
func isoIntervalDS(s string) string {
	if len(s) < 12 || (s[0] != '+' && s[0] != '-') {
		return ""
	}
	d, i, ok := numAt(s, 1, 9)
	if !ok || i >= len(s) || s[i] != ' ' {
		return ""
	}
	h, i, ok := numAt(s, i+1, 2)
	if !ok || i >= len(s) || s[i] != ':' {
		return ""
	}
	mi, i, ok := numAt(s, i+1, 2)
	if !ok || i >= len(s) || s[i] != ':' {
		return ""
	}
	sec, i, ok := numAt(s, i+1, 2)
	if !ok {
		return ""
	}
	frac := ""
	if i < len(s) && s[i] == '.' {
		frac = strings.TrimRight(s[i+1:], "0")
		for _, c := range frac {
			if c < '0' || c > '9' {
				return ""
			}
		}
	} else if i != len(s) {
		return ""
	}
	out := "P"
	if d != 0 {
		out += strconv.Itoa(d) + "D"
	}
	if h != 0 || mi != 0 || sec != 0 || frac != "" || d == 0 {
		out += "T"
		if h != 0 {
			out += strconv.Itoa(h) + "H"
		}
		if mi != 0 {
			out += strconv.Itoa(mi) + "M"
		}
		if sec != 0 || frac != "" || (h == 0 && mi == 0) {
			out += strconv.Itoa(sec)
			if frac != "" {
				out += "." + frac
			}
			out += "S"
		}
	}
	if s[0] == '-' {
		out = "-" + out
	}
	return out
}

// ---- ROWID ----------------------------------------------------------------------

const rowidAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// Rowid is a decoded ROWID.
type Rowid struct {
	Object uint32 // data object number (0: unknown, restricted form)
	File   uint32 // relative file number
	Block  uint32
	Row    uint32
}

// DecodeRowid parses the extended base-64 ROWID ("AAAahBAAMAAAo92AAG",
// OOOOOOFFFBBBBBBRRR: 6 data object, 3 file, 6 block, 3 row digits) and the
// restricted hexadecimal form Oracle prints for UROWID binds
// ("00028F76.0006.000C": block.row.file).
func DecodeRowid(s string) (Rowid, bool) {
	var r Rowid
	if len(s) != 18 {
		return r, false
	}
	if s[8] == '.' && s[13] == '.' {
		bn, e1 := strconv.ParseUint(s[:8], 16, 32)
		rn, e2 := strconv.ParseUint(s[9:13], 16, 32)
		fn, e3 := strconv.ParseUint(s[14:], 16, 32)
		if e1 != nil || e2 != nil || e3 != nil {
			return r, false
		}
		return Rowid{File: uint32(fn), Block: uint32(bn), Row: uint32(rn)}, true
	}
	var n [4]uint32
	for k, f := range [4][2]int{{0, 6}, {6, 9}, {9, 15}, {15, 18}} {
		for _, c := range []byte(s[f[0]:f[1]]) {
			i := strings.IndexByte(rowidAlphabet, c)
			if i < 0 {
				return r, false
			}
			n[k] = n[k]<<6 | uint32(i)
		}
	}
	return Rowid{Object: n[0], File: n[1], Block: n[2], Row: n[3]}, true
}

// String is the extended base-64 form (object 0 prints as AAAAAA).
func (r Rowid) String() string {
	enc := func(n uint32, digits int) string {
		out := make([]byte, digits)
		for i := digits - 1; i >= 0; i-- {
			out[i] = rowidAlphabet[n&63]
			n >>= 6
		}
		return string(out)
	}
	return enc(r.Object, 6) + enc(r.File, 3) + enc(r.Block, 6) + enc(r.Row, 3)
}

func isoRowid(s string) string {
	r, ok := DecodeRowid(s)
	if !ok {
		return ""
	}
	return r.String()
}
