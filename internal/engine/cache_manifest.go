package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Manifest is manifest.json of a cache entry. It is written last (the entry
// directory is renamed into place after it), so an entry with a valid
// manifest is complete.
type Manifest struct {
	Engine      string           `json:"engine"`      // report.Version of the engine that built it (informational)
	IndexFormat int              `json:"indexFormat"` // CacheIndexFormat; another value is a miss
	Protocol    int              `json:"protocol"`    // Cache.Protocol at build time (informational)
	Identity    string           `json:"identity"`    // IdentityOfSet; the directory name
	Inputs      []string         `json:"inputs"`      // IdentityOfFile of the files the user named (the identity is computed from them)
	Sources     []ManifestSource `json:"sources"`     // the parsed files, in parse order (model File.Files)
	Options     ManifestOptions  `json:"options"`
	Created     time.Time        `json:"created"`
	LastUsed    time.Time        `json:"lastUsed"`
	Bytes       int64            `json:"bytes"` // Σ Files
	Files       map[string]int64 `json:"files"` // size of every file of the entry, checked by Lookup
}

// ManifestSource is one input file of the entry.
type ManifestSource struct {
	Path     string    `json:"path"` // absolute, at build time
	Size     int64     `json:"size"`
	Mtime    time.Time `json:"mtime"`
	Identity string    `json:"identity"` // IdentityOfFile
	Named    bool      `json:"named"`    // one of the Inputs; false: followed as part of a chain
}

// ManifestOptions are the build options that are part of the identity.
type ManifestOptions struct {
	BindMode   string `json:"bindMode"`             // model.BindMode.String()
	SaltHash   string `json:"saltHash,omitempty"`   // IdentitySaltHash
	Thresholds string `json:"thresholds,omitempty"` // sha256 of the finding thresholds (JSON) the aggregates were built with
	NoFollow   bool   `json:"noFollow,omitempty"`
}

// extra is the extra argument of IdentityOfSet for these options.
func (o ManifestOptions) extra() []string {
	return []string{"thresholds=" + o.Thresholds, fmt.Sprintf("nofollow=%t", o.NoFollow)}
}

// identity recomputes the identity of the manifest from its named sources and options.
func (m *Manifest) identity() string {
	return IdentityOfSet(m.Inputs, m.IndexFormat, m.Options.BindMode, m.Options.SaltHash, m.Options.extra()...)
}

// valid reports whether the manifest describes a usable entry named identity.
func (m *Manifest) valid(identity string) error {
	switch {
	case m.IndexFormat != CacheIndexFormat:
		return fmt.Errorf("index format %d, want %d", m.IndexFormat, CacheIndexFormat)
	case m.Identity != identity:
		return fmt.Errorf("manifest of %s in the directory of %s", m.Identity, identity)
	case m.identity() != identity:
		return errors.New("sources and options do not give the identity")
	case len(m.Files) == 0:
		return errors.New("no files")
	}
	return nil
}

const manifestName = "manifest.json"

func readManifest(dir string) (*Manifest, error) {
	b, err := os.ReadFile(filepath.Join(dir, manifestName))
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", manifestName, err)
	}
	return &m, nil
}

// writeManifest replaces manifest.json atomically (temporary file, sync, rename).
func writeManifest(dir string, m *Manifest) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, manifestName+".tmp")
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(append(b, '\n'))
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, filepath.Join(dir, manifestName))
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}
