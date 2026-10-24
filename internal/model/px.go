package model

import "fmt"

// pxSlackUs widens a coordinator context's time window when matching slave
// contexts: the slave's last wait can be logged just after the coordinator
// call that waited for it completed.
const pxSlackUs = 500_000

type ctxExtent struct {
	from, to int64 // tim
	ok       bool
}

// contextExtents computes the tim range of the facts of every context.
func contextExtents(m *Model) []ctxExtent {
	out := make([]ctxExtent, len(m.Contexts))
	see := func(ctx ID, from, to int64) {
		if ctx < 0 || int(ctx) >= len(out) || to == 0 {
			return
		}
		e := &out[ctx]
		if !e.ok || from < e.from {
			e.from = from
		}
		if !e.ok || to > e.to {
			e.to = to
		}
		e.ok = true
	}
	copy(out, m.aggExt) // aggregate build: the facts are gone, the builder kept the extents
	for i := range m.Calls {
		c := &m.Calls[i]
		see(c.Context, c.Tim-c.E, c.Tim)
	}
	for i := range m.Waits {
		w := &m.Waits[i]
		see(w.Context, w.Tim-w.Ela, w.Tim)
	}
	for i := range m.Errors {
		see(m.Errors[i].Context, m.Errors[i].Tim, m.Errors[i].Tim)
	}
	return out
}

// attachPX links every context of a PX slave trace to its query coordinator
// context (Context.Parent). A candidate is a non-slave context of another
// file whose time window (widened by pxSlackUs) overlaps the slave context's,
// and whose client id and module do not contradict the slave's (the slave
// inherits the coordinator's client id, module and action; empty values are
// neutral). Among the candidates the best match wins by: equal action, equal
// client id, equal module, then the length of the time overlap.
func attachPX(m *Model) {
	ext := contextExtents(m)
	for i := range m.Contexts {
		s := &m.Contexts[i]
		if !s.PX || !ext[i].ok {
			continue
		}
		type score struct{ action, client, module, overlap int64 }
		best, bestScore := None, score{-1, -1, -1, -1}
		for j := range m.Contexts {
			q := &m.Contexts[j]
			if q.PX || q.FileIdx == s.FileIdx || !ext[j].ok {
				continue
			}
			if s.ClientID != "" && q.ClientID != "" && s.ClientID != q.ClientID {
				continue
			}
			if s.Module != "" && q.Module != "" && s.Module != q.Module {
				continue
			}
			lo, hi := max(ext[i].from, ext[j].from-pxSlackUs), min(ext[i].to, ext[j].to+pxSlackUs)
			if hi < lo {
				continue
			}
			eq := func(a, b string) int64 {
				if a != "" && a == b {
					return 1
				}
				return 0
			}
			sc := score{eq(s.Action, q.Action), eq(s.ClientID, q.ClientID), eq(s.Module, q.Module), hi - lo}
			if sc.action > bestScore.action ||
				sc.action == bestScore.action && (sc.client > bestScore.client ||
					sc.client == bestScore.client && (sc.module > bestScore.module ||
						sc.module == bestScore.module && sc.overlap > bestScore.overlap)) {
				best, bestScore = ID(j), sc
			}
		}
		if best == None {
			continue
		}
		s.Parent = best
		m.Diag.Notes = append(m.Diag.Notes, fmt.Sprintf("PX slave %s (context %d, session %s) -> coordinator context %d (%s)",
			m.File.Files[s.FileIdx].Name, i, s.SessionID, best, m.File.Files[m.Contexts[best].FileIdx].Name))
	}
}
