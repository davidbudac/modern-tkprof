package model_test

import (
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

const bindTypesFixture = "../../testdata/traces/19c/bind_types.trc"

// What testdata/gen/sc_bind_types.sql bound, per execution (Value as shown,
// Typed as in the JSON document), by bind position. The session time zone was
// +01:00 and the database time zone is UTC, hence TSLTZ is one hour back.
// A RAW value is printed by 19c one byte short (shown with "…").
var bindTypesWant = [4][7][2]string{
	{
		{"29-FEB-24 01.14.15.123457 PM", "2024-02-29T13:14:15.123457"},
		{"29-FEB-24 01.14.15.123456 PM +02:00", "2024-02-29T13:14:15.123456+02:00"},
		{"2024-07-01 22:59:59.500000 (database time zone)", "2024-07-01T22:59:59.500000"},
		{"+03 04:05:06.789000000", "P3DT4H5M6.789S"},
		{"+01-06", "P1Y6M"},
		{"DEADBEEF00112233445566778899AABBCCDDEE…", ""},
		{"12/31/1999 0:0:0", "1999-12-31T00:00:00"},
	},
	{
		{"01-JAN-70 12.00.00 AM", "1970-01-01T00:00:00"},
		{"05-NOV-31 08.30.00.000000 AM AMERICA/LOS_ANGELES", "2031-11-05T08:30:00.000000[AMERICA/LOS_ANGELES]"},
		{"1999-12-31 23:00:00.000000 (database time zone)", "1999-12-31T23:00:00.000000"},
		{"-12 23:59:58.000001000", "-P12DT23H59M58.000001S"},
		{"-123-11", "-P123Y11M"},
		{"…", ""},
		{"10/22/2024 12:35:31", "2024-10-22T12:35:31"},
	},
	{
		{"01-JAN-25 12.00.00 AM", "2025-01-01T00:00:00"},
		{"31-DEC-24 11.59.59.999999 PM -03:30", "2024-12-31T23:59:59.999999-03:30"},
		{"2024-12-31 22:59:59.999999 (database time zone)", "2024-12-31T22:59:59.999999"},
		{"+00 00:00:00.000000000", "PT0S"},
		{"+00-00", "P0Y"},
		{"…", ""},
		{"1/1/1 0:0:0", "0001-01-01T00:00:00"},
	},
	{
		{"29-FEB-24 12.00.00 PM", "2024-02-29T12:00:00"},
		{"29-FEB-24 12.00.00.000000 PM UTC", "2024-02-29T12:00:00.000000Z"},
		{"2024-02-29 11:00:00.000000 (database time zone)", "2024-02-29T11:00:00.000000"},
		{"+999999999 23:59:59.999999999", "P999999999DT23H59M59.999999999S"},
		{"+999999999-11", "P999999999Y11M"},
		{"0102030405060708090A0B0C0D0E0F…", ""},
		{"2/29/2024 0:0:0", "2024-02-29T00:00:00"},
	},
}

var bindTypesKinds = [7]model.BindKind{model.BindTimestamp, model.BindTimestamp, model.BindTimestamp, model.BindInterval, model.BindInterval, model.BindRaw, model.BindDate}

func buildBindTypes(t *testing.T) *model.Model {
	t.Helper()
	m, err := model.Build(bindTypesFixture, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestBindTypesFixture(t *testing.T) {
	m := buildBindTypes(t)
	var sets []model.BindSet
	for _, bs := range m.BindSets {
		if bs.N == 7 {
			sets = append(sets, bs)
		}
	}
	if len(sets) != 4 {
		t.Fatalf("%d bind sets of 7 binds, want 4", len(sets))
	}
	for si, bs := range sets {
		for pos := 0; pos < 7; pos++ {
			b := &m.Binds[int(bs.First)+pos]
			want := bindTypesWant[si][pos]
			if b.IsDump || b.Value != want[0] || b.Typed() != want[1] || b.Kind() != bindTypesKinds[pos] {
				t.Errorf("set %d bind %d (%s): value %q dump=%v typed %q kind %s, want %q / %q / %s", si, pos, b.TypeName(), b.Value, b.IsDump, b.Typed(), b.Kind(), want[0], want[1], bindTypesKinds[pos])
			}
		}
	}
}

func TestBindTypesBasicBinds(t *testing.T) {
	m := build(t)
	seen := map[string]bool{}
	for i := range m.Binds {
		b := &m.Binds[i]
		if b.IsDump {
			t.Errorf("bind %d (%s) is still a memory dump: %q", i, b.TypeName(), b.Value)
		}
		switch b.Dty {
		case 183:
			seen["ds"] = seen["ds"] || (b.Value == "+03 04:05:06.789000" && b.Typed() == "P3DT4H5M6.789S")
		case 182:
			seen["ym"] = seen["ym"] || (b.Value == "+01-06" && b.Typed() == "P1Y6M")
		case 208:
			seen["urowid"] = seen["urowid"] || (b.Value == "00028F76.0006.000C" && b.Kind() == model.BindRowid && b.Typed() == "AAAAAAAAMAAAo92AAG")
		}
	}
	for _, k := range []string{"ds", "ym", "urowid"} {
		if !seen[k] {
			t.Errorf("basic_binds.trc: no %s bind decoded as expected", k)
		}
	}
}

func TestBindTypesDocumentAndReport(t *testing.T) {
	m := buildBindTypes(t)
	text, doc, csv := render(t, m)
	for _, s := range []string{`"P3DT4H5M6.789S"`, `"-P123Y11M"`, `"2031-11-05T08:30:00.000000[AMERICA/LOS_ANGELES]"`, `"typed":[`, `"kind":[`} {
		if !strings.Contains(doc, s) {
			t.Errorf("JSON document lacks %s", s)
		}
	}
	for _, s := range []string{"+03 04:05:06.789000000", "-123-11", "(database time zone)"} {
		if !strings.Contains(doc, s) || !strings.Contains(text, s) {
			t.Errorf("decoded value %q missing from JSON or text report", s)
		}
	}
	if strings.Contains(text, "<11 bytes>") || strings.Contains(doc, "Unhandled datatype") {
		t.Error("a decoded dump is still shown as a dump")
	}
	if !strings.Contains(csv, "kind,typed") || !strings.Contains(csv, "interval,P3DT4H5M6.789S") {
		t.Error("binds.csv lacks the kind / typed columns")
	}
}

// Redaction must not let the decoded or typed form of a value through.
func TestBindTypesRedaction(t *testing.T) {
	// decoded forms only: the raw literals also occur in the PL/SQL text the scenario traced
	leaks := []string{"+03 04:05:06.789", "P3DT4H5M6", "P123Y11M", "(database time zone)", "22:59:59.5", "T22:59", "2024-02-29T13", "29-FEB-24", "2/29/2024", "12/31/1999 0", "+999999999", "P999999999",
		"CCDDEE…", "AAAAAAAAMAAAo92AAG", "00028F76.0006", "AMERICA/LOS_ANGELES", "11.59.59.999999 PM"}
	for _, mode := range []model.BindMode{model.BindsRedact, model.BindsNone} {
		for _, fx := range []string{bindTypesFixture, bindsFixture} {
			m, err := model.Build(fx, model.Options{})
			if err != nil {
				t.Fatal(err)
			}
			model.RedactBindsSalt(m, mode, "salt")
			for i := range m.Binds {
				if ty := m.Binds[i].Typed(); ty != "" {
					t.Fatalf("mode %v: bind %d still has a typed form %q", mode, i, ty)
				}
			}
			text, doc, csv := render(t, m)
			// only the statement text of the fixture may mention these; check bind-looking contexts
			for _, s := range leaks {
				for name, out := range map[string]string{"text": text, "json": doc, "csv": csv} {
					if strings.Contains(out, s) {
						t.Errorf("mode %v, %s: %s output still contains %q", mode, fx, name, s)
					}
				}
			}
		}
	}
}
