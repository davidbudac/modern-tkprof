package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
	"github.com/davidbudac/modern-tkprof/internal/slice"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Live sessions (docs/ARCHITECTURE.md § Engine mode, "Live sessions"): a
// growing trace file is parsed as it is written, by the streaming parser fed
// from a reader that waits at the end of the file instead of ending, into an
// aggregate build that spills into a temporary directory (<cache>/live/, not
// the index cache: a growing file has no identity). At every settled batch
// the reader, called by the parser between two lines, takes a snapshot: a
// deep copy of the builder and its accumulator is finished as if the input
// ended there (model.(*Builder).Snapshot), the rows that finish settles go
// to the spill at their ids (slice.LiveOverlay), and the session's handlers
// switch to the new model, source and document; rev increments and a
// session event {state: "live", rev} goes out. Requests in flight finish on
// the snapshot they started with.
//
// POST /engine/sessions {paths:[file], options:{follow:true}} follows a
// local file; POST /engine/connections/{id}/follow does it over the local
// mirror of a remote file (connections.go). DELETE /engine/sessions/{id}
// stops the follow and removes the spill.
//
// A file that ends with "*** TRACE CONTINUES IN FILE x ***" is followed
// into x once x exists (next to the file; for a remote follow a new mirror
// of x on the same connection, the old one is stopped): the parser of the
// file ends, the builder continues in the next file as BuildFiles parses a
// chain (model.(*Builder).ContinueLive), and the snapshots list both files.

// Batch limits.
const (
	liveBatchDefault = time.Second
	liveBatchMin     = 50 * time.Millisecond
	liveBatchMax     = time.Minute
	liveCostFactor   = 3 // the next snapshot waits at least this many times the last one's cost
	livePollMax      = 100 * time.Millisecond
	liveDocWait      = 25 * time.Second       // longest wait of GET api/doc?rev=
	liveProbe        = 250 * time.Millisecond // looking for the next file of a chain at most this often
)

// liveSpec is what a live session is started with.
type liveSpec struct {
	paths []string // one file, absolute
	opts  SessionOptions
	mode  model.BindMode
	th    *analyze.Thresholds

	// mirror is the job that writes the file (a remote follow), nil for a
	// local file; started is closed once it has opened (and when needed
	// truncated) the file. The session ends when the job ends and cancels
	// it when the session ends.
	mirror  *Job
	started <-chan struct{}

	// remote is the path of the mirrored file on the host, and follow
	// starts the mirror of the next file of a chain (remote follow only).
	remote string
	follow func(remotePath string) (nextMirror, error)
}

// nextMirror is the mirror of the next file of a chain.
type nextMirror struct {
	remote, local string
	job           *Job
	started       <-chan struct{}
}

// liveFile is one file of the followed chain.
type liveFile struct {
	path string
	rf   *os.File       // read by the line views of every snapshot
	scan trace.LineScan // the line index, fed as the parser reads
	st   trace.Stats    // the parser's statistics once the file is done
}

// live is the follow of one growing file.
type live struct {
	srv  *Server
	ss   *Session
	spec liveSpec
	path string

	batch      time.Duration
	batchBytes int64
	poll       time.Duration

	// parser goroutine only
	spill    *slice.Spill
	files    []*liveFile // the chain so far; the last one is being read
	done     trace.Stats // of the files before the last
	f        *os.File    // the last file, read by the parser
	read     int64       // bytes read from f
	b        *model.Builder
	p        *trace.Parser
	lastSnap time.Time
	lastCost time.Duration
	snapped  int64 // parser bytes (all files) at the last snapshot
	rev      int
	upErr    error     // the mirror ended (after the bytes it wrote are read)
	nextPath string    // the next file of the chain, once it is there: the parser ends at the end of f
	draining bool      // the old mirror has stopped: read what it wrote, then end
	tried    string    // the last continuation not found (logged once)
	probed   time.Time // when the next local file was last looked for

	// the mirror writing f and the one of the next file (a remote follow)
	mirror  *Job
	pending *nextMirror
	remote  string

	costs atomic.Pointer[[]time.Duration] // the last snapshots' costs (tests, logs)

	stopped chan struct{}

	cur  atomic.Pointer[liveSnap]
	mu   sync.Mutex
	next chan struct{} // closed at the next snapshot

	closeOnce sync.Once
}

// liveSnap is one snapshot: what the session serves until the next.
type liveSnap struct {
	rev     int
	doc     []byte
	handler http.Handler
}

// liveSpecOf checks the options of a live session over paths.
func liveSpecOf(paths []string, o SessionOptions) (liveSpec, error) {
	spec := liveSpec{paths: paths, opts: o}
	var err error
	if spec.mode, err = parseBinds(o.Binds, o.Salt); err != nil {
		return spec, errorf(CodeBadRequest, "%v", err)
	}
	if t := strings.TrimSpace(string(o.Thresholds)); t != "" && t != "null" {
		v, err := analyze.ParseThresholds(o.Thresholds)
		if err != nil {
			return spec, errorf(CodeBadRequest, "thresholds: %v", err)
		}
		spec.th = &v
	}
	if _, err := liveBatch(o); err != nil {
		return spec, err
	}
	return spec, nil
}

// liveBatch is the batch period of the options.
func liveBatch(o SessionOptions) (time.Duration, error) {
	batch := liveBatchDefault
	if ms := o.BatchMs; ms != 0 {
		batch = time.Duration(ms) * time.Millisecond
		if batch < liveBatchMin || batch > liveBatchMax {
			return 0, errorf(CodeBadRequest, "batchMs: want %d to %d", liveBatchMin.Milliseconds(), liveBatchMax.Milliseconds())
		}
	}
	if o.BatchMB < 0 {
		return 0, errorf(CodeBadRequest, "batchMB: want 0 or more")
	}
	return batch, nil
}

// startLive registers a live session and starts its goroutine.
func (s *Server) startLive(spec liveSpec) (*Session, error) {
	if len(spec.paths) != 1 {
		return nil, errorf(CodeBadRequest, "follow: want one file")
	}
	path := spec.paths[0]
	if spec.mirror == nil {
		fi, err := os.Stat(path)
		if err != nil {
			return nil, errorf(CodeBadRequest, "paths: %v", err)
		}
		if !fi.Mode().IsRegular() {
			return nil, errorf(CodeBadRequest, "follow: %s is not a file", path)
		}
	}
	batch, err := liveBatch(spec.opts)
	if err != nil {
		return nil, err
	}
	lv := &live{srv: s, spec: spec, path: path, batch: batch, batchBytes: int64(spec.opts.BatchMB) << 20,
		poll: min(livePollMax, max(batch/4, 10*time.Millisecond)), stopped: make(chan struct{}), next: make(chan struct{}),
		mirror: spec.mirror, remote: spec.remote}
	ss := &Session{id: newID("s"), paths: spec.paths, inputs: spec.paths, opened: time.Now(), bindMode: spec.mode,
		salt: spec.opts.Salt, th: spec.th, done: make(chan struct{}), state: SessionOpening, files: fileInfos(spec.paths)}
	lv.ss = ss
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errorf(CodeConflict, "the engine is shutting down")
	}
	ss.job = s.newJobLocked("live", ss.id)
	ss.job.info.Phase, ss.job.info.Unit = "follow", "bytes"
	if spec.mirror != nil {
		ss.job.info.Connection = spec.mirror.Info().Connection
	}
	s.sessions[ss.id] = ss
	s.wg.Add(1)
	s.mu.Unlock()
	ss.job.publish()
	go s.runLive(lv)
	s.bc.publish("session", ss.event())
	return ss, nil
}

// runLive is the live job: follow until DELETE (cancelled), the end of the
// engine, or an error (the session fails, its last snapshot stays served).
func (s *Server) runLive(lv *live) {
	ss, job := lv.ss, lv.ss.job
	defer s.wg.Done()
	defer close(ss.done)
	defer close(lv.stopped)
	err := lv.run(job.Context())
	for _, m := range []*Job{lv.mirror, lv.pendingJob()} {
		if m != nil {
			m.cancel()
		}
	}
	ss.use.RLock()
	served := ss.op != nil
	ss.use.RUnlock()
	if !served {
		lv.close() // nothing was published: the session owns no files
	}
	if job.Context().Err() != nil {
		err = errCancelled
	}
	if err != errCancelled {
		ss.mu.Lock()
		ss.state, ss.err = SessionFailed, err.Error()
		ss.mu.Unlock()
		s.bc.publish("session", ss.event())
		s.logf("error", "session %s: follow of %s stopped: %v", ss.id, filepath.Base(lv.path), err)
	}
	job.finish(err)
}

func (lv *live) pendingJob() *Job {
	if lv.pending != nil {
		return lv.pending.job
	}
	return nil
}

// run parses the file as it grows, and the files it continues in; it
// returns when ctx ends or on an error.
func (lv *live) run(ctx context.Context) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("internal error while reading the trace: %v\n%s", r, debug.Stack())
		}
	}()
	if lv.spec.started != nil {
		select {
		case <-lv.spec.started:
		case <-lv.spec.mirror.Context().Done():
			return lv.mirrorErr(lv.spec.mirror)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := lv.openFile(lv.path); err != nil {
		return err
	}
	ss := lv.ss
	sp, err := slice.NewSpill(slice.SpillOptions{Dir: lv.srv.liveDir(), Key: "live", BindMode: ss.bindMode, Salt: ss.salt, Live: true})
	if err != nil {
		return err
	}
	lv.spill = sp
	th := analyze.DefaultThresholds()
	if ss.th != nil {
		th = *ss.th
	}
	lv.b = model.NewLiveBuilder(lv.path, model.Options{NoFacts: true, Aggregate: true, SpillBinds: ss.bindMode != model.BindsNone,
		NewSink: func(m *model.Model) model.Sink { return analyze.NewAccumulator(m, th) },
		NewTee:  sp.Attach})
	lv.lastSnap = time.Now()
	for {
		lv.p = trace.New(lv.b)
		st, err := lv.p.Run(tailReader{lv, ctx})
		if err != nil {
			return err
		}
		if lv.nextPath == "" { // tailReader ends only at a switch
			return fmt.Errorf("internal error: the parser of %s ended", lv.last().path)
		}
		if err := lv.switchFile(st); err != nil {
			return err
		}
	}
}

// last is the file being read.
func (lv *live) last() *liveFile { return lv.files[len(lv.files)-1] }

// openFile adds path to the chain and makes it the file the parser reads.
func (lv *live) openFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	rf, err := os.Open(path)
	if err != nil {
		f.Close()
		return err
	}
	if lv.f != nil {
		lv.f.Close()
	}
	lv.f, lv.read = f, 0
	lv.files = append(lv.files, &liveFile{path: path, rf: rf})
	return nil
}

// switchFile moves the build on to the next file of the chain once the
// parser of the current one has ended (with its statistics st).
func (lv *live) switchFile(st trace.Stats) error {
	prev := lv.last()
	lv.b.EndFile(st)
	prev.st = st
	lv.done.Add(st)
	next := lv.nextPath
	lv.nextPath = ""
	if err := lv.openFile(next); err != nil {
		return err
	}
	lv.b.ContinueLive(next)
	if nm := lv.pending; nm != nil {
		lv.mirror, lv.remote, lv.pending = nm.job, nm.remote, nil
	}
	ss := lv.ss
	ss.mu.Lock()
	ss.files = append(ss.files, FileInfo{Path: next, Name: filepath.Base(next)})
	ss.mu.Unlock()
	lv.srv.logf("info", "session %s: %s continues in %s; following it", ss.id, filepath.Base(prev.path), filepath.Base(next))
	lv.srv.bc.publish("session", ss.event())
	return nil
}

// mirrorErr is why the mirror job m ended.
func (lv *live) mirrorErr(m *Job) error {
	info := m.Info()
	msg := info.Message
	if info.State == JobRunning || msg == "" {
		msg = "cancelled"
	}
	return fmt.Errorf("the follow job %s ended: %s", info.ID, msg)
}

// liveDir is where live sessions spill: <cache>/live.
func (s *Server) liveDir() string { return filepath.Join(filepath.Dir(s.cache.Dir()), "live") }

// tailReader is the parser's input: the file, waiting at its end for more.
// The parser calls Read only when it has no complete line left, so this is
// where snapshots are taken. It ends (io.EOF) only when the file continues
// in another one that is there and everything of this one is read.
type tailReader struct {
	lv  *live
	ctx context.Context
}

func (t tailReader) Read(buf []byte) (int, error) {
	lv := t.lv
	for {
		if err := t.ctx.Err(); err != nil {
			return 0, err
		}
		if err := lv.maybeSnapshot(false); err != nil {
			return 0, err
		}
		n, err := lv.f.Read(buf)
		if n > 0 {
			lv.last().scan.Feed(buf[:n])
			lv.read += int64(n)
			return n, nil
		}
		if err != nil && err != io.EOF {
			return 0, err
		}
		// at the end of what is written
		if lv.draining { // the old mirror has stopped and all it wrote is read
			lv.draining = false
			return 0, io.EOF
		}
		if lv.upErr != nil { // the mirror ended and everything it wrote is read: a last snapshot
			if _, total := lv.stats(); total.Lines > 0 && total.Bytes > lv.snapped {
				if err := lv.snapshot(); err != nil {
					return 0, err
				}
			}
			return 0, lv.upErr
		}
		if m := lv.mirror; m != nil && m.Context().Err() != nil {
			lv.upErr = lv.mirrorErr(m)
			continue // read once more: the last write may have come just before the end
		}
		if fi, err := lv.f.Stat(); err == nil && fi.Size() < lv.read {
			return 0, fmt.Errorf("%s shrank from %d to %d bytes (truncated or replaced)", lv.last().path, lv.read, fi.Size())
		}
		switch ok, err := lv.nextReady(t.ctx); {
		case err != nil:
			return 0, err
		case ok && lv.mirror == nil:
			return 0, io.EOF
		case ok:
			lv.draining = true
			continue
		}
		if err := lv.maybeSnapshot(true); err != nil {
			return 0, err
		}
		select {
		case <-t.ctx.Done():
			return 0, t.ctx.Err()
		case <-time.After(lv.poll):
		}
	}
}

// nextReady reports whether the current file continues in another one that
// is there (lv.nextPath is set then). For a remote follow it starts the
// mirror of the next file and, once that one has opened its local file,
// stops the current mirror (true then: what the old one wrote last is still
// to be read).
func (lv *live) nextReady(ctx context.Context) (bool, error) {
	ref := lv.b.ContinuesIn()
	if ref == "" {
		return false, nil
	}
	if lv.spec.follow == nil {
		if time.Since(lv.probed) < liveProbe {
			return false, nil
		}
		lv.probed = time.Now()
		p := model.FindContinuation(ref, lv.last().path, lv.inChain)
		if p == "" {
			if lv.tried != ref {
				lv.tried = ref
				lv.srv.logf("info", "session %s: %s continues in %s; waiting for it", lv.ss.id, filepath.Base(lv.last().path), ref)
			}
			return false, nil
		}
		lv.nextPath = p
		return true, nil
	}
	if lv.pending == nil {
		rp := path.Join(path.Dir(lv.remote), path.Base(strings.ReplaceAll(ref, `\`, "/")))
		if rp == lv.remote {
			return false, nil
		}
		nm, err := lv.spec.follow(rp)
		if err != nil {
			return false, fmt.Errorf("follow %s: %w", rp, err)
		}
		lv.pending = &nm
		lv.srv.logf("info", "session %s: %s continues in %s; following it", lv.ss.id, path.Base(lv.remote), rp)
	}
	nm := lv.pending
	select {
	case <-nm.started:
	case <-nm.job.Context().Done():
		return false, lv.mirrorErr(nm.job)
	default:
		return false, nil
	}
	old := lv.mirror
	old.cancel()
	for old.running() { // its last write is in the file once it has finished
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	lv.nextPath = nm.local
	return true, nil
}

// inChain reports whether p is a file of the chain already.
func (lv *live) inChain(p string) bool {
	for _, f := range lv.files {
		if sameFile(f.path, p) {
			return true
		}
	}
	return false
}

func sameFile(a, b string) bool {
	if a == b {
		return true
	}
	fa, err1 := os.Stat(a)
	fb, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(fa, fb)
}

// stats are the parser's statistics of the current file and of all files.
func (lv *live) stats() (file, total trace.Stats) {
	file = lv.p.Stats()
	total = lv.done
	total.Add(file)
	return file, total
}

// maybeSnapshot takes a snapshot when the batch is due: new lines since the
// last one, and the batch period (at least liveCostFactor times the cost of
// the last snapshot) has passed, or BatchMB of input. The first snapshot is
// taken as soon as the reader has caught up with the file.
func (lv *live) maybeSnapshot(caughtUp bool) error {
	_, st := lv.stats()
	if st.Bytes == lv.snapped || st.Lines == 0 {
		return nil
	}
	since := time.Since(lv.lastSnap)
	minGap := liveCostFactor * lv.lastCost
	due := since >= max(lv.batch, minGap) ||
		(lv.batchBytes > 0 && st.Bytes-lv.snapped >= lv.batchBytes && since >= minGap) ||
		(lv.rev == 0 && caughtUp)
	if !due {
		return nil
	}
	return lv.snapshot()
}

// snapshot publishes the model of the lines parsed so far.
func (lv *live) snapshot() error {
	start := time.Now()
	ss := lv.ss
	file, st := lv.stats()
	ov := lv.spill.Overlay()
	m := lv.b.Snapshot(file, st, lv.p.Pending, ov)
	src, err := ov.Source(m)
	if err != nil {
		return fmt.Errorf("spill: %w", err)
	}
	model.RedactBindsSalt(m, ss.bindMode, ss.salt)
	doc, err := report.DocumentBytes(m, report.DocOptions{Facts: false, Packed: true, Slice: true, Thresholds: ss.th})
	if err != nil {
		return err
	}
	lis := make([]*trace.LineIndex, len(lv.files))
	for i, f := range lv.files {
		fs := f.st
		if i == len(lv.files)-1 {
			fs = file
		}
		lis[i] = f.scan.View(f.rf, fs.Lines, fs.Bytes)
	}
	co := &CacheOpened{Model: m, Source: src, Lines: lis}
	lv.rev++
	snap := &liveSnap{rev: lv.rev, doc: doc, handler: lv.srv.sessionMux(ss, co, doc)}
	lv.cur.Store(snap)
	lv.mu.Lock()
	close(lv.next)
	lv.next = make(chan struct{})
	lv.mu.Unlock()
	if lv.rev == 1 {
		ss.use.Lock()
		ss.op = &opened{co: co, handler: lv, release: lv.close}
		ss.use.Unlock()
	}
	files := make([]FileInfo, len(m.File.Files))
	for i, fe := range m.File.Files {
		files[i] = FileInfo{Path: fe.Path, Name: fe.Name, Size: fe.Size}
	}
	ss.mu.Lock()
	ss.state, ss.rev, ss.bytes, ss.lines = SessionLive, lv.rev, st.Bytes, int64(st.Lines)
	ss.files = files
	ss.mu.Unlock()
	ss.job.Progress(st.Bytes, int64(st.Lines), int64(len(m.Statements)))
	lv.srv.bc.publish("session", ss.event())
	lv.snapped = st.Bytes
	lv.lastSnap = start
	lv.lastCost = time.Since(start)
	c := append([]time.Duration(nil), lv.snapCosts()...)
	if len(c) >= 64 {
		c = c[1:]
	}
	c = append(c, lv.lastCost)
	lv.costs.Store(&c)
	return nil
}

// snapCosts are the costs of the last (up to 64) snapshots.
func (lv *live) snapCosts() []time.Duration {
	if c := lv.costs.Load(); c != nil {
		return *c
	}
	return nil
}

// ServeHTTP serves the session's routes from the latest snapshot; api/doc
// answers itself (long poll with ?rev=).
func (lv *live) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Path == "/api/doc" {
		lv.serveDoc(w, r)
		return
	}
	lv.cur.Load().handler.ServeHTTP(w, r)
}

// serveDoc is GET api/doc: the latest snapshot's document, its revision in
// the X-Rev header. With ?rev=N and no newer revision than N yet, it waits
// up to liveDocWait for the next snapshot (or the end of the follow) and
// answers the document it has then.
func (lv *live) serveDoc(w http.ResponseWriter, r *http.Request) {
	snap := lv.cur.Load()
	if q := r.URL.Query().Get("rev"); q != "" {
		want, err := strconv.Atoi(q)
		if err != nil {
			writeError(w, errorf(CodeBadRequest, "rev: want a number"))
			return
		}
		timeout := time.NewTimer(liveDocWait)
		defer timeout.Stop()
	wait:
		for snap.rev <= want {
			lv.mu.Lock()
			next := lv.next // the snapshot stores cur, then closes next
			lv.mu.Unlock()
			if snap = lv.cur.Load(); snap.rev > want {
				break
			}
			select {
			case <-next:
				snap = lv.cur.Load()
			case <-lv.stopped:
				snap = lv.cur.Load()
				break wait
			case <-timeout.C:
				break wait
			case <-r.Context().Done():
				return
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Rev", strconv.Itoa(snap.rev))
	w.Write(snap.doc)
}

// close releases what the follow holds: the spill directory and the files.
// The session calls it after the follow has stopped (Session.close).
func (lv *live) close() {
	lv.closeOnce.Do(func() {
		var errs []error
		if lv.spill != nil {
			errs = append(errs, lv.spill.Close())
		}
		if lv.f != nil {
			errs = append(errs, lv.f.Close())
		}
		for _, f := range lv.files {
			errs = append(errs, f.rf.Close())
		}
		if err := errors.Join(errs...); err != nil {
			lv.srv.logf("error", "session %s: closing the follow: %v", lv.ss.id, err)
		}
	})
}
