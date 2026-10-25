package analyze

import (
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// Response is the response time of a scope (DB-time-like): the sum over its
// sessions of each session's span, plus the wall-clock span for reference.
//
// A session is one server process of the set: the contexts of one file chain
// with the same Context.Process (a single file without trcsess markers is one
// session; a trcsess file has one per pid). A process runs one thing at a
// time, so its contexts never overlap and their spans add up. A session's
// span runs from the start of its first call to the end of its last call or
// wait (ContextStats.FirstTim .. LastTim, between-call idle included), each
// context clipped to the tim range of its file (contextSpan), the whole
// clipped to the window: a single-session trace's response time is its span,
// and the files of a chain do not overlap. PX slave contexts attached to a coordinator
// whose context is in scope are left out (their work is the coordinator's,
// see PX); a slave without its coordinator in scope counts as a session.
// With a context subset, each run of consecutive selected contexts of a
// session counts from its first to its last row (a gap of unselected
// contexts is not the scope's time).
type Response struct {
	ResponseUs int64 `json:"responseUs"` // Σ session spans
	WallUs     int64 `json:"wallUs"`     // the window, else the span of the files of the contexts, else the trace span
	Sessions   int   `json:"sessions"`   // sessions with time in scope
}

// SessionsOf maps every context to its session index (0..n-1), in context
// order of first appearance.
func SessionsOf(m *model.Model) (of []int32, n int) {
	type key struct {
		chain   int
		process string
	}
	idx := map[key]int32{}
	of = make([]int32, len(m.Contexts))
	for i := range m.Contexts {
		c := &m.Contexts[i]
		k := key{chain: -1 - c.FileIdx, process: c.Process}
		if c.FileIdx >= 0 && c.FileIdx < len(m.File.Files) {
			k.chain = m.File.Files[c.FileIdx].Chain
		}
		s, ok := idx[k]
		if !ok {
			s = int32(len(idx))
			idx[k] = s
		}
		of[i] = s
	}
	return of, len(idx)
}

// ResponseOf is the Response of the scope of f (window and contexts; the
// other fields are row filters and do not change it). cs is Contexts(m).
func ResponseOf(m *model.Model, cs []ContextStats, f Filter) Response {
	r := Response{WallUs: scopeSpan(m, f)}
	if f.NoContexts {
		return r
	}
	var sel map[model.ID]bool
	if len(f.Contexts) > 0 {
		sel = make(map[model.ID]bool, len(f.Contexts))
		for _, id := range f.Contexts {
			sel[id] = true
		}
	}
	in := func(id model.ID) bool { return sel == nil || sel[id] }
	lo, hi := m.Span.FirstTim, m.Span.LastTim
	if f.StartTim != 0 && f.StartTim > lo {
		lo = f.StartTim
	}
	if f.EndTim != 0 && f.EndTim < hi {
		hi = f.EndTim
	}
	of, n := SessionsOf(m)
	type run struct {
		open     bool
		from, to int64
		us       int64
	}
	runs := make([]run, n)
	end := func(s *run) {
		if s.open {
			s.us += max(min(s.to, hi)-max(s.from, lo), 0)
			s.open = false
		}
	}
	for i := range m.Contexts {
		if i >= len(cs) {
			break
		}
		from, to, ok := contextSpan(m, cs, i)
		if !ok {
			continue // no timed row: neither part of a run nor a gap
		}
		s := &runs[of[i]]
		id := model.ID(i)
		if !in(id) || (m.PXChild(id) && in(m.Contexts[i].Parent)) {
			end(s)
			continue
		}
		if !s.open {
			s.open, s.from, s.to = true, from, to
			continue
		}
		s.from = min(s.from, from)
		s.to = max(s.to, to)
	}
	for i := range runs {
		end(&runs[i])
		if runs[i].us > 0 {
			r.ResponseUs += runs[i].us
			r.Sessions++
		}
	}
	return r
}

// contextSpan is the time of context i: from the start of its first call to
// the end of its last call or wait (ContextStats), clipped to the tim range
// of its file (a call that started before the file, in the previous part of
// a chain or before tracing was on, counts from the file's first line).
func contextSpan(m *model.Model, cs []ContextStats, i int) (from, to int64, ok bool) {
	c := &cs[i]
	if c.FirstTim == 0 && c.LastTim == 0 {
		return 0, 0, false
	}
	lo, hi := m.Span.FirstTim, m.Span.LastTim
	if fi := m.Contexts[i].FileIdx; fi >= 0 && fi < len(m.File.Files) {
		if f := &m.File.Files[fi]; f.FirstTim > 0 && f.LastTim >= f.FirstTim {
			lo, hi = f.FirstTim, f.LastTim
		}
	}
	from, to = max(c.FirstTim, lo), min(c.LastTim, hi)
	return from, max(from, to), true
}

// PXOut reports, for the scope of f, whether a context is an attached PX
// slave whose coordinator is in scope: its rows are the coordinator's work,
// outside the response time and the scope's ledger (ProfileOfOn).
func PXOut(m *model.Model, f Filter) func(model.ID) bool {
	mt := f.Matcher()
	in := func(id model.ID) bool { return mt.ctxs == nil || mt.ctxs[id] }
	return func(id model.ID) bool { return m.PXChild(id) && in(m.Contexts[id].Parent) }
}

// TraceResponse is the Response of the whole set.
func TraceResponse(m *model.Model) Response {
	return ResponseOf(m, Contexts(m), Filter{})
}
