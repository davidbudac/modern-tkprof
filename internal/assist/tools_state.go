package assist

import (
	"context"
	"encoding/json"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

// The notes and the view belong to the desktop app, not to the engine: they
// reach a tool only through Env, which the caller that creates a conversation
// fills. A call outside a conversation has none, and says so.
const (
	noNotes = "no notes were supplied: the desktop app passes the trace's notes when it starts a conversation"
	noView  = "no view was supplied: the desktop app passes the current view when it starts a conversation"
)

const maxNoteBytes = 2000

// ---- notes -----------------------------------------------------------------------

type notesArgs struct {
	Kind  string `json:"kind"`
	SQLID string `json:"sql_id"`
}

type noteOut struct {
	ID         string `json:"id,omitempty"`
	Kind       string `json:"kind"`
	Note       string `json:"note"`
	NoteCut    bool   `json:"noteCut,omitempty"`
	Statement  string `json:"statement,omitempty"`           // sql_id, or @N
	NotInTrace bool   `json:"statementNotInTrace,omitempty"` // a note about a statement this trace does not have
	ExecNo     int32  `json:"execNo,omitempty"`
	CursorLine int32  `json:"cursorLine,omitempty"`
	From       int64  `json:"from,omitempty"`
	To         int64  `json:"to,omitempty"`
	Label      string `json:"label,omitempty"`
	File       int32  `json:"file,omitempty"`
	Line       int32  `json:"line,omitempty"`
}

type notesOut struct {
	Supplied  bool      `json:"supplied"`
	Count     int       `json:"count"`
	Notes     []noteOut `json:"notes"`
	Message   string    `json:"message,omitempty"`
	Truncated bool      `json:"truncated,omitempty"`
	Hint      string    `json:"hint,omitempty"`
}

var notesTool = Tool{
	Name: "notes",
	Description: "The DBA's own notes on this trace: on statements, executions, time windows and trace lines, in their words. " +
		"Notes are what the DBA already knows or suspects; weigh them, do not repeat them as findings. " +
		"A note names its statement by sql_id (or @N), an execution by execNo and cursorLine, a window by from and to (tim), a bookmark by file and line.",
	Schema: schema(`"kind":{"type":"string","enum":["statement","execution","window","line"],"description":"only notes of this kind"},` +
		`"sql_id":{"type":"string","description":"only notes about this statement (sql_id or @N)"}`),
	Run: runNotes,
}

// resolveNote finds the statement a note names: the one with its sql_id and
// hash, else the only one with the sql_id (the desktop's resolveStmt).
func resolveNote(m *model.Model, ns *report.NoteStmt) (model.ID, bool) {
	bySQL, n := model.None, 0
	for i := range m.Statements {
		st := &m.Statements[i]
		if st.SQLID != ns.SQLID {
			continue
		}
		if report.NoteHash(st.Kind, st.Text) == ns.Hash {
			return model.ID(i), true
		}
		bySQL = model.ID(i)
		n++
	}
	return bySQL, ns.SQLID != "" && n == 1
}

func runNotes(_ context.Context, e Env, raw json.RawMessage) (Result, error) {
	var a notesArgs
	if err := decodeArgs(raw, &a); err != nil {
		return Result{}, err
	}
	switch a.Kind {
	case "", report.NoteStatement, report.NoteExecution, report.NoteWindow, report.NoteLine:
	default:
		return Result{}, argErrorf("kind: want statement, execution, window or line")
	}
	out := notesOut{Supplied: e.Notes != nil, Notes: []noteOut{}}
	if !out.Supplied {
		out.Message = noNotes
		return e.plain(out)
	}
	x := newStmtIndex(e.Model)
	want := model.None
	if a.SQLID != "" {
		var err error
		if want, err = x.resolve(a.SQLID); err != nil {
			return Result{}, err
		}
	}
	var notes []noteOut
	for i := range e.Notes {
		n := &e.Notes[i]
		if a.Kind != "" && n.Kind != a.Kind {
			continue
		}
		o := noteOut{ID: n.ID, Kind: n.Kind, ExecNo: n.ExecNo, CursorLine: n.CursorLine, From: n.From, To: n.To, Label: n.Label, File: n.File, Line: n.Line}
		o.Note, o.NoteCut = cutText(n.Note, maxNoteBytes)
		if n.Stmt != nil {
			id, ok := resolveNote(e.Model, n.Stmt)
			if ok {
				o.Statement = x.ref(id)
			} else {
				o.Statement, o.NotInTrace = n.Stmt.SQLID, true
			}
			if want != model.None && (!ok || id != want) {
				continue
			}
		} else if want != model.None {
			continue
		}
		notes = append(notes, o)
	}
	out.Count = len(notes)
	if len(notes) == 0 {
		out.Message = "the DBA wrote no notes (of this kind, about this statement)"
	}
	return e.listResult(len(notes), func(n int) any {
		out.Notes = notes[:n]
		out.Truncated = n < len(notes)
		out.Hint = ""
		if out.Truncated {
			out.Hint = cutHint(n, len(notes), "notes", e.maxBytes())
		}
		return out
	})
}

// ---- current_view ----------------------------------------------------------------

var currentViewTool = Tool{
	Name: "current_view",
	Description: "What the DBA is looking at in the app right now: the view (overview, statements, waits, timeline, sessions, pivot, lines), " +
		"the selected statement and wait event, the time window and the files shown. Use it to answer \"this\" and \"here\".",
	Schema: schema(``),
	Run: func(_ context.Context, e Env, raw json.RawMessage) (Result, error) {
		var none struct{}
		if err := decodeArgs(raw, &none); err != nil {
			return Result{}, err
		}
		if e.View == nil {
			return e.plain(struct {
				Supplied bool   `json:"supplied"`
				View     any    `json:"view"`
				Message  string `json:"message"`
			}{false, nil, noView})
		}
		return e.plain(struct {
			Supplied bool  `json:"supplied"`
			View     *View `json:"view"`
		}{true, e.View})
	},
}
