package engine

import (
	"errors"
	"net/http"
	"os"
	"time"
)

// CacheItem is one entry of GET /engine/cache.
type CacheItem struct {
	Identity string    `json:"identity"` // a session's cacheIdentity
	Bytes    int64     `json:"bytes"`
	Created  time.Time `json:"created"`
	LastUsed time.Time `json:"lastUsed"`
	Paths    []string  `json:"paths"` // absolute source paths at build time
	Open     bool      `json:"open"`  // a session of this engine has it open
}

// CacheList is the answer of GET /engine/cache.
type CacheList struct {
	Bytes   int64       `json:"bytes"`
	Entries int         `json:"entries"`
	Cap     int64       `json:"cap"`
	Items   []CacheItem `json:"items"` // most recently used first
}

// CacheWipe is the answer of DELETE /engine/cache.
type CacheWipe struct {
	Removed []string `json:"removed"`
	Skipped []string `json:"skipped"` // open entries, kept
	Bytes   int64    `json:"bytes"`   // freed
}

func (s *Server) listCache(w http.ResponseWriter, r *http.Request) {
	out := CacheList{Cap: s.cache.Cap(), Items: []CacheItem{}}
	for _, e := range s.cache.Entries() {
		out.Bytes += e.Bytes
		out.Entries++
		paths := e.Sources
		if paths == nil {
			paths = []string{}
		}
		out.Items = append(out.Items, CacheItem{Identity: e.Identity, Bytes: e.Bytes, Created: e.Created,
			LastUsed: e.LastUsed, Paths: paths, Open: e.Open})
	}
	writeJSON(w, http.StatusOK, out)
}

// deleteCacheEntry serves DELETE /engine/cache/{identity}: 204, 404 for no
// such entry, 409 while a session has it open.
func (s *Server) deleteCacheEntry(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("identity")
	if !validIdentity(id) {
		writeError(w, errorf(CodeBadRequest, "identity: want 64 hex digits"))
		return
	}
	switch err := s.cache.Remove(id); {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, ErrCacheInUse):
		writeError(w, errorf(CodeConflict, "cache entry %s is open in a session", id))
	case errors.Is(err, os.ErrNotExist):
		writeError(w, errorf(CodeNotFound, "no cache entry %s", id))
	default:
		writeError(w, err)
	}
}

// wipeCache serves DELETE /engine/cache: removes every entry no session has
// open and lists what it removed and kept.
func (s *Server) wipeCache(w http.ResponseWriter, r *http.Request) {
	out := CacheWipe{Removed: []string{}, Skipped: []string{}}
	for _, e := range s.cache.Entries() {
		if err := s.cache.Remove(e.Identity); err != nil {
			if errors.Is(err, ErrCacheInUse) {
				out.Skipped = append(out.Skipped, e.Identity)
			}
			continue
		}
		out.Removed = append(out.Removed, e.Identity)
		out.Bytes += e.Bytes
	}
	writeJSON(w, http.StatusOK, out)
}
