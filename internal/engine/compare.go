package engine

import (
	"net/http"

	"github.com/davidbudac/modern-tkprof/internal/report"
)

// compareSessions returns a detached aggregate snapshot. Source sessions are
// pinned for the entire serialization; closing either waits for this request.
func (s *Server) compareSessions(w http.ResponseWriter, r *http.Request) {
	a, b := r.URL.Query().Get("a"), r.URL.Query().Get("b")
	if a == "" || b == "" || a == b {
		writeError(w, errorf(CodeBadRequest, "a and b must identify two different ready, non-live sessions"))
		return
	}
	s.mu.Lock()
	sa, sb := s.sessions[a], s.sessions[b]
	if sa == nil || sb == nil {
		s.mu.Unlock()
		writeError(w, errorf(CodeNotFound, "comparison source session not found"))
		return
	}
	sa.begin()
	sb.begin()
	s.mu.Unlock()
	defer sa.end()
	defer sb.end()
	sa.use.RLock()
	defer sa.use.RUnlock()
	sb.use.RLock()
	defer sb.use.RUnlock()
	if sa.Info().State != SessionReady || sb.Info().State != SessionReady || sa.op == nil || sb.op == nil || sa.op.co == nil || sb.op.co == nil {
		writeError(w, errorf(CodeConflict, "comparison requires two ready, non-live sessions"))
		return
	}
	for _, o := range []*Session{sa, sb} {
		if err := optRefusal(o.op.co.Model, "it cannot be compared in this version"); err != nil {
			writeError(w, err)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := report.CompareJSON(w, sa.op.co.Model, sb.op.co.Model, report.DocOptions{Facts: false, PlanVizURL: s.opts.PlanVizURL}); err != nil {
		s.logf("error", "comparison: %v", err)
	}
}
