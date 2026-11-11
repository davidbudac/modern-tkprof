package assist

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// The instructions `mtkprof mcp` gives an agent outside mtkprof (Claude Code,
// any MCP client) in its initialize answer.
//
//go:embed mcp_instructions.md
var LocalInstructions string

// localOnly are the tools that need the desktop app (its notes, its view, a
// conversation's open turn); a Local server does not list them.
var localOnly = map[string]bool{"notes": true, "current_view": true, "show": true}

// Local runs the tools in process on traces it opens itself, for an agent
// outside mtkprof: `mtkprof mcp [trace...]`. One trace set is open at a time;
// open_trace replaces it. The zero value masks bind values and has nothing
// open.
type Local struct {
	// KeepBinds shows bind values as traced; by default they are masked with a
	// salt random per process, so equal values match across the traces opened
	// by one server and nowhere else.
	KeepBinds bool
	Log       io.Writer // nil: nothing is logged

	mu      sync.Mutex
	pending []string // opened on the first call that needs a trace
	cur     *localTrace
	redact  *Redactor
}

type localTrace struct {
	paths []string
	env   Env
	lis   []*trace.LineIndex
}

// OpenLater names the trace set the first tool call opens (the paths on the
// command line), so the agent's initialize is answered before it is parsed.
func (l *Local) OpenLater(paths []string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pending = paths
}

// Close closes the open trace's files.
func (l *Local) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.cur.close()
	l.cur = nil
}

func (t *localTrace) close() {
	if t == nil {
		return
	}
	for _, li := range t.lis {
		li.Close()
	}
}

var openTraceTool = Info{
	Name: "open_trace",
	Description: "Open Oracle SQL trace files (event 10046 .trc files, the input of tkprof) for the other tools, replacing the trace open before. " +
		"Give one file, several files of one case, or a directory (its .trc files are read as one trace set, e.g. the traces of parallel slaves). " +
		"Use absolute paths. Answers with the overview of the opened trace, as the overview tool does.",
	InputSchema: json.RawMessage(`{"type":"object","properties":{` +
		`"paths":{"type":"array","items":{"type":"string"},"minItems":1,"description":"absolute paths of trace files or directories"}` +
		`},"required":["paths"],"additionalProperties":false}`),
}

// Infos lists the tools of a Local server: open_trace and the analysis tools.
func (l *Local) Infos() []Info {
	out := []Info{openTraceTool}
	for _, in := range Infos() {
		if !localOnly[in.Name] {
			out = append(out, in)
		}
	}
	return out
}

// Call runs a tool. Its errors are the text the model sees.
func (l *Local) Call(ctx context.Context, name string, args json.RawMessage) (Result, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if name == openTraceTool.Name {
		var a struct {
			Paths []string `json:"paths"`
		}
		if err := decodeArgs(args, &a); err != nil {
			return Result{}, err
		}
		if len(a.Paths) == 0 {
			return Result{}, argErrorf("paths: give at least one trace file or directory")
		}
		if err := l.open(a.Paths); err != nil {
			return Result{}, err
		}
		return Call(ctx, l.cur.env, "overview", nil)
	}
	if localOnly[name] {
		return Result{}, argErrorf("%s needs the mtkprof desktop app; it is not available here", name)
	}
	if Lookup(name) == nil {
		return Result{}, argErrorf("unknown tool %q", name)
	}
	if l.cur == nil && l.pending != nil {
		paths := l.pending
		l.pending = nil
		if err := l.open(paths); err != nil {
			return Result{}, err
		}
	}
	if l.cur == nil {
		return Result{}, argErrorf("no trace is open: call open_trace with the trace file(s) first")
	}
	return Call(ctx, l.cur.env, name, args)
}

// open parses paths into the open trace. On an error the trace open before
// stays open.
func (l *Local) open(paths []string) error {
	abs := make([]string, len(paths))
	for i, p := range paths {
		if strings.HasPrefix(p, "~/") {
			if home, err := os.UserHomeDir(); err == nil {
				p = filepath.Join(home, p[2:])
			}
		}
		a, err := filepath.Abs(p)
		if err != nil {
			return argErrorf("%s: %v", p, err)
		}
		if _, err := os.Stat(a); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return argErrorf("%s: no such file or directory", a)
			}
			return argErrorf("%v", err)
		}
		abs[i] = a
	}
	if name, ok := model.AllOpt(abs); ok {
		return argErrorf("%s is a 10053 (optimizer) trace file; the assistant reads 10046 traces only in this version", name)
	}
	start := time.Now()
	m, err := model.BuildFiles(abs, model.Options{})
	if err != nil {
		return argErrorf("%v", err)
	}
	t := &localTrace{paths: abs}
	for _, fe := range m.File.Files {
		li, err := trace.OpenLineIndex(fe.Path)
		if err != nil {
			t.close()
			return fmt.Errorf("%s: %v", fe.Path, err)
		}
		t.lis = append(t.lis, li)
	}
	src := slice.MemSource(m)
	if !l.KeepBinds && l.redact == nil {
		l.redact = &Redactor{Salt: NewSalt(), ModelRaw: true}
	}
	t.env = Env{Model: m, Source: src, API: slice.NewServer(m, src).WithLines(t.lis).Handler()}
	if !l.KeepBinds {
		t.env.Redact = l.redact
	}
	l.cur.close()
	l.cur = t
	if l.Log != nil {
		fmt.Fprintf(l.Log, "mtkprof mcp: opened %s: %d file(s), %d lines in %s\n", strings.Join(abs, ", "), len(m.File.Files), m.Diag.Lines, time.Since(start).Round(time.Millisecond))
	}
	return nil
}
