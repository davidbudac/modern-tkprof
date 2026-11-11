package engine

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// streamReport: an error after bytes were sent must reach the client as a
// broken body, an error before them as an error answer.
func TestStreamReport(t *testing.T) {
	chunk := []byte(strings.Repeat("x", 64<<10))
	serve := func(write func(io.Writer) error) *httptest.Server {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="x.txt"`)
			streamReport(w, r, write)
		}))
		t.Cleanup(ts.Close)
		return ts
	}
	get := func(ts *httptest.Server) (*http.Response, []byte, error) {
		t.Helper()
		res, err := http.Get(ts.URL)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, err := io.ReadAll(res.Body)
		return res, b, err
	}

	// complete
	res, b, err := get(serve(func(w io.Writer) error {
		for i := 0; i < 16; i++ {
			if _, err := w.Write(chunk); err != nil {
				return err
			}
		}
		return nil
	}))
	if err != nil || res.StatusCode != 200 || len(b) != 16*len(chunk) {
		t.Errorf("complete: %v, status %d, %d bytes", err, res.StatusCode, len(b))
	}

	// fails after 1 MiB went out: the body must not end cleanly
	res, b, err = get(serve(func(w io.Writer) error {
		for i := 0; i < 16; i++ {
			if _, err := w.Write(chunk); err != nil {
				return err
			}
		}
		return errors.New("the spill is gone")
	}))
	if res.StatusCode != 200 {
		t.Errorf("mid-stream: status %d", res.StatusCode)
	}
	if err == nil {
		t.Errorf("mid-stream: the body of %d bytes ended as a complete answer", len(b))
	}

	// fails before anything went out: an error answer without the attachment header
	res, b, err = get(serve(func(w io.Writer) error { return errors.New("no such thing") }))
	if err != nil || res.StatusCode != 500 || !strings.Contains(string(b), "no such thing") || res.Header.Get("Content-Disposition") != "" {
		t.Errorf("early: %v, status %d, disposition %q, body %s", err, res.StatusCode, res.Header.Get("Content-Disposition"), b)
	}
}
