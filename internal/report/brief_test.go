package report_test

import (
	"context"
	"flag"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/slice"
)

var updateBrief = flag.Bool("update-brief", false, "rewrite testdata/brief_basic_binds.md from Brief")

const traces = "../../testdata/traces/19c/"

func load(t *testing.T, name string) (*model.Model, report.BriefSource) {
	t.Helper()
	m, err := model.Build(traces+name+".trc", model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return m, slice.MemSource(m)
}

func brief(t *testing.T, name string, f analyze.Filter, o report.BriefOptions) string {
	t.Helper()
	m, src := load(t, name)
	return briefOf(t, m, src, f, o)
}

func briefOf(t *testing.T, m *model.Model, src report.BriefSource, f analyze.Filter, o report.BriefOptions) string {
	t.Helper()
	res, err := report.Brief(context.Background(), m, src, f, o)
	if err != nil {
		t.Fatal(err)
	}
	if res.EstTokens != len(res.Markdown)/4 {
		t.Errorf("EstTokens %d, want %d", res.EstTokens, len(res.Markdown)/4)
	}
	return res.Markdown
}

var headings = regexp.MustCompile("(?m)^### (\\d+)\\. `([^`]+)`")

func listed(md string) []string {
	var ids []string
	for _, m := range headings.FindAllStringSubmatch(md, -1) {
		ids = append(ids, m[2])
	}
	return ids
}

// TestBriefPinned pins the whole text of the brief of basic_binds with the
// default options, a fixed salt apart.
func TestBriefPinned(t *testing.T) {
	got := brief(t, "basic_binds", analyze.Filter{}, report.BriefOptions{Salt: "pin"})
	path := "testdata/brief_basic_binds.md"
	if *updateBrief {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Errorf("Brief differs from %s (go test ./internal/report -run BriefPinned -update-brief)", path)
	}
	if !strings.HasPrefix(got, "# Trace brief\n") || !strings.Contains(got, "\n## For the agent\n") {
		t.Errorf("brief does not start with the title or lacks the agent section")
	}
}

func TestBriefDeterministic(t *testing.T) {
	m, src := load(t, "bind_types")
	a := briefOf(t, m, src, analyze.Filter{}, report.BriefOptions{Salt: "s"})
	b := briefOf(t, m, src, analyze.Filter{}, report.BriefOptions{Salt: "s"})
	if a != b {
		t.Error("two briefs of the same trace and salt differ")
	}
}

// TestBriefWindow: a window drops the statements that have no call in it and
// the header names it.
func TestBriefWindow(t *testing.T) {
	m, src := load(t, "basic_binds")
	all := briefOf(t, m, src, analyze.Filter{}, report.BriefOptions{MaxStatements: 50})
	stats := analyze.Statements(m)
	var from int64
	for i := range stats {
		if m.Statements[i].SQLID == "a6txjhtbq9x8p" {
			from = stats[i].FirstTim
		}
	}
	if from == 0 {
		t.Fatal("fixture changed: a6txjhtbq9x8p not found")
	}
	f := analyze.Filter{StartTim: from}
	win := briefOf(t, m, src, f, report.BriefOptions{MaxStatements: 50})
	inWin, err := analyze.StatementsOn(context.Background(), m, src, f)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed(win)) == 0 || len(listed(win)) >= len(listed(all)) {
		t.Fatalf("whole trace lists %v, the window %v", listed(all), listed(win))
	}
	for _, id := range listed(win) {
		for i := range m.Statements {
			if m.Statements[i].SQLID == id && inWin[i].AllCalls.Count == 0 {
				t.Errorf("statement %s listed, but it has no call in the window", id)
			}
		}
	}
	if !strings.Contains(all, "f6jyzt7462kx2") || strings.Contains(win, "f6jyzt7462kx2") {
		t.Errorf("f6jyzt7462kx2 ends before the window: in whole trace %v, in window %v", strings.Contains(all, "f6jyzt7462kx2"), strings.Contains(win, "f6jyzt7462kx2"))
	}
	if !strings.Contains(win, "**Window:** a time window (") || !strings.Contains(win, fmt.Sprintf("tim %d to %d", from, m.Span.LastTim)) {
		t.Errorf("header does not name the window:\n%s", win[:strings.Index(win, "**Response time")])
	}
}

func TestBriefContexts(t *testing.T) {
	m, _ := load(t, "multisession_a")
	if len(m.Contexts) < 2 {
		t.Fatalf("%d contexts", len(m.Contexts))
	}
	all := brief(t, "multisession_a", analyze.Filter{}, report.BriefOptions{MaxStatements: 50})
	one := brief(t, "multisession_a", analyze.Filter{Contexts: []model.ID{0}}, report.BriefOptions{MaxStatements: 50})
	if !strings.Contains(one, "1 of ") || strings.Contains(one, "context 1:") || len(one) >= len(all) {
		t.Errorf("context 0 only:\n%s", one[:strings.Index(one, "**Window")])
	}
}

var bindHash = regexp.MustCompile(`<[A-Z0-9 ]+ len=\d+ h=[0-9a-f]{8}>`)

// bindValues are the traced values long enough to tell apart from the text
// around them, that appear in no statement text.
func bindValues(m *model.Model) []string {
	var text strings.Builder
	for i := range m.Statements {
		text.WriteString(m.Statements[i].Text)
	}
	for i := range m.PlanLines {
		l := &m.PlanLines[i]
		text.WriteString(l.Op + l.Object + l.Access + l.Filter)
	}
	seen := map[string]bool{}
	var out []string
	for i := range m.Binds {
		b := &m.Binds[i]
		if b.IsNull || b.NoDef || b.IsDump || len(b.Value) < 4 || seen[b.Value] || strings.Contains(text.String(), b.Value) {
			continue
		}
		seen[b.Value] = true
		out = append(out, b.Value)
	}
	return out
}

// TestBriefMask: mask leaves no traced bind value in the text, equal values
// get equal tokens inside a brief and other tokens in the next, keep shows the
// values and none no binds.
func TestBriefMask(t *testing.T) {
	for _, name := range []string{"bind_types", "basic_binds"} {
		m, src := load(t, name)
		values := bindValues(m)
		if len(values) < 3 {
			t.Fatalf("%s: only %d bind values to look for", name, len(values))
		}
		opts := func(b report.BriefBinds, salt string) report.BriefOptions {
			return report.BriefOptions{Binds: b, Salt: salt, MaxStatements: 50}
		}
		masked := briefOf(t, m, src, analyze.Filter{}, opts(report.BriefBindsMask, "one"))
		for _, v := range values {
			if strings.Contains(masked, v) {
				t.Errorf("%s: masked brief contains the bind value %q", name, v)
			}
		}
		toks := bindHash.FindAllString(masked, -1)
		count := map[string]int{}
		repeated := false
		for _, tk := range toks {
			if count[tk]++; count[tk] > 1 {
				repeated = true
			}
		}
		if len(toks) == 0 || !repeated {
			t.Errorf("%s: %d masked tokens, repeated values %v", name, len(toks), repeated)
		}
		other := briefOf(t, m, src, analyze.Filter{}, opts(report.BriefBindsMask, "two"))
		for tk := range count {
			if strings.Contains(other, tk) {
				t.Errorf("%s: token %s is in two briefs with different salts", name, tk)
				break
			}
		}
		random1 := briefOf(t, m, src, analyze.Filter{}, opts(report.BriefBindsMask, ""))
		random2 := briefOf(t, m, src, analyze.Filter{}, opts(report.BriefBindsMask, ""))
		if random1 == random2 {
			t.Errorf("%s: two briefs without a salt have the same hashes", name)
		}
		kept := briefOf(t, m, src, analyze.Filter{}, opts(report.BriefBindsKeep, ""))
		n := 0
		for _, v := range values {
			if strings.Contains(kept, v) {
				n++
			}
		}
		if n == 0 {
			t.Errorf("%s: keep shows none of the %d bind values", name, len(values))
		}
		none := briefOf(t, m, src, analyze.Filter{}, opts(report.BriefBindsNone, ""))
		if strings.Contains(none, "binds:") || bindHash.MatchString(none) || strings.Contains(none, "- Bind values are") {
			t.Errorf("%s: binds=none still has binds", name)
		}
	}
}

// TestBriefOutlierBinds: the outlier finding appends the traced bind values
// to its evidence; the brief shows them as the binds option says.
func TestBriefOutlierBinds(t *testing.T) {
	m, src := load(t, "basic_binds")
	th := analyze.DefaultThresholds()
	th.OutlierFactor, th.OutlierMinUs, th.OutlierMinExecs = 1.1, 0, 2
	values := bindValues(m)
	for _, mode := range []report.BriefBinds{report.BriefBindsMask, report.BriefBindsKeep, report.BriefBindsNone} {
		md := briefOf(t, m, src, analyze.Filter{}, report.BriefOptions{Binds: mode, Thresholds: &th, Salt: "o", MaxStatements: 50})
		i := strings.Index(md, ". Outlier executions (")
		if i < 0 {
			t.Fatalf("%s: no outlier finding", mode)
		}
		ev := md[i:]
		if j := strings.Index(ev, "\n### "); j > 0 {
			ev = ev[:j]
		} else if j := strings.Index(ev, "\n## "); j > 0 {
			ev = ev[:j]
		}
		if strings.Contains(ev, analyze.EvidenceBindsMarker) {
			t.Errorf("%s: the rule's own bind preview is in the evidence", mode)
		}
		shown := strings.Contains(ev, "; binds ")
		if want := mode != report.BriefBindsNone; shown != want {
			t.Errorf("%s: binds in the evidence: %v", mode, shown)
		}
		leak := false
		for _, v := range values {
			leak = leak || strings.Contains(ev, v)
		}
		if leak != (mode == report.BriefBindsKeep) {
			t.Errorf("%s: raw bind values in the evidence: %v", mode, leak)
		}
	}
}

func TestBriefCaps(t *testing.T) {
	md := brief(t, "basic_binds", analyze.Filter{}, report.BriefOptions{MaxStatements: 2, MaxSQLChars: 100, MaxPlanLines: 1, Salt: "x"})
	if n := len(listed(md)); n != 2 {
		t.Errorf("%d statements listed, want 2", n)
	}
	if !strings.Contains(md, "more characters not shown") || !strings.Contains(md, "more plan lines") {
		t.Errorf("no truncation marks")
	}
	for _, blk := range regexp.MustCompile("(?s)```sql\n(.*?)\n```").FindAllStringSubmatch(md, -1) {
		if i := strings.Index(blk[1], "\n/*"); len(blk[1]) > 100+len("\n/* 99,999 more characters not shown */") || (i < 0 && len(blk[1]) > 100) {
			t.Errorf("SQL block of %d bytes", len(blk[1]))
		}
	}
	noPlans := brief(t, "basic_binds", analyze.Filter{}, report.BriefOptions{MaxPlanLines: report.BriefNoPlans})
	if strings.Contains(noPlans, "Execution plan") {
		t.Error("plans left in with BriefNoPlans")
	}
}

func TestBriefPlanChange(t *testing.T) {
	m, src := load(t, "plan_change")
	md := briefOf(t, m, src, analyze.Filter{}, report.BriefOptions{})
	if !strings.Contains(md, "Plan change") {
		t.Error("no plan change finding")
	}
	for _, s := range analyze.Statements(m) {
		if len(s.PlanHashes) > 1 {
			for _, h := range s.PlanHashes {
				if !strings.Contains(md, fmt.Sprintf("plan hash %d", h)) {
					t.Errorf("plan hash %d is not in the brief", h)
				}
			}
		}
	}
}

func TestBriefNotes(t *testing.T) {
	m, src := load(t, "basic_binds")
	var first, hidden *model.Statement
	for i := range m.Statements {
		switch st := &m.Statements[i]; st.SQLID {
		case "f6jyzt7462kx2":
			first = st
		case "06nvwn223659v":
			hidden = st
		}
	}
	ref := func(st *model.Statement) *report.NoteStmt {
		return &report.NoteStmt{SQLID: st.SQLID, Hash: report.NoteHash(st.Kind, st.Text)}
	}
	var cursorLine int32
	for _, c := range first.Cursors {
		cursorLine = int32(m.Cursors[c].Line)
		break
	}
	notes := []report.Note{
		{Kind: report.NoteStatement, Note: "STMTNOTE the report query\nsecond line", Stmt: ref(first)},
		{Kind: report.NoteExecution, Note: "EXECNOTE the slow first run", Stmt: ref(first), ExecNo: 1, CursorLine: cursorLine},
		{Kind: report.NoteWindow, Note: "WINDOWNOTE the batch ran here", From: m.Span.FirstTim, To: m.Span.LastTim, Label: "batch"},
		{Kind: report.NoteStatement, Note: "UNLISTEDNOTE minor statement", Stmt: ref(hidden)},
		{Kind: report.NoteStatement, Note: "GONENOTE no such statement", Stmt: &report.NoteStmt{SQLID: "zzzzzzzzzzzzz", Hash: "00000000"}},
		{Kind: report.NoteLine, Note: "LINENOTE look here", File: 0, Line: 1234},
		{Kind: report.NoteStatement, Note: "", Stmt: ref(first)},
	}
	md := briefOf(t, m, src, analyze.Filter{}, report.BriefOptions{Notes: notes, Case: "CASETEXT the nightly job got slower\n# not a heading", Salt: "n"})
	section := func(from, to string) string {
		i := strings.Index(md, from)
		if i < 0 {
			t.Fatalf("no %q in\n%s", from, md)
		}
		j := strings.Index(md[i+len(from):], to)
		if j < 0 {
			return md[i:]
		}
		return md[i : i+len(from)+j]
	}
	stmt1 := section("### 1. `f6jyzt7462kx2`", "\n### 2.")
	for _, want := range []string{"STMTNOTE the report query\n  second line", "EXECNOTE the slow first run", "execution 1"} {
		if !strings.Contains(stmt1, want) {
			t.Errorf("statement 1 lacks %q", want)
		}
	}
	if !strings.Contains(section("### Notes on time windows", "\n## "), "WINDOWNOTE the batch ran here") {
		t.Error("window note not under the window notes")
	}
	other := section("## Other notes", "\n## ")
	for _, want := range []string{"UNLISTEDNOTE", "GONENOTE", "LINENOTE", "06nvwn223659v"} {
		if !strings.Contains(other, want) {
			t.Errorf("other notes lack %q", want)
		}
	}
	for _, w := range []string{"STMTNOTE", "EXECNOTE", "WINDOWNOTE", "CASETEXT"} {
		if n := strings.Count(md, w); n != 1 {
			t.Errorf("%s printed %d times", w, n)
		}
	}
	c, a := strings.Index(md, "## Case description"), strings.Index(md, "## For the agent")
	if c < 0 || a < c || strings.Index(md, "CASETEXT") < c || strings.Index(md, "CASETEXT") > a || !strings.Contains(md, "> # not a heading") {
		t.Error("case text is not quoted in its own section before the agent section")
	}
	if strings.Contains(md, "\n# not a heading") {
		t.Error("case text produced a heading")
	}

	// a window that starts after the trace leaves the window note out and counts it
	late := briefOf(t, m, src, analyze.Filter{StartTim: m.Span.LastTim - 1000}, report.BriefOptions{Notes: notes[:3]})
	if strings.Contains(late, "EXECNOTE") || !strings.Contains(late, "notes are about things outside this scope") {
		t.Errorf("notes outside the window:\n%s", late[strings.Index(late, "## Other notes"):])
	}
}

func TestBriefCheck(t *testing.T) {
	for _, o := range []report.BriefOptions{
		{MaxStatements: -1}, {MaxStatements: 51}, {MaxSQLChars: 5}, {MaxSQLChars: 20001}, {MaxPlanLines: -2}, {MaxPlanLines: 201}, {Binds: 7},
		{Notes: []report.Note{{Kind: "nope"}}},
		{Notes: []report.Note{{Kind: report.NoteStatement}}},
		{Notes: []report.Note{{Kind: report.NoteExecution, Stmt: &report.NoteStmt{SQLID: "a"}}}},
		{Notes: []report.Note{{Kind: report.NoteWindow, From: 5, To: 4}}},
	} {
		if o.Check() == nil {
			t.Errorf("%+v passes", o)
		}
	}
	if err := (report.BriefOptions{MaxPlanLines: report.BriefNoPlans}).Check(); err != nil {
		t.Error(err)
	}
	if _, err := report.ParseBriefBinds("redact"); err == nil {
		t.Error("redact is not a brief bind mode")
	}
}

// TestNoteHash pins the hash against the desktop's textHash (annotations.ts),
// computed there for the same strings.
func TestNoteHash(t *testing.T) {
	for _, c := range []struct {
		kind model.StatementKind
		text string
		want string
	}{
		{0, "select 1 from dual", "a812243a"},
		{0, "select 'ÄÖÜ 日本語 😀' from dual", "17e5a86d"},
		{3, "COMMIT", "997586b5"},
	} {
		if got := report.NoteHash(c.kind, c.text); got != c.want {
			t.Errorf("NoteHash(%d, %q) = %s, want %s", c.kind, c.text, got, c.want)
		}
	}
}
