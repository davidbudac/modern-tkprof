package model

import (
	"strconv"
	"testing"
)

// The dump lines are verbatim from testdata/traces/19c/bind_types.trc
// (scenario testdata/gen/sc_bind_types.sql) and basic_binds.trc.
func dumpOf(size int, rows ...string) string {
	s := "Unhandled datatype (-73) found in kxsbndinf\nDumping '' addr=0x7feac4432088 size=" + itoa(size) + " bytes\nDump of memory from 0x7feac4432088 to 0x7feac4432094"
	for _, r := range rows {
		s += "\n" + r
	}
	return s
}

func itoa(n int) string { return strconv.Itoa(n) }

func TestDecodeBindDump(t *testing.T) {
	tests := []struct {
		name      string
		dty, scl  int
		size      int
		rows      []string
		want, iso string
	}{
		{"ds 3 04:05:06.789", 183, 9, 11, []string{"7FEAC4432080                   03000080 AF424140          [....@AB.]", "7FEAC4432090 00402F07                             [./@.]            "},
			"+03 04:05:06.789000000", "P3DT4H5M6.789S"},
		{"ds fraction scale 6", 183, 6, 11, []string{"7F713EE967A0 03000080 AF424140 00402F07           [....@AB../@.]"},
			"+03 04:05:06.789000", "P3DT4H5M6.789S"},
		{"ds -12 23:59:58.000001", 183, 9, 11, []string{"7FEAC4432080                   F4FFFF7F 7F020125          [....%...]", "7FEAC4432090 0018FCFF                             [....]            "},
			"-12 23:59:58.000001000", "-P12DT23H59M58.000001S"},
		{"ds zero", 183, 9, 11, []string{"7FEAC4432080                   00000080 803C3C3C          [....<<<.]", "7FEAC4432090 00000000                             [....]            "},
			"+00 00:00:00.000000000", "PT0S"},
		{"ds max", 183, 9, 11, []string{"7FEAC4432080                   FFC99ABB BB777753          [....Sww.]", "7FEAC4432090 00FFC99A                             [....]            "},
			"+999999999 23:59:59.999999999", "P999999999DT23H59M59.999999999S"},
		{"ym 1-6", 182, 0, 5, []string{"7F713EE967B0 01000080 00000042                    [....B...]        "}, "+01-06", "P1Y6M"},
		{"ym -123-11", 182, 0, 5, []string{"7FEAC4432090                   85FFFF7F 00000031          [....1...]"}, "-123-11", "-P123Y11M"},
		{"ym zero", 182, 0, 5, []string{"7FEAC4432090                   00000080 0000003C          [....<...]"}, "+00-00", "P0Y"},
		{"ym max", 182, 0, 5, []string{"7FEAC4432090                   FFC99ABB 00000047          [....G...]"}, "+999999999-11", "P999999999Y11M"},
		// TSLTZ is stored in the database time zone (UTC on the lab; session was +01:00)
		{"tsltz 11 bytes", 231, 6, 11, []string{"7FEAC4432070                   01077C78 1D3C3C17          [x|...<<.]", "7FEAC4432080 000065CD                             [.e..]            "},
			"2024-07-01 22:59:59.500000 (database time zone)", "2024-07-01T22:59:59.500000"},
		{"tsltz 11 bytes, 999999 us", 231, 6, 11, []string{"7FEAC4432070                   1F0C7C78 3B3C3C17          [x|...<<;]", "7FEAC4432080 0018C69A                             [....]            "},
			"2024-12-31 22:59:59.999999 (database time zone)", "2024-12-31T22:59:59.999999"},
		{"tsltz 7 bytes", 231, 6, 7, []string{"7FEAC4432070                   1F0CC777 1D010118          [w.......]"},
			"1999-12-31 23:00:00.000000 (database time zone)", "1999-12-31T23:00:00.000000"},
	}
	for _, tc := range tests {
		got, ok := decodeBindDump(tc.dty, tc.scl, dumpOf(tc.size, tc.rows...))
		if !ok || got != tc.want {
			t.Errorf("%s: got %q ok=%v, want %q", tc.name, got, ok, tc.want)
			continue
		}
		b := Bind{Dty: int32(tc.dty), Value: got}
		if iso := b.Typed(); iso != tc.iso {
			t.Errorf("%s: typed %q, want %q", tc.name, iso, tc.iso)
		}
	}
	// not decodable: wrong length for the type, bytes that are no value, unaligned start
	for name, d := range map[string]string{
		"ds with 5 bytes":  dumpOf(5, "7F713EE967B0 01000080 00000042"),
		"garbage":          dumpOf(11, "7F713EE967A0 FFFFFFFF FFFFFFFF FFFFFFFF"),
		"size beyond dump": dumpOf(20, "7F713EE967A0 03000080 AF424140 00402F07"),
		"no dump":          "Unhandled datatype (-73) found in kxsbndinf",
	} {
		if v, ok := decodeBindDump(183, 6, d); ok {
			t.Errorf("%s: decoded to %q", name, v)
		}
	}
	if _, ok := decodeBindDump(182, 0, "Dumping '' addr=0x7f713ee967b2 size=5 bytes\nDump of memory from 0x7f713ee967b2 to 0x7f713ee967b8\n7F713EE967B0 01000080 00000042"); ok {
		t.Error("unaligned dump start decoded")
	}
}

// Stored (column) formats of the datatypes, as printed by DUMP() of a table
// column on the dbmint 19c lab (mtk_tsdump_ref); the trace prints these bytes
// for TIMESTAMP / TSTZ / DATE binds when it does not format them as text.
func TestDecodeInternalStoredFormats(t *testing.T) {
	tests := []struct {
		dty, scl int
		b        []byte
		want     string
	}{
		{180, 6, []byte{120, 124, 2, 29, 14, 15, 16, 7, 91, 205, 232}, "2024-02-29 13:14:15.123457"}, // timestamp '2024-02-29 13:14:15.123456789' (rounded to 6 digits by the column)
		{180, 6, []byte{119, 170, 1, 1, 1, 1, 1}, "1970-01-01 00:00:00.000000"},
		{181, 6, []byte{120, 124, 2, 29, 12, 15, 16, 7, 91, 202, 0, 22, 60}, "2024-02-29 13:14:15.123456 +02:00"},
		{181, 6, []byte{120, 125, 1, 1, 4, 30, 60, 59, 154, 198, 24, 17, 30}, "2024-12-31 23:59:59.999999 -03:30"},
		{181, 6, []byte{120, 124, 2, 29, 13, 1, 1, 0, 0, 0, 0, 208, 4}, "2024-02-29 12:00:00.000000 UTC (time zone region id 5121)"},
		{181, 6, []byte{120, 131, 11, 5, 17, 31, 1, 0, 0, 0, 0, 129, 156}, "2031-11-05 16:30:00.000000 UTC (time zone region id 103)"}, // 08:30 America/Los_Angeles
		{231, 6, []byte{120, 124, 7, 1, 23, 60, 60, 29, 205, 101, 0}, "2024-07-01 22:59:59.500000 (database time zone)"},
		{12, 0, []byte{119, 199, 12, 31, 1, 1, 1}, "1999-12-31 00:00:00"},
	}
	for _, tc := range tests {
		got, ok := decodeInternal(tc.dty, tc.scl, tc.b)
		if !ok || got != tc.want {
			t.Errorf("dty %d % d: got %q ok=%v, want %q", tc.dty, tc.b, got, ok, tc.want)
		}
	}
	if _, ok := decodeInternal(180, 6, []byte{120, 124, 13, 29, 14, 15, 16}); ok {
		t.Error("month 13 decoded")
	}
}

func TestTypedFromOracleText(t *testing.T) {
	tests := []struct {
		dty  int32
		in   string
		want string
	}{
		{180, "29-FEB-24 01.14.15.123456 PM", "2024-02-29T13:14:15.123456"},
		{180, "01-JAN-70 12.00.00 AM", "1970-01-01T00:00:00"},
		{180, "29-FEB-24 12.00.00 PM", "2024-02-29T12:00:00"},
		{181, "29-FEB-24 01.14.15.123456 PM +02:00", "2024-02-29T13:14:15.123456+02:00"},
		{181, "31-DEC-24 11.59.59.999999 PM -03:30", "2024-12-31T23:59:59.999999-03:30"},
		{181, "29-FEB-24 12.00.00.000000 PM UTC", "2024-02-29T12:00:00.000000Z"},
		{181, "05-NOV-31 08.30.00.000000 AM AMERICA/LOS_ANGELES", "2031-11-05T08:30:00.000000[AMERICA/LOS_ANGELES]"},
		{181, "2024-02-29 13:14:15.123456 +02:00", "2024-02-29T13:14:15.123456+02:00"},
		{180, "2024-02-29 13:14:15", "2024-02-29T13:14:15"},
		{12, "12/31/1999 0:0:0", "1999-12-31T00:00:00"},
		{12, "10/22/2024 12:35:31", "2024-10-22T12:35:31"},
		{12, "10/22/2026 11:35:3", "2026-10-22T11:35"}, // 18 characters: seconds may be cut
		{12, "1/1/1 0:0:0", "0001-01-01T00:00:00"},
		{180, "29.02.2024 13:14", ""}, // another NLS format
		{12, "<DATE len=7 h=0badc0de>", ""},
		{183, "+03 04:05:06.789000", "P3DT4H5M6.789S"},
		{183, "-00 00:00:01", "-PT1S"},
		{183, "+02 00:00:00", "P2D"},
		{183, "+00 04:00:00.5", "PT4H0.5S"},
		{182, "+01-06", "P1Y6M"},
		{182, "+00-05", "P5M"},
		{182, "garbage", ""},
		{208, "00028F76.0006.000C", "AAAAAAAAMAAAo92AAG"},
		{69, "AAAahBAAMAAAo92AAG", "AAAahBAAMAAAo92AAG"},
		{208, "<UROWID len=13 h=0badc0de>", ""},
		{2, "42", ""},
		{23, "DEADBEEF", ""},
	}
	for _, tc := range tests {
		b := Bind{Dty: tc.dty, Value: tc.in}
		if got := b.Typed(); got != tc.want {
			t.Errorf("dty %d %q: typed %q, want %q", tc.dty, tc.in, got, tc.want)
		}
	}
}

func TestDecodeRowid(t *testing.T) {
	// AAAahBAAMAAAo92AAG is a rowid of mtk_cust in basic_binds.trc: obj 108609 (the STAT obj=), file 12, block 167798, row 6
	r, ok := DecodeRowid("AAAahBAAMAAAo92AAG")
	if !ok || r != (Rowid{Object: 108609, File: 12, Block: 167798, Row: 6}) || r.String() != "AAAahBAAMAAAo92AAG" {
		t.Errorf("extended: %+v %v %s", r, ok, r.String())
	}
	h, ok := DecodeRowid("00028F76.0006.000C") // the same row as UROWID prints it (block.row.file in hex)
	if !ok || h != (Rowid{File: 12, Block: 167798, Row: 6}) {
		t.Errorf("restricted: %+v %v", h, ok)
	}
	if h.String()[6:] != r.String()[6:] {
		t.Errorf("restricted %s and extended %s differ after the object part", h, r)
	}
	for _, bad := range []string{"", "AAAahBAAMAAAo92AA", "AAAahBAAMAAAo92AA!", "0002XF76.0006.000C"} {
		if _, ok := DecodeRowid(bad); ok {
			t.Errorf("%q decoded", bad)
		}
	}
}
