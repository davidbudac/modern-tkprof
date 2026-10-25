package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// Code is the machine-readable kind of an engine error.
type Code string

// Error codes of the envelope {"error": {"code", "message"}}.
const (
	CodeBadRequest   Code = "bad_request"
	CodeNotFound     Code = "not_found"
	CodeConflict     Code = "conflict"
	CodeCancelled    Code = "cancelled"
	CodeNeedsPrompt  Code = "needs_prompt"
	CodeInternal     Code = "internal"
	CodeUnauthorized Code = "unauthorized"
)

// Status is the HTTP status that goes with the code.
func (c Code) Status() int {
	switch c {
	case CodeBadRequest:
		return http.StatusBadRequest
	case CodeNotFound:
		return http.StatusNotFound
	case CodeConflict, CodeCancelled:
		return http.StatusConflict
	case CodeNeedsPrompt:
		return http.StatusPreconditionRequired
	case CodeUnauthorized:
		return http.StatusUnauthorized
	}
	return http.StatusInternalServerError
}

// Error is an engine error with its envelope code.
type Error struct {
	Code    Code   `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }

func errorf(c Code, format string, a ...any) *Error {
	return &Error{Code: c, Message: fmt.Sprintf(format, a...)}
}

// ErrPromptCancelled is what Ask returns when the user cancels the prompt.
var ErrPromptCancelled = errors.New("prompt cancelled")

// errCancelled is the error of a job whose context ended.
var errCancelled = errors.New("cancelled")

// writeError writes err in the envelope; errors other than *Error are internal.
func writeError(w http.ResponseWriter, err error) {
	var e *Error
	if !errors.As(err, &e) {
		e = &Error{Code: CodeInternal, Message: err.Error()}
	}
	writeJSON(w, e.Code.Status(), struct {
		Error *Error `json:"error"`
	}{e})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		status, b = http.StatusInternalServerError, []byte(`{"error":{"code":"internal","message":"encoding the answer failed"}}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(b)
}
