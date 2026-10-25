package model

import (
	"github.com/davidbudac/modern-tkprof/internal/deepcopy"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Live builds (internal/engine live sessions): one growing file is parsed by
// a Builder that never finishes; Snapshot returns, at a line boundary, the
// model a build of the input so far would have produced, while the builder
// goes on.

// NewLiveBuilder is the builder of a live build of the file at path: the one
// BuildFiles would use for a single file without a chain (a growing file is
// followed alone). opts must be an aggregate build (Options.Aggregate).
func NewLiveBuilder(path string, opts Options) *Builder {
	opts.NoFollow = true
	return NewBuilder(path, opts)
}

// Snapshot finishes a copy of the builder's state and returns its model, as
// if the input had ended after the lines delivered so far. Call it only
// while the parser is between lines (inside the Read of its input, see
// trace.Parser.Pending). st are the parser's statistics so far (Parser.Stats)
// and pending hands the parser's open records to the copy (Parser.Pending).
//
// The copy's first sink (Model.Agg, the analyze.Accumulator) is a deep copy
// of the builder's; the second one (Options.NewTee, the spill) is not copied:
// what the copy settles on finishing (the open XCTEND, the waits still
// looking for a call, the orphans) goes to tee instead, nil for nowhere. The
// copy's bind sets go nowhere (the next snapshot of the spill has them once
// the live builder settles them). The model returned shares nothing with the
// builder that the builder changes later.
func (b *Builder) Snapshot(st trace.Stats, pending func(trace.Handler), tee Sink) *Model {
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
	c.EndFile(st)
	return c.Finish(st)
}

type nopBindSink struct{}

func (nopBindSink) BindSet(*BindSet, []Bind) {}
