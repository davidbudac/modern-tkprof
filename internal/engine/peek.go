package engine

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/peek"
)

// The folder picker (DESIGN § Opening a folder): list the trace files of
// folders, then peek at each one without opening it. The routes are
// appended to the route table at init, as the connections' are.
func init() {
	for _, r := range []struct {
		pattern string
		handler func(*Server, http.ResponseWriter, *http.Request)
	}{
		{"POST /engine/files", (*Server).listFiles},
		{"POST /engine/peek", (*Server).peekFiles},
	} {
		routes = append(routes, struct {
			pattern string
			handler func(*Server, http.ResponseWriter, *http.Request)
		}{r.pattern, r.handler})
	}
}

// maxListed bounds the files of one POST /engine/files.
const maxListed = 100_000

// ListedFile is a file of POST /engine/files.
type ListedFile struct {
	Path     string    `json:"path"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
	// the requested folder it is in; empty for a file requested by itself
	Dir string `json:"dir,omitempty"`
}

// FileList is the answer of POST /engine/files.
type FileList struct {
	Files []ListedFile `json:"files"`
	// the requested paths that are folders (also those without trace files)
	Dirs []string `json:"dirs"`
}

// listFiles serves POST /engine/files: the requested files and the *.trc
// files directly inside the requested folders (by name), as an open of
// those paths would read them, with size and time.
func (s *Server) listFiles(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		writeError(w, err)
		return
	}
	if len(body.Paths) == 0 || len(body.Paths) > maxPaths {
		writeError(w, errorf(CodeBadRequest, "paths: want 1 to %d paths", maxPaths))
		return
	}
	out := FileList{Files: []ListedFile{}, Dirs: []string{}}
	seen := map[string]bool{}
	add := func(path string, fi os.FileInfo, dir string) {
		if !seen[path] && len(out.Files) < maxListed {
			seen[path] = true
			out.Files = append(out.Files, ListedFile{Path: path, Size: fi.Size(), Modified: fi.ModTime(), Dir: dir})
		}
	}
	for _, p := range body.Paths {
		abs, err := filepath.Abs(p)
		var fi os.FileInfo
		if err == nil {
			fi, err = os.Stat(abs)
		}
		if err != nil {
			writeError(w, errorf(CodeBadRequest, "paths: %v", err))
			return
		}
		if !fi.IsDir() {
			add(abs, fi, "")
			continue
		}
		ents, err := os.ReadDir(abs)
		if err != nil {
			writeError(w, errorf(CodeBadRequest, "paths: %v", err))
			return
		}
		out.Dirs = append(out.Dirs, abs)
		sort.Slice(ents, func(i, j int) bool { return ents[i].Name() < ents[j].Name() })
		for _, e := range ents {
			if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".trc") {
				continue
			}
			path := filepath.Join(abs, e.Name())
			if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
				add(path, fi, abs)
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// peekFiles serves POST /engine/peek: a summary of each file (peek.File),
// read in one pass without opening a session. A file that cannot be read
// has its error in the summary. Summaries are kept per path, size and time.
func (s *Server) peekFiles(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		writeError(w, err)
		return
	}
	if len(body.Paths) == 0 || len(body.Paths) > maxPaths {
		writeError(w, errorf(CodeBadRequest, "paths: want 1 to %d paths", maxPaths))
		return
	}
	out := struct {
		Files []peek.Summary `json:"files"`
	}{Files: make([]peek.Summary, 0, len(body.Paths))}
	for _, p := range body.Paths {
		if err := r.Context().Err(); err != nil {
			return
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			out.Files = append(out.Files, peek.Summary{Path: p, Sessions: []peek.Session{}, Error: err.Error()})
			continue
		}
		out.Files = append(out.Files, s.peeks.get(r, abs))
	}
	writeJSON(w, http.StatusOK, out)
}

// peekCache keeps the summaries of the files peeked at, by path, size and
// modification time (a file that changed is read again).
type peekCache struct {
	mu sync.Mutex
	m  map[string]peek.Summary
}

const peekCacheMax = 5000

func (c *peekCache) get(r *http.Request, path string) peek.Summary {
	fi, err := os.Stat(path)
	if err != nil {
		return peek.Summary{Path: path, Sessions: []peek.Session{}, Error: err.Error()}
	}
	key := path + "\x00" + fi.ModTime().UTC().Format(time.RFC3339Nano) + "\x00" + strconv.FormatInt(fi.Size(), 10)
	c.mu.Lock()
	sum, ok := c.m[key]
	c.mu.Unlock()
	if ok {
		return sum
	}
	sum, err = peek.File(r.Context(), path)
	if err != nil {
		sum.Error = err.Error()
		return sum
	}
	c.mu.Lock()
	if c.m == nil || len(c.m) >= peekCacheMax {
		c.m = map[string]peek.Summary{}
	}
	c.m[key] = sum
	c.mu.Unlock()
	return sum
}
