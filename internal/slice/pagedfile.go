package slice

import (
	"errors"
	"io"
	"os"
	"sort"
)

// pagedFile is a file of fixed-size records that is written by row number in
// roughly ascending order: the new rows of the tail land in a small cache of
// pages, rows that settle out of order (a wait that finds its call much
// later) and patches to rows already written (the parent of a call arrives
// after the call) are applied to the cache when their page is recent, else
// queued and applied page by page when the queue is full, so a straggler
// never costs a page read of its own. Memory is maxPages pages plus the
// queue, whatever the size of the file.
type pagedFile struct {
	f        *os.File
	recSize  int
	pageRecs int64
	pageSize int
	maxPages int
	margin   int64 // pages this close to the newest count as recent

	pages map[int64]*page
	tick  uint64
	top   int64 // newest page number touched
	n     int64 // rows: highest row written + 1

	late  []lateOp
	arena []byte
	err   error
}

type page struct {
	no    int64
	buf   []byte
	dirty bool
	used  uint64
}

type lateOp struct {
	idx    int64
	off, n int32
	at     int
}

const (
	pageBytes = 256 << 10
	lateBytes = 16 << 20
)

func newPagedFile(f *os.File, recSize, maxPages int) *pagedFile {
	pr := int64(pageBytes / recSize)
	if pr < 1 {
		pr = 1
	}
	return &pagedFile{f: f, recSize: recSize, pageRecs: pr, pageSize: int(pr) * recSize, maxPages: maxPages,
		margin: int64(maxPages / 2), pages: map[int64]*page{}, top: -1}
}

// put stores row idx.
func (p *pagedFile) put(idx int64, rec []byte) {
	if idx >= p.n {
		p.n = idx + 1
	}
	p.write(idx, 0, rec)
}

// patch overwrites len(data) bytes at offset off of the already written row idx.
func (p *pagedFile) patch(idx int64, off int, data []byte) {
	p.write(idx, off, data)
}

func (p *pagedFile) write(idx int64, off int, data []byte) {
	if p.err != nil {
		return
	}
	no := idx / p.pageRecs
	if pg := p.pages[no]; pg != nil || no >= p.top-p.margin {
		if pg == nil {
			pg = p.load(no)
			if pg == nil {
				return
			}
		}
		p.tick++
		pg.used = p.tick
		pg.dirty = true
		copy(pg.buf[int(idx%p.pageRecs)*p.recSize+off:], data)
		return
	}
	p.late = append(p.late, lateOp{idx: idx, off: int32(off), n: int32(len(data)), at: len(p.arena)})
	p.arena = append(p.arena, data...)
	if len(p.arena) >= lateBytes {
		p.flushLate()
	}
}

// load brings page no into the cache (a fresh zero page beyond the newest one).
func (p *pagedFile) load(no int64) *page {
	if len(p.pages) >= p.maxPages && !p.evict() {
		return nil
	}
	pg := &page{no: no, buf: make([]byte, p.pageSize)}
	if no <= p.top {
		if _, err := p.f.ReadAt(pg.buf, no*int64(p.pageSize)); err != nil && !errors.Is(err, io.EOF) {
			p.err = err
			return nil
		}
	} else {
		p.top = no
	}
	p.pages[no] = pg
	return pg
}

// evict writes out the least recently used page.
func (p *pagedFile) evict() bool {
	var lru *page
	for _, pg := range p.pages {
		if lru == nil || pg.used < lru.used {
			lru = pg
		}
	}
	if lru == nil {
		return true
	}
	if err := p.flushPage(lru); err != nil {
		p.err = err
		return false
	}
	delete(p.pages, lru.no)
	return true
}

func (p *pagedFile) flushPage(pg *page) error {
	if !pg.dirty {
		return nil
	}
	pg.dirty = false
	_, err := p.f.WriteAt(pg.buf, pg.no*int64(p.pageSize))
	return err
}

// flushLate applies the queued writes in row order, so every page is loaded once.
func (p *pagedFile) flushLate() {
	ops := p.late
	sort.SliceStable(ops, func(a, b int) bool { return ops[a].idx < ops[b].idx })
	for _, op := range ops {
		if p.err != nil {
			break
		}
		no := op.idx / p.pageRecs
		pg := p.pages[no]
		if pg == nil {
			if pg = p.load(no); pg == nil {
				break
			}
		}
		p.tick++
		pg.used = p.tick
		pg.dirty = true
		copy(pg.buf[int(op.idx%p.pageRecs)*p.recSize+int(op.off):], p.arena[op.at:op.at+int(op.n)])
	}
	p.late, p.arena = p.late[:0], p.arena[:0]
}

// flush writes everything out, drops the cache and cuts the file to its rows.
func (p *pagedFile) flush() error {
	if len(p.late) > 0 {
		p.flushLate()
	}
	if p.err == nil {
		nos := make([]int64, 0, len(p.pages))
		for no := range p.pages {
			nos = append(nos, no)
		}
		sort.Slice(nos, func(a, b int) bool { return nos[a] < nos[b] })
		for _, no := range nos {
			if err := p.flushPage(p.pages[no]); err != nil {
				p.err = err
				break
			}
		}
	}
	p.pages = map[int64]*page{}
	if p.err == nil {
		p.err = p.f.Truncate(p.n * int64(p.recSize))
	}
	return p.err
}
