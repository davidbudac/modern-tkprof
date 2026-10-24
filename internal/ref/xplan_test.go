package ref

import (
	"os"
	"testing"
)

// A hand-written ALLSTATS LAST +PREDICATE +ALIAS listing (unit test of the
// text format only; real fixtures cover the end-to-end overlay).
const minimalXPlan = `SQL_ID  abcd1234efgh5, child number 0
-------------------------------------
select /*+ gather_plan_statistics */ e.name from emp e, dept d where e.deptno = d.deptno and e.job = 'A(B' and d.loc = 'X'

Plan hash value: 1234567890

----------------------------------------------------------------------------------------------------------------------------
| Id  | Operation                    | Name    | Starts | E-Rows | A-Rows |   A-Time   | Buffers | Reads  |  OMem |  1Mem | Used-Mem |
----------------------------------------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT             |         |      1 |        |     14 |00:00:00.01 |      12 |      2 |       |       |          |
|*  1 |  HASH JOIN                   |         |      1 |     14 |     14 |00:00:00.01 |      12 |      2 |  1743K|  1743K| 1385K (0)|
|   2 |   TABLE ACCESS FULL          | DEPT    |      1 |      4 |      4 |00:00:00.01 |       7 |      1 |       |       |          |
|*  3 |   TABLE ACCESS FULL          | EMP     |      1 |    14K |     14 |00:00:00.01 |       5 |      1 |       |       |          |
----------------------------------------------------------------------------------------------------------------------------

Query Block Name / Object Alias (identified by operation id):
-------------------------------------------------------------

   1 - SEL$1
   2 - SEL$1 / "D"@"SEL$1"
   3 - SEL$1 / E@SEL$1

Predicate Information (identified by operation id):
---------------------------------------------------

   1 - access("E"."DEPTNO"="D"."DEPTNO")
   3 - filter(("E"."JOB"='A(B' AND
              "E"."SAL">1000))

Note
-----
   - dynamic statistics used: dynamic sampling (level=2)
   - this is an adaptive plan
`

func TestParseXPlanMinimal(t *testing.T) {
	x := ParseXPlan(minimalXPlan)
	if x == nil {
		t.Fatal("no plan")
	}
	if !x.HasHash || x.PlanHash != 1234567890 || x.SQLID != "abcd1234efgh5" {
		t.Errorf("header: hash %d (%v) sql_id %q", x.PlanHash, x.HasHash, x.SQLID)
	}
	if len(x.Rows) != 4 {
		t.Fatalf("rows = %d", len(x.Rows))
	}
	r0, r1, r3 := x.Row(0), x.Row(1), x.Row(3)
	if r0.Op != "SELECT STATEMENT" || r0.Depth != 0 || r0.ERows != -1 || r0.ARows != 14 || r0.ATimeUs != 10000 || r0.Buffers != 12 {
		t.Errorf("row 0 = %+v", r0)
	}
	if r1.Op != "HASH JOIN" || r1.Depth != 1 || !r1.Star || r1.ERows != 14 || r1.Starts != 1 || r1.OMem != 1743*1024 || r1.UsedMem != 1385*1024 || r1.UsedPass != 0 {
		t.Errorf("row 1 = %+v", r1)
	}
	if r := x.Row(2); r.Depth != 2 || r.Name != "DEPT" || r.Star || r.Reads != 1 || r.Alias != `D@SEL$1` || r.QBlock != "SEL$1" {
		t.Errorf("row 2 = %+v", r)
	}
	if r3.ERows != 14000 || r3.Name != "EMP" || r3.Alias != "E@SEL$1" {
		t.Errorf("row 3 = %+v", r3)
	}
	if r1.Access != `"E"."DEPTNO"="D"."DEPTNO"` || r1.Filter != "" {
		t.Errorf("row 1 predicates = %q / %q", r1.Access, r1.Filter)
	}
	// wrapped line joined with a space, '(' inside the literal not counted
	if want := `("E"."JOB"='A(B' AND "E"."SAL">1000)`; r3.Filter != want {
		t.Errorf("row 3 filter = %q, want %q", r3.Filter, want)
	}
	if len(x.Notes) != 2 || x.Notes[0] != "dynamic statistics used: dynamic sampling (level=2)" {
		t.Errorf("notes = %q", x.Notes)
	}
	if x.Row(9) != nil {
		t.Error("Row(9) must be nil")
	}
}

// The estimate-only columns of a plain DISPLAY (no ALLSTATS) parse too, and a
// second filter() line of one id is joined with AND.
func TestParseXPlanEstimatesOnly(t *testing.T) {
	txt := `Plan hash value: 77

--------------------------------------------------------------------------
| Id  | Operation         | Name | Rows  | Bytes | Cost (%CPU)| Time     |
--------------------------------------------------------------------------
|   0 | SELECT STATEMENT  |      |   100K|  2734K|  4823K  (1)| 00:00:01 |
|*  1 |   TABLE ACCESS FULL| T    |   100K|  2734K|   137   (1)| 00:00:01 |
--------------------------------------------------------------------------

Predicate Information (identified by operation id):
---------------------------------------------------

   1 - filter("A"=1)
       filter("B"=2)
`
	x := ParseXPlan(txt)
	if x == nil || len(x.Rows) != 2 {
		t.Fatalf("plan = %+v", x)
	}
	if r := x.Row(0); r.ERows != 100000 || r.EBytes != 2734*1000 || r.Cost != 4823000 || r.Starts != -1 || r.ARows != -1 {
		t.Errorf("row 0 = %+v", r)
	}
	if r := x.Row(1); r.Op != "TABLE ACCESS FULL" || r.Filter != `"A"=1 AND "B"=2` || r.Cost != 137 {
		t.Errorf("row 1 = %+v", r)
	}
}

func TestParseXPlansMultiple(t *testing.T) {
	one := func(h, extra string) string {
		return "SQL_ID  q1, child number 0\n-----\nselect 1 from dual\n\nPlan hash value: " + h + "\n\n" +
			"---------------------------\n| Id  | Operation        | Name |\n---------------------------\n|   0 | SELECT STATEMENT |      |\n|   1 |  FAST DUAL       |      |\n---------------------------\n" + extra
	}
	xs := ParseXPlans(one("11", "\nNote\n-----\n   - first\n\n") + one("22", ""))
	if len(xs) != 2 || xs[0].PlanHash != 11 || xs[1].PlanHash != 22 {
		t.Fatalf("plans = %+v", xs)
	}
	if len(xs[0].Notes) != 1 || len(xs[1].Notes) != 0 {
		t.Errorf("notes = %q / %q", xs[0].Notes, xs[1].Notes)
	}
	if ParseXPlan("SQL_ID abc, child number 0\nNot found") != nil {
		t.Error("text without a plan table must give nil")
	}
}

func TestParseXPlanFixture(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/reference/bundle/plans/52nzchs09dgn1.txt")
	if err != nil {
		t.Fatal(err)
	}
	x := ParseXPlan(string(raw))
	if x == nil || x.PlanHash != 2503715236 || x.SQLID != "52nzchs09dgn1" || len(x.Rows) != 3 {
		t.Fatalf("plan = %+v", x)
	}
	r1, r2 := x.Row(1), x.Row(2)
	if r1.Op != "SORT ORDER BY" || r1.Depth != 1 || r1.ERows != 100000 || r1.Cost != 2014 || r1.QBlock != "SEL$1" || r1.Alias != "" {
		t.Errorf("row 1 = %+v", r1)
	}
	if r2.Op != "TABLE ACCESS FULL" || r2.Name != "MTK_ORDERS" || r2.Depth != 2 || r2.Alias != "O@SEL$1" || r2.QBlock != "SEL$1" || r2.Cost != 137 {
		t.Errorf("row 2 = %+v", r2)
	}
	if r2.Access != "" || r2.Filter != "" {
		t.Error("the fixture plan has no predicates")
	}
}
