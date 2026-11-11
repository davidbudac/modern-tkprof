package opt

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestFormatSQLGolden: FormatSQL agrees with sqlfmt.js of the mock-up on 78 statements, the transformed and
// original statements of the fixtures and some edge cases (testdata/gen_sqlfmt_golden.mjs writes the file).
func TestFormatSQLGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/sqlfmt_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ In, Out string }
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 60 {
		t.Fatalf("only %d cases", len(cases))
	}
	bad := 0
	for i, c := range cases {
		if got := FormatSQL(c.In); got != c.Out {
			bad++
			if bad <= 3 {
				t.Errorf("case %d: %.120q\n got: %q\nwant: %q", i, c.In, got, c.Out)
			}
		}
	}
	if bad > 0 {
		t.Errorf("%d of %d statements differ from the mock-up's pretty-printer", bad, len(cases))
	}
}

func TestFormatSQLTable(t *testing.T) {
	for _, c := range []struct{ name, in, want string }{
		{"clauses", "select a, b from t where x = 1 and y = 2 group by a order by b",
			"SELECT a, b\nFROM t\nWHERE x = 1\n  AND y = 2\nGROUP BY a\nORDER BY b"},
		{"from list", `SELECT "C"."NAME" FROM "MTK"."MTK_CUST" "C","MTK"."MTK_ORDERS" "O" WHERE "C"."ID"="O"."CUST_ID"`,
			"SELECT \"C\".\"NAME\"\nFROM \"MTK\".\"MTK_CUST\" \"C\",\n  \"MTK\".\"MTK_ORDERS\" \"O\"\nWHERE \"C\".\"ID\"=\"O\".\"CUST_ID\""},
		{"subquery", "select a from t where b in (select b from u where c = :b1 or d = 'it''s')",
			"SELECT a\nFROM t\nWHERE b in (\n    SELECT b\n    FROM u\n    WHERE c = :b1\n      OR d = 'it''s')"},
		{"comment kept", "select /*+ index(t i) */ a from t -- done", "SELECT /*+ index(t i) */ a\nFROM t -- done"},
		{"empty", "   ", ""},
		{"open quote", "select 'abc from t", "SELECT 'abc from t"},
	} {
		if got := FormatSQL(c.in); got != c.want {
			t.Errorf("%s:\n got: %q\nwant: %q", c.name, got, c.want)
		}
	}
	// a long select list breaks at its commas
	var cols []string
	for i := 0; i < 30; i++ {
		cols = append(cols, "column_"+string(rune('a'+i%26))+"_"+strings.Repeat("x", i%5))
	}
	got := FormatSQLLines("select " + strings.Join(cols, ", ") + " from t")
	if len(got) < 31 || !strings.HasPrefix(got[0], "SELECT column_a_") || !strings.HasSuffix(got[0], ",") || !strings.HasPrefix(got[1], "       column_b_") {
		t.Errorf("long select list: %d lines, first %q", len(got), got[0])
	}
}
