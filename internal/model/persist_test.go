package model

import (
	"bytes"
	"errors"
	"reflect"
	"testing"
)

// TestPersistCoversEveryField fails when a struct of the format gains or loses
// a field: add it to the codec function and bump PersistVersion.
func TestPersistCoversEveryField(t *testing.T) {
	for _, v := range []any{Model{}, FileInfo{}, FileEntry{}, KV{}, Span{}, Statement{}, Cursor{}, Event{}, Context{},
		Plan{}, PlanLine{}, Transaction{}, ErrorEvent{}, Marker{}, UnknownLine{}, Diagnostics{}, RefObject{}, RefFile{},
		RefUser{}, ctxExtent{}, wallAnchor{}} {
		typ := reflect.TypeOf(v)
		want, ok := persistFields[typ.Name()]
		if !ok {
			t.Errorf("%s: not in persistFields", typ.Name())
			continue
		}
		if got := typ.NumField(); got != want {
			t.Errorf("%s has %d fields, the persist format covers %d: update persist.go and bump PersistVersion", typ.Name(), got, want)
		}
	}
}

func TestDecodeRejectsOtherVersion(t *testing.T) {
	m := &Model{Aggregate: true}
	var buf bytes.Buffer
	if err := Encode(&buf, m); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	b[len(persistMagic)]++ // the version varint follows the magic
	if _, err := Decode(bytes.NewReader(b)); !errors.Is(err, ErrFormat) {
		t.Fatalf("other version: %v, want ErrFormat", err)
	}
	if _, err := Decode(bytes.NewReader(buf.Bytes()[:buf.Len()/2])); !errors.Is(err, ErrFormat) {
		t.Fatalf("truncated: %v, want ErrFormat", err)
	}
	if err := Encode(&buf, &Model{Calls: make([]Call, 1)}); err == nil {
		t.Fatal("encoded a model with fact tables")
	}
}
