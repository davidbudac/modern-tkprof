package model

import (
	"github.com/davidbudac/modern-tkprof/internal/deepcopy"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Live builds (internal/engine live sessions): a growing file is parsed by
// a Builder that never finishes; Snapshot returns, at a line boundary, the
// model a build of the input so far would have produced, while the builder
// goes on. When the file continues in another one (TRACE CONTINUES IN),
// ContinueLive moves the build on to it, as BuildFiles parses a chain; a
// file that continues earlier ones (TRACE CONTINUED FROM) is built from the
// earliest, complete ones first (MarkFollowed, ContinueLive(named, false)).

// NewLiveBuilder is the builder of a live build of the file at path: the one
// BuildFiles would use for a single file without a chain. opts must be an
// aggregate build (Options.Aggregate).
func NewLiveBuilder(path string, opts Options) *Builder {
	opts.NoFollow = true
	return NewBuilder(path, opts)
}

// ContinuesIn is the file the current file continues in: the name in its
// last "*** TRACE CONTINUES IN FILE x ***" marker so far, "" without one.
func (b *Builder) ContinuesIn() string {
	if c := b.m.File.Files[b.curFile].ContinuesIn; len(c) > 0 {
		return c[len(c)-1]
	}
	return ""
}

// ContinueLive switches a live build to the next file of its chain, after
// EndFile of the current one: cursors and calls carry over and the next
// record opens a context of the new file, as in BuildFiles; followed marks
// it as found by following the chain (not the file the user named). The
// first switch makes the build
// a multi-file one, where the header pid is Context.Process: the contexts
// of the files before get it too (BuildFiles knows it from the start).
func (b *Builder) ContinueLive(path string, followed bool) {
	if !b.multi {
		b.multi = true
		pid := func(c *Context) {
			if c.Process == "" {
				c.Process = leadingDigits(b.m.File.Files[c.FileIdx].ProcessPID)
			}
		}
		for i := range b.m.Contexts {
			pid(&b.m.Contexts[i])
		}
		pid(&b.ctx)
	}
	b.NextFile(path, true)
	b.m.File.Files[b.curFile].Followed = followed
}

// MarkFollowed marks the current file as found by following a chain: the
// first file of a live build that starts with the files the named one
// continues (TRACE CONTINUED FROM), as BuildFiles marks them.
func (b *Builder) MarkFollowed() { b.m.File.Files[b.curFile].Followed = true }

// Snapshot finishes a copy of the builder's state and returns its model, as
// if the input had ended after the lines delivered so far. Call it only
// while the parser is between lines (inside the Read of its input, see
// trace.Parser.Pending). file are the parser's statistics of the current
// file so far (Parser.Stats), total those of every file so far (file plus
// the files before, the same for a single file), and pending hands the
// parser's open records to the copy (Parser.Pending).
//
// The copy's first sink (Model.Agg, the analyze.Accumulator) is a deep copy
// of the builder's; the second one (Options.NewTee, the spill) is not copied:
// what the copy settles on finishing (the open XCTEND, the waits still
// looking for a call, the orphans) goes to tee instead, nil for nowhere. The
// copy's bind sets go nowhere (the next snapshot of the spill has them once
// the live builder settles them). The model returned shares nothing with the
// builder that the builder changes later.
func (b *Builder) Snapshot(file, total trace.Stats, pending func(trace.Handler), tee Sink) *Model {
	if !b.agg {
		panic("model: Snapshot of a build that is not Aggregate")
	}
	sink, bindSink := b.sink, b.bindSink
	b.sink, b.bindSink = b.m.Agg, nil
	c := deepcopy.Of(b)
	b.sink, b.bindSink = sink, bindSink
	if tee != nil {
		c.sink = teeSink{c.sink, tee}
	}
	if bindSink != nil {
		c.bindSink = nopBindSink{}
	}
	if pending != nil {
		pending(c)
	}
	c.EndFile(file)
	m := c.Finish(total)
	m.noteFollowed() // as BuildFiles does
	return m
}

type nopBindSink struct{}

func (nopBindSink) BindSet(*BindSet, []Bind) {}
