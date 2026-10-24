package model

import (
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/ref"
)

// A hand-built model (one statement, two STAT dumps with different plan
// hashes) against a hand-written DBMS_XPLAN text: only the dump with the
// same plan hash is overlaid, by operation id.
const xplanText = `SQL_ID  q1, child number 0
-------------------------------------
select * from t where a = 1

Plan hash value: 555

------------------------------------------------------------
| Id  | Operation          | Name | Rows  | Bytes | Cost (%CPU)|
------------------------------------------------------------
|   0 | SELECT STATEMENT   |      |       |       |     3 (100)|
|   1 |  TABLE ACCESS FULL | T    |    10 |   130 |     3   (0)|
------------------------------------------------------------

Query Block Name / Object Alias (identified by operation id):
-------------------------------------------------------------

   1 - SEL$1 / T@SEL$1

Predicate Information (identified by operation id):
---------------------------------------------------

   1 - filter("A"=1)
`

func TestApplyRefOverlaysXPlanByHash(t *testing.T) {
	m := &Model{}
	m.Statements = []Statement{{ID: 0, Kind: StmtSQL, SQLID: "q1"}}
	m.Plans = []Plan{
		{ID: 0, Statement: 0, PLH: 555, First: 0, N: 1},
		{ID: 1, Statement: 0, PLH: 999, First: 1, N: 1},
	}
	m.PlanLines = []PlanLine{
		{Plan: 0, ID: 1, Op: "TABLE ACCESS FULL", Object: "T", Cost: -1, Size: -1, Card: -1},
		{Plan: 1, ID: 1, Op: "TABLE ACCESS FULL", Object: "T", Cost: 3, Size: 130, Card: 10},
	}
	ApplyRef(m, &ref.Bundle{Plans: map[string]string{"q1": xplanText}})

	l := m.PlanLines[0]
	if !m.Plans[0].XPlanMatched || l.Filter != `"A"=1` || l.Access != "" || l.Alias != "T@SEL$1" || l.QBlock != "SEL$1" || l.ERows != 10 {
		t.Errorf("matching plan not overlaid: matched=%v line=%+v", m.Plans[0].XPlanMatched, l)
	}
	if o := m.PlanLines[1]; m.Plans[1].XPlanMatched || o.Filter != "" || o.Alias != "" || o.ERows != 0 {
		t.Errorf("plan with another hash was overlaid: %+v", o)
	}
	notes := strings.Join(m.Diag.Notes, "\n")
	if !strings.Contains(notes, "plans/q1.txt has plan hash 555; trace plan hash 999 differs") {
		t.Errorf("no mismatch note in %q", notes)
	}
	if !strings.Contains(notes, "1 of 2 STAT plans overlaid") {
		t.Errorf("no summary in %q", notes)
	}
}

// A STAT card is kept; the estimate only fills in where STAT has none.
func TestApplyRefXPlanKeepsStatCard(t *testing.T) {
	m := &Model{}
	m.Statements = []Statement{{ID: 0, Kind: StmtSQL, SQLID: "q1"}}
	m.Plans = []Plan{{ID: 0, Statement: 0, PLH: 555, First: 0, N: 1}}
	m.PlanLines = []PlanLine{{Plan: 0, ID: 1, Op: "TABLE ACCESS FULL", Cost: 3, Size: 130, Card: 7}}
	ApplyRef(m, &ref.Bundle{Plans: map[string]string{"q1": xplanText}})
	if l := m.PlanLines[0]; l.Card != 7 || l.ERows != 0 || l.Filter == "" {
		t.Errorf("line = %+v", l)
	}
}
