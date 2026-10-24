package report

import (
	"encoding/csv"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// ExportCSV writes the fact and dimension tables as CSV files into dir, one
// file per table, with ids resolved to human-readable keys (sql_id, event
// name, call kind) so the files load straight into DuckDB, Excel or Python.
func ExportCSV(m *model.Model, dir string) ([]string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	var written []string
	write := func(name string, header []string, n int, row func(i int) []string) error {
		path := filepath.Join(dir, name)
		f, err := os.Create(path)
		if err != nil {
			return err
		}
		w := csv.NewWriter(f)
		if err := w.Write(header); err != nil {
			f.Close()
			return err
		}
		for i := 0; i < n; i++ {
			if err := w.Write(row(i)); err != nil {
				f.Close()
				return err
			}
		}
		w.Flush()
		if err := w.Error(); err != nil {
			f.Close()
			return err
		}
		written = append(written, path)
		return f.Close()
	}
	i64 := func(v int64) string { return strconv.FormatInt(v, 10) }
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
		return written, err
	}
	if err := write("cursors.csv",
		[]string{"cursor_id", "cursor_number", "statement_id", "sql_id", "line", "depth", "plan_hash", "context_id", "implicit", "assumed", "execs"},
		len(m.Cursors), func(k int) []string {
			c := &m.Cursors[k]
			return []string{id(c.ID), strconv.FormatUint(c.Number, 10), id(c.Statement), sqlid(c.Statement), i(c.Line), i(c.Dep), strconv.FormatUint(c.PLH, 10), id(c.Context), b(c.Implicit), b(c.Assumed), i(int(c.Execs))}
		}); err != nil {
		return written, err
	}
	if err := write("contexts.csv",
		[]string{"context_id", "line", "session_id", "client_id", "service", "module", "action", "client_driver", "container_id", "process"},
		len(m.Contexts), func(k int) []string {
			c := &m.Contexts[k]
			return []string{id(c.ID), i(c.Line), c.SessionID, c.ClientID, c.Service, c.Module, c.Action, c.ClientDriver, c.ContainerID, c.Process}
		}); err != nil {
		return written, err
	}
	if err := write("events.csv",
		[]string{"event_id", "name", "wait_class", "idle", "p1_name", "p2_name", "p3_name"},
		len(m.Events), func(k int) []string {
			e := &m.Events[k]
			return []string{id(e.ID), e.Name, e.Class, b(e.Idle), e.P1Name, e.P2Name, e.P3Name}
		}); err != nil {
		return written, err
	}
	if err := write("calls.csv",
		[]string{"call_id", "line", "kind", "cursor_id", "statement_id", "sql_id", "cpu_us", "ela_us", "disk", "query", "current", "misses", "rows", "depth", "opt_goal", "plan_hash", "tim", "wall_us", "close_type", "parent_call_id", "self_ela_us", "self_cpu_us", "self_disk", "self_query", "self_current", "context_id", "exec_no", "bind_set_id", "wait_ela_us", "idle_ela_us", "waits", "orphan", "synthetic"},
		len(m.Calls), func(k int) []string {
			c := &m.Calls[k]
			return []string{id(c.ID), n32(c.Line), c.Kind.String(), id(c.Cursor), id(c.Statement), sqlid(c.Statement), i64(c.C), i64(c.E), i64(c.P), i64(c.CR), i64(c.CU), n32(c.Mis), i64(c.R), i(int(c.Dep)), i(int(c.OG)), strconv.FormatUint(uint64(c.PLH), 10), i64(c.Tim), wall(m.CallWall(c)), i(int(c.Type)), id(c.Parent), i64(c.SelfE), i64(c.SelfC), i64(c.SelfP), i64(c.SelfCR), i64(c.SelfCU), id(c.Context), i(int(c.ExecNo)), id(c.BindSet), i64(c.WaitEla), i64(c.IdleEla), i(int(c.NWaits)), b(c.Orphan), b(c.Synthetic)}
		}); err != nil {
		return written, err
	}
	if err := write("waits.csv",
		[]string{"wait_id", "line", "event", "wait_class", "ela_us", "p1", "p2", "p3", "obj", "tim", "wall_us", "cursor_id", "statement_id", "sql_id", "call_id", "call_kind", "context_id", "depth", "between_calls", "idle", "object_name", "file_name"},
		len(m.Waits), func(k int) []string {
			w := &m.Waits[k]
			ev := &m.Events[w.Event]
			kind := ""
			if w.Call != model.None {
				kind = m.Calls[w.Call].Kind.String()
			}
			fileName := ""
			if f, ok := m.WaitFile(w); ok {
				fileName = m.FileName(f)
			}
			return []string{id(w.ID), n32(w.Line), ev.Name, ev.Class, i64(w.Ela), i64(w.P1), i64(w.P2), i64(w.P3), i64(w.ObjID), i64(w.Tim), wall(m.WaitWall(w)), id(w.Cursor), id(w.Statement), sqlid(w.Statement), id(w.Call), kind, id(w.Context), i(int(w.Dep)), b(w.Between), b(w.Idle), m.ObjectName(w.ObjID), fileName}
		}); err != nil {
		return written, err
	}
	if err := write("binds.csv",
		[]string{"bind_set_id", "line", "cursor_id", "statement_id", "sql_id", "call_id", "position", "dty", "type", "value", "is_null", "no_def", "is_dump", "max_array_len", "actual_len"},
		len(m.Binds), func(k int) []string {
			bd := &m.Binds[k]
			bs := &m.BindSets[bd.Set]
			return []string{id(bs.ID), i(bs.Line), id(bs.Cursor), id(bs.Statement), sqlid(bs.Statement), id(bs.Call), n32(bd.Pos), n32(bd.Dty), bd.TypeName(), bd.Value, b(bd.IsNull), b(bd.NoDef), b(bd.IsDump), n32(bd.Mal), n32(bd.Avl)}
		}); err != nil {
		return written, err
	}
	if err := write("plan_lines.csv",
		[]string{"plan_id", "plan_line_no", "statement_id", "sql_id", "plan_hash", "cursor_id", "stat_line", "id", "parent_id", "depth", "operation", "object_name", "obj", "rows", "starts", "cr", "pr", "pw", "time_us", "cost", "size", "card", "owner"},
		len(m.PlanLines), func(k int) []string {
			l := &m.PlanLines[k]
			p := &m.Plans[l.Plan]
			return []string{id(p.ID), i(k - int(p.First)), id(p.Statement), sqlid(p.Statement), strconv.FormatUint(p.PLH, 10), id(p.Cursor), i(p.Line), i(l.ID), i(l.ParentID), i(l.Depth), l.Op, l.Object, i64(l.Obj), i64(l.Cnt), i64(l.Str), i64(l.CR), i64(l.PR), i64(l.PW), i64(l.TimeUs), i64(l.Cost), i64(l.Size), i64(l.Card), m.ObjectOwner(l.Obj)}
		}); err != nil {
		return written, err
	}
	if err := write("transactions.csv",
		[]string{"transaction_id", "line", "rollback", "read_only", "tim", "wall_us", "call_id", "context_id"},
		len(m.Transactions), func(k int) []string {
			t := &m.Transactions[k]
			return []string{id(t.ID), i(t.Line), i(t.Rlbk), i(t.RdOnly), i64(t.Tim), wall(t.WallUs), id(t.Call), id(t.Context)}
		}); err != nil {
		return written, err
	}
	if err := write("errors.csv",
		[]string{"error_id", "line", "ora_error", "parse_error", "cursor_id", "statement_id", "sql_id", "tim", "wall_us", "text"},
		len(m.Errors), func(k int) []string {
			e := &m.Errors[k]
			return []string{id(e.ID), i(e.Line), fmt.Sprintf("ORA-%05d", e.Err), b(e.ParseError), id(e.Cursor), id(e.Statement), sqlid(e.Statement), i64(e.Tim), wall(e.WallUs), e.Text}
		}); err != nil {
		return written, err
	}
	_ = trace.CallParse
	return written, nil
}
