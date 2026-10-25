package sshcli

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/remote"
)

// The askpass bridge. ssh runs SSH_ASKPASS (this mtkprof binary) with the
// prompt text as its argument; the helper (RunAskpass) classifies the text,
// posts it to POST /engine/askpass of the engine (or of the CLI's in-process
// Bridge), which asks its Prompter, and prints the answer for ssh. The
// environment of every spawned ssh/sftp carries what the helper needs.
const (
	EnvAskpassMode = "MTKPROF_ASKPASS"      // "1": run as ssh's askpass helper (cmd/mtkprof dispatches on it)
	EnvEngine      = "MTKPROF_ENGINE"       // host:port answering POST /engine/askpass
	EnvToken       = "MTKPROF_TOKEN"        // its bearer token
	EnvConn        = "MTKPROF_PROMPT_CONN"  // the connection id the prompt belongs to
	EnvSpawn       = "MTKPROF_PROMPT_SPAWN" // id of one ssh run: a cached password is offered once per run
	EnvMark        = "MTKPROF_ASKPASS_MARK" // a file the helper appends to (askpass was called)
)

// AskpassPath is the route the helper posts to.
const AskpassPath = "/engine/askpass"

// AskpassRequest is the body of POST /engine/askpass.
type AskpassRequest struct {
	Connection  string `json:"connection"`
	Kind        string `json:"kind"` // password, passphrase, otp, hostkey or confirm
	Text        string `json:"text"`
	Fingerprint string `json:"fingerprint,omitempty"`
	Spawn       string `json:"spawn,omitempty"`
}

// AskpassResponse is the answer of POST /engine/askpass.
type AskpassResponse struct {
	Answer string `json:"answer"`
}

// RunAskpass is the helper ssh runs: args are its arguments (the prompt text).
// With MTKPROF_ENGINE set it asks the engine; otherwise fallback (the
// terminal). It prints the answer (hostkey: yes or no) and returns the exit
// status: 0 answered, 1 cancelled or failed. With SSH_ASKPASS_PROMPT=confirm
// (ssh-agent confirmations) the status is the answer and nothing is printed.
func RunAskpass(args []string, stdout, stderr io.Writer, fallback remote.Prompter) int {
	if m := os.Getenv(EnvMark); m != "" {
		if f, err := os.OpenFile(m, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600); err == nil {
			f.Write([]byte("1"))
			f.Close()
		}
	}
	text := strings.Join(args, " ")
	kind, fp := remote.ClassifyPrompt(text)
	mode := os.Getenv("SSH_ASKPASS_PROMPT")
	switch mode {
	case "none": // information only (e.g. "touch your security key"); ssh does not wait
		fmt.Fprintln(stderr, text)
		return 0
	case "confirm":
		kind = remote.KindConfirm
	}
	p := remote.Prompt{Connection: os.Getenv(EnvConn), Kind: kind, Text: text, Fingerprint: fp,
		Echo: kind == remote.KindHostKey || kind == remote.KindConfirm}
	var ans string
	var err error
	if addr := os.Getenv(EnvEngine); addr != "" {
		ans, err = askEngine(addr, os.Getenv(EnvToken), AskpassRequest{Connection: p.Connection, Kind: kind, Text: text,
			Fingerprint: fp, Spawn: os.Getenv(EnvSpawn)})
	} else if fallback != nil {
		ans, err = fallback.Ask(context.Background(), p)
	} else {
		err = errors.New("no engine (MTKPROF_ENGINE) and no terminal")
	}
	if err != nil {
		fmt.Fprintf(stderr, "mtkprof askpass: %v\n", err)
		return 1
	}
	switch {
	case mode == "confirm":
		if remote.Yes(ans, p) {
			return 0
		}
		return 1
	case kind == remote.KindHostKey:
		if remote.Yes(ans, p) {
			ans = "yes"
		} else {
			ans = "no"
		}
	}
	fmt.Fprintln(stdout, ans)
	return 0
}

// askEngine posts the prompt and waits (without a time limit: the user is typing).
func askEngine(addr, token string, req AskpassRequest) (string, error) {
	b, _ := json.Marshal(req)
	hr, err := http.NewRequest(http.MethodPost, "http://"+addr+AskpassPath, bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	hr.Header.Set("Authorization", "Bearer "+token)
	hr.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(hr)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		var env struct {
			Error struct{ Message string } `json:"error"`
		}
		if json.Unmarshal(body, &env) == nil && env.Error.Message != "" {
			return "", errors.New(env.Error.Message)
		}
		return "", fmt.Errorf("engine: %s", resp.Status)
	}
	var ar AskpassResponse
	if err := json.Unmarshal(body, &ar); err != nil {
		return "", fmt.Errorf("engine: %v", err)
	}
	return ar.Answer, nil
}

// Answerer answers the askpass requests of one connection through a
// Prompter. Password and passphrase answers are kept in memory (never on
// disk) so later ssh runs of the connection do not ask again; a cached
// answer is offered once per ssh run, so when ssh asks the same question
// again in that run (the answer was wrong) the user is asked.
type Answerer struct {
	Prompter remote.Prompter

	mu      sync.Mutex
	cache   map[string]string
	offered map[string]map[string]bool // spawn -> cache keys offered in that run
}

// Answer asks (or answers from the cache) one askpass request.
func (a *Answerer) Answer(ctx context.Context, r AskpassRequest) (string, error) {
	kind, fp := remote.ClassifyPrompt(r.Text)
	if remote.ValidKind(r.Kind) {
		kind = r.Kind
	}
	if r.Fingerprint != "" {
		fp = r.Fingerprint
	}
	p := remote.Prompt{Connection: r.Connection, Kind: kind, Text: r.Text, Fingerprint: fp,
		Echo: kind == remote.KindHostKey || kind == remote.KindConfirm}
	cacheable := kind == remote.KindPassword || kind == remote.KindPassphrase
	key := kind + "\x00" + r.Text
	if cacheable {
		a.mu.Lock()
		if a.offered == nil {
			a.cache, a.offered = map[string]string{}, map[string]map[string]bool{}
		}
		ans, ok := a.cache[key]
		if ok && r.Spawn != "" && !a.offered[r.Spawn][key] {
			if a.offered[r.Spawn] == nil {
				if len(a.offered) > 1000 {
					clear(a.offered)
				}
				a.offered[r.Spawn] = map[string]bool{}
			}
			a.offered[r.Spawn][key] = true
			a.mu.Unlock()
			return ans, nil
		}
		delete(a.cache, key) // wrong (asked again in the same run) or not cached
		a.mu.Unlock()
	}
	ans, err := a.Prompter.Ask(ctx, p)
	if err != nil {
		return "", err
	}
	if cacheable {
		a.mu.Lock()
		if a.offered == nil {
			a.cache, a.offered = map[string]string{}, map[string]map[string]bool{}
		}
		a.cache[key] = ans
		if r.Spawn != "" {
			if a.offered[r.Spawn] == nil {
				a.offered[r.Spawn] = map[string]bool{}
			}
			a.offered[r.Spawn][key] = true
		}
		a.mu.Unlock()
	}
	return ans, nil
}

// Forget drops every cached answer.
func (a *Answerer) Forget() {
	a.mu.Lock()
	a.cache, a.offered = nil, nil
	a.mu.Unlock()
}

// Bridge is an in-process POST /engine/askpass on 127.0.0.1 for the CLI:
// the ssh it spawns asks through it, and it asks its Prompter (the terminal).
type Bridge struct {
	Addr  string
	Token string

	ans Answerer
	srv *http.Server
}

// StartBridge starts a bridge answering through p.
func StartBridge(p remote.Prompter) (*Bridge, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	var tok [24]byte
	rand.Read(tok[:])
	b := &Bridge{Addr: ln.Addr().String(), Token: hex.EncodeToString(tok[:]), ans: Answerer{Prompter: p}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+AskpassPath, b.serve)
	b.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go b.srv.Serve(ln)
	return b, nil
}

func (b *Bridge) serve(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+b.Token)) != 1 {
		http.Error(w, `{"error":{"code":"unauthorized","message":"wrong token"}}`, http.StatusUnauthorized)
		return
	}
	var req AskpassRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		http.Error(w, `{"error":{"code":"bad_request","message":"body"}}`, http.StatusBadRequest)
		return
	}
	ans, err := b.ans.Answer(r.Context(), req)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "cancelled", "message": err.Error()}})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(AskpassResponse{Answer: ans})
}

// Env is what a Client spawning ssh for connection conn needs to ask through the bridge.
func (b *Bridge) Env(conn string) AskpassEnv {
	return AskpassEnv{Engine: b.Addr, Token: b.Token, Conn: conn}
}

// Close stops the bridge and forgets its cached answers.
func (b *Bridge) Close() error {
	b.ans.Forget()
	return b.srv.Close()
}
