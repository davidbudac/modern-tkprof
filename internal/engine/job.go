package engine

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Job states.
const (
	JobRunning   = "running"
	JobDone      = "done"
	JobFailed    = "failed"
	JobCancelled = "cancelled"
)

// maxFinishedJobs bounds the finished jobs GET /engine/jobs still lists.
const maxFinishedJobs = 100

// JobInfo is a job as GET /engine/jobs and the job event show it.
type JobInfo struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`  // open
	State   string `json:"state"` // running, done, failed, cancelled
	Phase   string `json:"phase"` // open: parse, index, ready
	Done    int64  `json:"done"`
	Total   int64  `json:"total"`
	Unit    string `json:"unit"` // bytes, files
	Message string `json:"message"`

	Session    string `json:"session,omitempty"`    // the session the job opens
	Lines      int64  `json:"lines,omitempty"`      // parse progress (Progress)
	Statements int64  `json:"statements,omitempty"` // parse progress (Progress)
}

// Job is a cancelable piece of background work. Its context ends when the
// job is cancelled (DELETE /engine/jobs/{id}) or the engine shuts down.
type Job struct {
	ctx    context.Context
	cancel context.CancelFunc
	srv    *Server

	mu    sync.Mutex
	info  JobInfo
	start time.Time
	end   time.Time
}

// newJobLocked registers a new running job; s.mu is held. The caller
// publishes it.
func (s *Server) newJobLocked(kind, session string) *Job {
	ctx, cancel := context.WithCancel(s.ctx)
	j := &Job{ctx: ctx, cancel: cancel, srv: s, start: time.Now(),
		info: JobInfo{ID: newID("j"), Kind: kind, State: JobRunning, Session: session}}
	s.jobs[j.info.ID] = j
	s.pruneJobsLocked()
	return j
}

// Context is the job's context.
func (j *Job) Context() context.Context { return j.ctx }

// Info is a snapshot of the job.
func (j *Job) Info() JobInfo {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.info
}

func (j *Job) publish() { j.srv.bc.publish("job", j.Info()) }

// SetPhase starts a phase with its own counter (total 0 = unknown).
func (j *Job) SetPhase(phase, unit string, done, total int64) {
	j.mu.Lock()
	j.info.Phase, j.info.Unit, j.info.Done, j.info.Total = phase, unit, done, total
	j.mu.Unlock()
	j.publish()
}

// Progress reports parse progress: bytes read so far, lines and statements.
// It is the seam for model.Options.OnProgress (phase "parse", unit bytes).
func (j *Job) Progress(bytes, lines, statements int64) {
	j.mu.Lock()
	j.info.Done, j.info.Lines, j.info.Statements = bytes, lines, statements
	j.mu.Unlock()
	j.publish()
}

// finish ends the job: err nil = done, errCancelled or context.Canceled =
// cancelled, else failed with the error as the message.
func (j *Job) finish(err error) {
	j.mu.Lock()
	switch {
	case err == nil:
		j.info.State = JobDone
	case errors.Is(err, errCancelled) || errors.Is(err, context.Canceled):
		j.info.State, j.info.Message = JobCancelled, "cancelled"
	default:
		j.info.State, j.info.Message = JobFailed, err.Error()
	}
	j.end = time.Now()
	j.mu.Unlock()
	j.cancel()
	j.publish()
}

func (j *Job) running() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.info.State == JobRunning
}

// pruneJobsLocked drops the oldest finished jobs beyond maxFinishedJobs.
func (s *Server) pruneJobsLocked() {
	var fin []*Job
	for _, j := range s.jobs {
		if !j.running() {
			fin = append(fin, j)
		}
	}
	if len(fin) <= maxFinishedJobs {
		return
	}
	sort.Slice(fin, func(a, b int) bool { return fin[a].end.Before(fin[b].end) })
	for _, j := range fin[:len(fin)-maxFinishedJobs] {
		delete(s.jobs, j.info.ID)
	}
}

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	jobs := make([]*Job, 0, len(s.jobs))
	for _, j := range s.jobs {
		jobs = append(jobs, j)
	}
	s.mu.Unlock()
	sort.Slice(jobs, func(a, b int) bool { return jobs[a].start.Before(jobs[b].start) })
	out := make([]JobInfo, len(jobs))
	for i, j := range jobs {
		out[i] = j.Info()
	}
	writeJSON(w, http.StatusOK, struct {
		Jobs []JobInfo `json:"jobs"`
	}{out})
}

// cancelJob cancels a running job; the job reaches "cancelled" once its work
// has stopped (a job event says so). A finished job is a conflict.
func (s *Server) cancelJob(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j := s.jobs[r.PathValue("id")]
	s.mu.Unlock()
	if j == nil {
		writeError(w, errorf(CodeNotFound, "no job %q", r.PathValue("id")))
		return
	}
	if !j.running() {
		writeError(w, errorf(CodeConflict, "job %s is %s", j.info.ID, j.Info().State))
		return
	}
	j.cancel()
	writeJSON(w, http.StatusAccepted, struct {
		Job JobInfo `json:"job"`
	}{j.Info()})
}
