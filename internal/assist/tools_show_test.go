package assist

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestShow(t *testing.T) {
	env := loadEnv(t, "basic_binds", false)
	var sent []Intent
	var hrefs []string
	env.Show = func(in Intent, href string) error { sent, hrefs = append(sent, in), append(hrefs, href); return nil }
	m := env.Model
	base := m.Span.FirstTim
	// an execution of the 10-execution select, as executions names it
	_, ex := call(t, env, "executions", `{"sql_id":"f6jyzt7462kx2","limit":1}`)
	e0 := obj(list(ex["executions"])[0])
	execNo, cursorLine := num(e0["execNo"]), num(e0["cursorLine"])
	ctxs := len(m.Contexts)

	for _, c := range []struct{ args, href string }{
		{`{}`, "mtkprof:#view=overview"},
		{`{"sql_id":"f6jyzt7462kx2"}`, "mtkprof:#view=statements&sql=f6jyzt7462kx2"},
		{`{"sql_id":"@3"}`, "mtkprof:#view=statements&sql=f6jyzt7462kx2"}, // the normal form
		{`{"event":"SQL*Net message from client"}`, "mtkprof:#view=waits&ev=SQL*Net+message+from+client"},
		{`{"view":"timeline","from":` + itoa(base+1000) + `,"to":` + itoa(base+5000) + `}`, "mtkprof:#view=timeline&win=1000-5000"},
		{`{"view":"timeline","from":0,"to":` + itoa(base+5000) + `}`, "mtkprof:#view=timeline&win=0-5000"}, // clipped to the trace
		{`{"sql_id":"f6jyzt7462kx2","execNo":` + itoa(execNo) + `,"cursorLine":` + itoa(cursorLine) + `}`,
			"mtkprof:#view=statements&sql=f6jyzt7462kx2&exec=" + itoa(cursorLine) + ":" + itoa(execNo)},
		{`{"view":"sessions","contexts":[0,` + itoa(int64(ctxs-1)) + `]}`, "mtkprof:#view=sessions&contexts=0," + itoa(int64(ctxs-1))},
		{`{"line":120}`, "mtkprof:#view=lines&line=120"},
		{`{"pivot":{"fact":"waits","by":["event"],"sort":"ela"}}`, "mtkprof:#view=pivot"},
	} {
		sent = nil
		_, v := call(t, env, "show", c.args)
		if v["href"] != c.href || len(sent) != 1 || hrefs[len(hrefs)-1] != c.href || v["sent"] != true {
			t.Errorf("show %s: %v, want %s", c.args, v, c.href)
		}
	}
	if p := sent[0].Pivot; p == nil || p.Fact != "waits" || p.By[0] != "event" {
		t.Errorf("pivot intent %+v", sent[0])
	}

	for _, c := range []struct{ args, want string }{
		{`{"view":"compare"}`, "view: want one of"},
		{`{"sql_id":"zzzz"}`, "not in this trace"},
		{`{"execNo":1,"cursorLine":5}`, "of the statement sql_id names"},
		{`{"sql_id":"f6jyzt7462kx2","execNo":1}`, "both cursorLine and execNo"},
		{`{"sql_id":"f6jyzt7462kx2","execNo":1,"cursorLine":1}`, "no cursor of f6jyzt7462kx2 opens at that line"},
		{`{"sql_id":"f6jyzt7462kx2","execNo":999,"cursorLine":` + itoa(cursorLine) + `}`, "executions"},
		{`{"event":"no such wait"}`, "not in this trace"},
		{`{"from":` + itoa(m.Span.LastTim+10) + `,"to":` + itoa(m.Span.LastTim+20) + `}`, "inside the trace"},
		{`{"contexts":[99]}`, "not a session context"},
		{`{"view":"waits","line":3}`, "go with view lines"},
		{`{"line":99999999}`, "lines"},
		{`{"view":"waits","pivot":{"by":["event"]}}`, "goes with view pivot"},
		{`{"pivot":{"fact":"waits","by":["nope"]}}`, "not a waits dimension"},
		{`{"pivot":{"fact":"calls","by":["stmt"],"event":"x"}}`, "goes with fact waits"},
		{`{"pivot":{"by":["stmt"],"sort":"zz"}}`, "not a calls measure"},
		{`{"pivot":{"by":[]}}`, "one or two"},
		{`{"vieww":"x"}`, "unknown field"},
	} {
		_, err := Call(context.Background(), env, "show", json.RawMessage(c.args))
		var ae *ArgError
		if !errors.As(err, &ae) || !strings.Contains(ae.Msg, c.want) {
			t.Errorf("show %s: %v, want an ArgError with %q", c.args, err, c.want)
		}
	}
	env.Show = nil
	if _, err := Call(context.Background(), env, "show", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "open conversation turn") {
		t.Errorf("show without a turn: %v", err)
	}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }
