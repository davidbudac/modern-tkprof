package slice

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

// plan answers GET /api/plan?stmt=<id>|sql_id=<sql_id>[&plh=<hash>][&exec=<n>]:
// what `mtkprof plan` prints for a statement (report.SelectPlans, PlansJSON).
// With plh, the rows of one STAT dump of that plan hash (the row array of
// report.PlanRow); without it the statement's plan hashes: the array when it
// has one, else {"<hash>": rows} in order of first appearance. exec is the
// 1-based dump of the hash; the latest when missing. The model is all it
// needs (plans are dimension tables), so it also works on a server without
// fact rows. A statement or plan that is not in the trace is a 404.
func (s *Server) plan(_ context.Context, q url.Values) (any, error) {
	stmt, sqlID := q.Get("stmt"), q.Get("sql_id")
	var id model.ID
	switch {
	case stmt != "" && sqlID != "":
		return nil, bad("give stmt or sql_id, not both")
	case stmt != "":
		ids, err := idList(q, "stmt", len(s.m.Statements), 1)
		if err != nil {
			return nil, err
		}
		id = ids[0]
	case sqlID != "":
		id = model.None
		for i := range s.m.Statements {
			if s.m.Statements[i].SQLID == sqlID {
				id = model.ID(i)
				break
			}
		}
		if id == model.None {
			return nil, notFound("sql_id " + sqlID + " not found")
		}
	default:
		return nil, bad("stmt (statement id) or sql_id is required")
	}
	n, err := intParam(q, "exec", 0, 0, 1<<31-1)
	if err != nil {
		return nil, err
	}
	plans, err := report.SelectPlans(s.m, id, q.Get("plh"), int(n))
	if err != nil {
		var pe *report.PlanError
		if errors.As(err, &pe) && pe.NotFound {
			return nil, notFound(pe.Msg)
		}
		return nil, bad("plh: %v", err)
	}
	js, err := report.PlansJSON(s.m, plans)
	return json.RawMessage(js), err
}
