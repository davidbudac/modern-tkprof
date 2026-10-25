package engine

import (
	"net/http"
	"path/filepath"

	"github.com/davidbudac/modern-tkprof/internal/remote"
)

// A live session without the control plane: `mtkprof follow -serve`
// (cmd/mtkprof/fetch.go) runs an engine in-process, starts the follow with
// FollowRemote and serves SessionHandler on a listener of its own, so its
// routes and answers are the engine's per-session ones.

// FollowRemote starts a live session over the local mirror of the remote
// file p read through cl: a follow job appends what the host writes to
// local (resuming a shorter copy), the files a TRACE CONTINUES IN chain goes
// on in are mirrored next to local under their remote names. o as for
// POST /engine/sessions with follow. It returns the session's id.
func (s *Server) FollowRemote(cl remote.SSH, p, local string, o SessionOptions) (string, error) {
	abs, err := filepath.Abs(local)
	if err != nil {
		return "", err
	}
	spec, err := liveSpecOf([]string{abs}, o)
	if err != nil {
		return "", err
	}
	_, ss, err := s.startRemoteFollow("", cl, p, abs, &spec, func(rp string) (string, error) {
		base, err := remoteBase(rp)
		if err != nil {
			return "", err
		}
		return filepath.Join(filepath.Dir(abs), base), nil
	})
	if err != nil {
		return "", err
	}
	return ss.id, nil
}

// SessionHandler serves the routes of session id at the root (GET /api/doc,
// /api/pivot, /api/lines, ...: what the engine serves under /s/{id}/)
// without the token check; 409 until the session has a snapshot.
func (s *Server) SessionHandler(id string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.serveSession(w, r, id, "") })
}

// SessionInfo is the session with id, false when there is none.
func (s *Server) SessionInfo(id string) (SessionInfo, bool) {
	s.mu.Lock()
	ss := s.sessions[id]
	s.mu.Unlock()
	if ss == nil {
		return SessionInfo{}, false
	}
	return ss.Info(), true
}
