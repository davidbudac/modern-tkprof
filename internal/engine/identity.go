package engine

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
)

// Content identity of trace files (docs/PLAN-DESKTOP.md § 3): a trace that was
// moved, renamed or fetched again has the same identity, so it hits the index
// cache, and annotations stay attached to it.
//
//	identity(file) = sha256(size ‖ first 1 MiB)
//	identity(set)  = sha256(sorted file identities ‖ index format ‖ bind mode ‖ salt hash ‖ extra)
//
// The size is 8 bytes little endian. Two files of the same size whose first
// MiB agree but that differ later have the same identity: the price of not
// reading a 2 GB file to open it from the cache.

// IdentityPrefixBytes is how much of a file its identity reads.
const IdentityPrefixBytes = 1 << 20

// IdentityOfFile is the content identity of one file (hex sha256).
func IdentityOfFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return "", err
	}
	if fi.IsDir() {
		return "", fmt.Errorf("%s is a directory", path)
	}
	h := sha256.New()
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], uint64(fi.Size()))
	h.Write(b[:])
	if _, err := io.CopyN(h, f, IdentityPrefixBytes); err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// IdentityOfFiles is IdentityOfFile of every path, in order.
func IdentityOfFiles(paths []string) ([]string, error) {
	out := make([]string, len(paths))
	for i, p := range paths {
		id, err := IdentityOfFile(p)
		if err != nil {
			return nil, err
		}
		out[i] = id
	}
	return out, nil
}

// TraceIdentity is the identity of a set of files without build options (the
// key of annotations): sha256 over the sorted file identities. Order and
// names of the files do not matter.
func TraceIdentity(fileIDs []string) string {
	return identityHash(fileIDs, nil)
}

// IdentityOfSet is the identity of an index built from the files with these
// options: the name of its cache entry. bindMode is model.BindMode.String(),
// saltHash IdentitySaltHash of the redaction salt; extra are further options
// that change what is built (the cache passes the finding thresholds and
// NoFollow).
func IdentityOfSet(fileIDs []string, indexFormat int, bindMode, saltHash string, extra ...string) string {
	opts := append([]string{fmt.Sprintf("format=%d", indexFormat), "binds=" + bindMode, "salt=" + saltHash}, extra...)
	return identityHash(fileIDs, opts)
}

func identityHash(fileIDs, opts []string) string {
	ids := slices.Clone(fileIDs)
	slices.Sort(ids)
	h := sha256.New()
	for _, id := range ids {
		fmt.Fprintf(h, "file\x00%s\x00", id)
	}
	for _, o := range opts {
		fmt.Fprintf(h, "opt\x00%s\x00", o)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// IdentitySaltHash hides the redaction salt in the identity and the manifest
// ("" for no salt).
func IdentitySaltHash(salt string) string {
	if salt == "" {
		return ""
	}
	s := sha256.Sum256([]byte("mtkprof-salt\x00" + salt))
	return hex.EncodeToString(s[:])
}
