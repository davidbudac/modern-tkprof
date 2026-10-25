package remote

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"time"
)

// Stat returns the entry of the remote file p (an error for a directory).
func Stat(ctx context.Context, s SSH, p string) (Entry, error) {
	ents, err := s.Ls(ctx, p)
	if err != nil {
		return Entry{}, err
	}
	if len(ents) != 1 || ents[0].Dir || path.Base(ents[0].Path) != path.Base(p) {
		return Entry{}, fmt.Errorf("%s: not a file", p)
	}
	return ents[0], nil
}

// FetchFile copies the remote file p (remoteSize bytes when listed) into
// local, resuming at the local file's size; a local file longer than the
// remote one (replaced or rotated on the host) is fetched again from the
// start. progress gets the local size. It returns the local size at the end
// (also on error: the partial file stays for the next resume).
func FetchFile(ctx context.Context, s SSH, p, local string, remoteSize int64, noGzip bool, progress func(int64)) (int64, error) {
	f, err := os.OpenFile(local, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return 0, err
	}
	from, err := f.Seek(0, io.SeekEnd)
	if err == nil && from > remoteSize {
		if err = f.Truncate(0); err == nil {
			from, err = f.Seek(0, io.SeekStart)
		}
	}
	if err != nil {
		f.Close()
		return 0, err
	}
	if progress != nil {
		progress(from)
	}
	err = s.Fetch(ctx, p, f, FetchOptions{From: from, NoGzip: noGzip, Progress: progress})
	end, _ := f.Seek(0, io.SeekCurrent)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return end, err
}

// FollowRetries is how many failed streams in a row end FollowTo.
const FollowRetries = 5

// FollowTo writes the remote file p from byte from on to w and keeps
// appending what the host writes until ctx ends (then it returns
// ctx.Err()). A dropped stream is reopened at the current offset (logf
// says so), after 1 s, 2 s, ...; FollowRetries failures in a row end it
// with the last error. progress gets the offset after every write.
func FollowTo(ctx context.Context, s SSH, p string, w io.Writer, from int64, progress func(int64), logf func(format string, a ...any)) error {
	buf := make([]byte, 256<<10)
	off, fails := from, 0
	for ctx.Err() == nil {
		rc, err := s.Follow(ctx, p, off)
		if err == nil {
			for {
				n, rerr := rc.Read(buf)
				if n > 0 {
					if _, werr := w.Write(buf[:n]); werr != nil {
						rc.Close()
						return werr
					}
					off += int64(n)
					fails = 0
					if progress != nil {
						progress(off)
					}
				}
				if rerr != nil {
					if rerr != io.EOF {
						err = rerr
					}
					break
				}
			}
			rc.Close()
		}
		if ctx.Err() != nil {
			break
		}
		if err == nil {
			err = errors.New("the stream ended")
		}
		if fails++; fails >= FollowRetries {
			return err
		}
		if logf != nil {
			logf("follow %s: %v; reconnecting", p, err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Duration(fails) * time.Second):
		}
	}
	return ctx.Err()
}
