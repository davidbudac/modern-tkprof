package report

import (
	"archive/zip"
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// CSVFacts are the rows ExportCSV reads for the tables the model may not hold:
// calls, waits and bind values. slice.FactSource is one (the spill of an
// aggregation-only model).
type CSVFacts interface {
	analyze.Facts
	// Binds are the binds of bind set id in position order.
	Binds(set model.ID) []model.Bind
	// NumBindSets and BindSetAt give the bind sets (Line, Cursor, Statement);
	// their Call is not needed: the owner is the call whose BindSet it is.
	NumBindSets() int64
	BindSetAt(set model.ID) (model.BindSet, bool)
}

// ModelCSVFacts is the CSVFacts of a model that holds its fact tables.
func ModelCSVFacts(m *model.Model) CSVFacts { return modelCSVFacts{analyze.ModelFacts(m), m} }

type modelCSVFacts struct {
	analyze.Facts
	m *model.Model
}

func (f modelCSVFacts) Binds(set model.ID) []model.Bind {
	bs := &f.m.BindSets[set]
	return f.m.Binds[bs.First : int(bs.First)+int(bs.N)]
}

func (f modelCSVFacts) NumBindSets() int64 { return int64(len(f.m.BindSets)) }

func (f modelCSVFacts) BindSetAt(set model.ID) (model.BindSet, bool) {
	if set < 0 || int(set) >= len(f.m.BindSets) {
		return model.BindSet{}, false
	}
	return f.m.BindSets[set], true
}

// csvTables receives the tables in order: rows calls emit once per row and
// returns the first error.
type csvTables func(name string, header []string, rows func(emit func([]string) error) error) error

// ExportCSV writes the fact and dimension tables as CSV files into dir, one
// file per table, with ids resolved to human-readable keys (sql_id, event
// name, call kind) so the files load straight into DuckDB, Excel or Python.
func ExportCSV(m *model.Model, dir string) ([]string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	var written []string
	err := exportTables(context.Background(), m, ModelCSVFacts(m), func(name string, header []string, rows func(func([]string) error) error) error {
		path := filepath.Join(dir, name)
		f, err := os.Create(path)
		if err != nil {
			return err
		}
		if err := writeCSV(f, header, rows); err != nil {
			f.Close()
			return err
		}
		written = append(written, path)
		return f.Close()
	})
	return written, err
}

// ExportCSVZip writes the files ExportCSV writes (same names and bytes) as a
// zip archive, reading calls, waits and bind values from f, which may be the
// spill of an aggregation-only model.
func ExportCSVZip(ctx context.Context, w io.Writer, m *model.Model, f CSVFacts) error {
	zw := zip.NewWriter(w)
	err := exportTables(ctx, m, f, func(name string, header []string, rows func(func([]string) error) error) error {
		fw, err := zw.Create(name)
		if err != nil {
			return err
		}
		return writeCSV(fw, header, rows)
	})
	if err != nil {
		return err
	}
	return zw.Close()
}

func writeCSV(w io.Writer, header []string, rows func(func([]string) error) error) error {
	cw := csv.NewWriter(w)
	if err := cw.Write(header); err != nil {
		return err
	}
	if err := rows(cw.Write); err != nil {
		return err
	}
	cw.Flush()
	return cw.Error()
}

func exportTables(ctx context.Context, m *model.Model, facts CSVFacts, table csvTables) error {
	// write is a table of n rows addressed by index
	write := func(name string, header []string, n int, row func(i int) []string) error {
		return table(name, header, func(emit func([]string) error) error {
			for i := 0; i < n; i++ {
				if err := emit(row(i)); err != nil {
					return err
				}
			}
			return nil
		})
	}
	i64 := func(v int64) string { return strconv.FormatInt(v, 10) }
	nz := func(v int64) string { // blank for "not set"
		if v == 0 {
			return ""
		}
		return i64(v)
	}
	i := func(v int) string { return strconv.Itoa(v) }
	n32 := func(v int32) string { return strconv.FormatInt(int64(v), 10) }
	id := func(v model.ID) string {
		if v == model.None {
			return ""
		}
		return strconv.Itoa(int(v))
	}
	b := func(v bool) string {
		if v {
			return "1"
		}
		return "0"
	}
	sqlid := func(s model.ID) string {
		if s == model.None {
			return ""
		}
		st := &m.Statements[s]
		if st.Kind == model.StmtSQL {
			return st.SQLID
		}
		return st.Kind.String()
	}
	wall := func(us int64) string {
		if us == 0 {
			return ""
		}
		return i64(us)
	}

	if err := write("statements.csv",
		[]string{"statement_id", "kind", "sql_id", "hash_value", "command_type", "command", "parsing_user_id", "min_depth", "first_line", "cursors", "sql_text"},
		len(m.Statements), func(k int) []string {
			s := &m.Statements[k]
			return []string{id(s.ID), s.Kind.String(), s.SQLID, strconv.FormatUint(s.HV, 10), i(s.OCT), s.Command, i(s.UID), i(s.MinDep), i(s.FirstLine), i(len(s.Cursors)), s.Text}
		}); err != nil {
		return err
	}
	if err := write("cursors.csv",
		[]string{"cursor_id", "cursor_number", "statement_id", "sql_id", "line", "depth", "plan_hash", "context_id", "implicit", "assumed", "execs"},
		len(m.Cursors), func(k int) []string {
			c := &m.Cursors[k]
			return []string{id(c.ID), strconv.FormatUint(c.Number, 10), id(c.Statement), sqlid(c.Statement), i(c.Line), i(c.Dep), strconv.FormatUint(c.PLH, 10), id(c.Context), b(c.Implicit), b(c.Assumed), i(int(c.Execs))}
		}); err != nil {
		return err
	}
	if err := write("contexts.csv",
		[]string{"context_id", "line", "session_id", "client_id", "service", "module", "action", "client_driver", "container_id", "process"},
		len(m.Contexts), func(k int) []string {
			c := &m.Contexts[k]
			return []string{id(c.ID), i(c.Line), c.SessionID, c.ClientID, c.Service, c.Module, c.Action, c.ClientDriver, c.ContainerID, c.Process}
		}); err != nil {
		return err
	}
	if err := write("events.csv",
		[]string{"event_id", "name", "wait_class", "idle", "p1_name", "p2_name", "p3_name"},
		len(m.Events), func(k int) []string {
			e := &m.Events[k]
			return []string{id(e.ID), e.Name, e.Class, b(e.Idle), e.P1Name, e.P2Name, e.P3Name}
		}); err != nil {
		return err
	}
	owner := make([]model.ID, facts.NumBindSets()) // the call of each bind set, noted by the calls table
	for k := range owner {
		owner[k] = model.None
	}
	if err := table("calls.csv",
		[]string{"call_id", "line", "kind", "cursor_id", "statement_id", "sql_id", "cpu_us", "ela_us", "disk", "query", "current", "misses", "rows", "depth", "opt_goal", "plan_hash", "tim", "wall_us", "close_type", "parent_call_id", "self_ela_us", "self_cpu_us", "self_disk", "self_query", "self_current", "context_id", "exec_no", "bind_set_id", "wait_ela_us", "idle_ela_us", "waits", "orphan", "synthetic"},
		func(emit func([]string) error) error {
			var werr error
			err := facts.EachCall(ctx, analyze.Scan{}, func(c *model.Call) bool {
				if bs := c.BindSet; bs >= 0 && int(bs) < len(owner) {
					owner[bs] = c.ID
				}
				werr = emit([]string{id(c.ID), n32(c.Line), c.Kind.String(), id(c.Cursor), id(c.Statement), sqlid(c.Statement), i64(c.C), i64(c.E), i64(c.P), i64(c.CR), i64(c.CU), n32(c.Mis), i64(c.R), i(int(c.Dep)), i(int(c.OG)), strconv.FormatUint(uint64(c.PLH), 10), i64(c.Tim), wall(m.CallWall(c)), i(int(c.Type)), id(c.Parent), i64(c.SelfE), i64(c.SelfC), i64(c.SelfP), i64(c.SelfCR), i64(c.SelfCU), id(c.Context), i(int(c.ExecNo)), id(c.BindSet), i64(c.WaitEla), i64(c.IdleEla), i(int(c.NWaits)), b(c.Orphan), b(c.Synthetic)})
				return werr == nil
			})
			if werr != nil {
				return werr
			}
			return err
		}); err != nil {
		return err
	}
	if err := table("waits.csv",
		[]string{"wait_id", "line", "event", "wait_class", "ela_us", "p1", "p2", "p3", "obj", "tim", "wall_us", "cursor_id", "statement_id", "sql_id", "call_id", "call_kind", "context_id", "depth", "between_calls", "idle", "object_name", "file_name"},
		func(emit func([]string) error) error {
			var werr error
			err := facts.EachWait(ctx, analyze.Scan{}, func(w *model.Wait) bool {
				ev := &m.Events[w.Event]
				kind := ""
				if w.Call != model.None {
					if k, ok := facts.CallKind(w.Call); ok {
						kind = k.String()
					}
				}
				fileName := ""
				if f, ok := m.WaitFile(w); ok {
					fileName = m.FileName(f)
				}
				werr = emit([]string{id(w.ID), n32(w.Line), ev.Name, ev.Class, i64(w.Ela), i64(w.P1), i64(w.P2), i64(w.P3), i64(w.ObjID), i64(w.Tim), wall(m.WaitWall(w)), id(w.Cursor), id(w.Statement), sqlid(w.Statement), id(w.Call), kind, id(w.Context), i(int(w.Dep)), b(w.Between), b(w.Idle), m.ObjectName(w.ObjID), fileName})
				return werr == nil
			})
			if werr != nil {
				return werr
			}
			return err
		}); err != nil {
		return err
	}
	if err := table("binds.csv",
		[]string{"bind_set_id", "line", "cursor_id", "statement_id", "sql_id", "call_id", "position", "dty", "type", "value", "is_null", "no_def", "is_dump", "max_array_len", "actual_len", "kind", "typed"},
		func(emit func([]string) error) error {
			for k := range owner {
				bs, ok := facts.BindSetAt(model.ID(k))
				if !ok {
					continue
				}
				binds := facts.Binds(bs.ID)
				for j := range binds {
					bd := &binds[j]
					if err := emit([]string{id(bs.ID), i(bs.Line), id(bs.Cursor), id(bs.Statement), sqlid(bs.Statement), id(owner[k]), n32(bd.Pos), n32(bd.Dty), bd.TypeName(), bd.Value, b(bd.IsNull), b(bd.NoDef), b(bd.IsDump), n32(bd.Mal), n32(bd.Avl), bd.Kind().String(), bd.Typed()}); err != nil {
						return err
					}
				}
			}
			return nil
		}); err != nil {
		return err
	}
	if err := write("plan_lines.csv",
		[]string{"plan_id", "plan_line_no", "statement_id", "sql_id", "plan_hash", "cursor_id", "stat_line", "id", "parent_id", "depth", "operation", "object_name", "obj", "rows", "starts", "cr", "pr", "pw", "time_us", "cost", "size", "card", "owner", "access_predicates", "filter_predicates", "e_rows"},
		len(m.PlanLines), func(k int) []string {
			l := &m.PlanLines[k]
			p := &m.Plans[l.Plan]
			return []string{id(p.ID), i(k - int(p.First)), id(p.Statement), sqlid(p.Statement), strconv.FormatUint(p.PLH, 10), id(p.Cursor), i(p.Line), i(l.ID), i(l.ParentID), i(l.Depth), l.Op, l.Object, i64(l.Obj), i64(l.Cnt), i64(l.Str), i64(l.CR), i64(l.PR), i64(l.PW), i64(l.TimeUs), i64(l.Cost), i64(l.Size), i64(l.Card), m.ObjectOwner(l.Obj), l.Access, l.Filter, nz(l.ERows)}
		}); err != nil {
		return err
	}
	if err := write("transactions.csv",
		[]string{"transaction_id", "line", "rollback", "read_only", "tim", "wall_us", "call_id", "context_id"},
		len(m.Transactions), func(k int) []string {
			t := &m.Transactions[k]
			return []string{id(t.ID), i(t.Line), i(t.Rlbk), i(t.RdOnly), i64(t.Tim), wall(t.WallUs), id(t.Call), id(t.Context)}
		}); err != nil {
		return err
	}
	if err := write("errors.csv",
		[]string{"error_id", "line", "ora_error", "parse_error", "cursor_id", "statement_id", "sql_id", "tim", "wall_us", "text"},
		len(m.Errors), func(k int) []string {
			e := &m.Errors[k]
			return []string{id(e.ID), i(e.Line), fmt.Sprintf("ORA-%05d", e.Err), b(e.ParseError), id(e.Cursor), id(e.Statement), sqlid(e.Statement), i64(e.Tim), wall(e.WallUs), e.Text}
		}); err != nil {
		return err
	}
	return nil
}
