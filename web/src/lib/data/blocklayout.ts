// The layout of the I/O map (views/BlockMap.tsx; the view id is `blocks`), kept here so it is unit-tested without a DOM: the
// panels (one per file, or one per object), the x axis (I/O order with short stretches widened, or time), the y axis (block
// number: linear, or packed with the empty block ranges collapsed), the marks, the colour modes (event, object, object type,
// schema, tablespace, file, statement, session, latency, read size, re-reads), the statement brackets, the hit test, and
// `drawBlockMap`, which paints one panel (its density layer under the marks, data/densitylayout.ts) on a 2-D context with colours
// the component has resolved from the tokens.
import type { Event, ID } from './types'
import { IO, extentsOf, isTempEvent, isWriteEvent, mergeRuns, runBlocks, sampleStep, type BlockRun, type IOMap, type IOMapFile } from './iomap'
import { niceStep } from './scale'
import { roleOfClass } from '../components/colors'

// ---- what a wait does -----------------------------------------------------------------

export { isTempEvent, isWriteEvent } from './iomap'

/** A colour: a CSS token and its shade (0 = the token, k = k steps towards the surface, `tokenShade`). */
export interface Tone { token: string; shade: number }

/**
 * The colour of each block I/O event in "event" mode: temp reads and writes their own hues (`--bm-temp-r`, `--bm-temp-w`), reads of
 * the User I/O class `--c-userio`, its writes `--bm-write` (darker), concurrency waits `--c-concurrency`, other classes their role;
 * several events on one token get successive shades, in event-id order.
 */
export function eventTones(events: readonly Event[], ids: readonly ID[]): Map<ID, Tone> {
  const out = new Map<ID, Tone>()
  const rank = new Map<string, number>()
  for (const id of [...ids].sort((a, b) => a - b)) {
    const ev = events[id]
    let token: string
    if (!ev) token = '--c-other'
    else if (isTempEvent(ev)) token = isWriteEvent(ev) ? '--bm-temp-w' : '--bm-temp-r'
    else {
      const role = roleOfClass(ev.class, ev.idle)
      token = role === 'userio' ? (isWriteEvent(ev) ? '--bm-write' : '--c-userio') : `--c-${role}`
    }
    const k = rank.get(token) ?? 0
    rank.set(token, k + 1)
    out.set(id, { token, shade: k })
  }
  return out
}

/** The categorical colours of the object and statement modes, in order; after them the same with a shade. */
export const CATEGORICAL = ['--c-cpu', '--c-network', '--c-userio', '--c-other', '--c-sysio', '--c-concurrency', '--c-commit'] as const
/** At most this many objects / statements get a colour of their own; the rest share `--c-idle`. */
export const MAX_CATEGORIES = 14
export const categoryTone = (k: number): Tone => (k < MAX_CATEGORIES ? { token: CATEGORICAL[k % CATEGORICAL.length], shade: Math.floor(k / CATEGORICAL.length) } : REST)
const REST: Tone = { token: '--c-idle', shade: 0 }

/** What the colours of the marks mean. */
export type ColorBy = 'event' | 'object' | 'type' | 'schema' | 'tablespace' | 'file' | 'statement' | 'session' | 'latency' | 'size' | 'reread'

export const COLOR_BYS: readonly ColorBy[] = ['event', 'object', 'type', 'schema', 'tablespace', 'file', 'statement', 'session', 'latency', 'size', 'reread']

/** A persisted value read back as a colour mode (an unknown one is `event`). */
export const colorByOf = (v: unknown): ColorBy => ((COLOR_BYS as readonly unknown[]).includes(v) ? (v as ColorBy) : 'event')

/** The kinds of legend entry: a category of the mode, a bucket of a ramp, the rest of the categories, or none (no object, unknown). */
export type LegendKind = 'event' | 'object' | 'statement' | 'type' | 'schema' | 'tablespace' | 'file' | 'session' | 'bucket' | 'rest' | 'none'

/** One entry of the legend: what a colour stands for, and how many of the rows have it. */
export interface LegendEntry {
  tone: Tone
  kind: LegendKind
  /** the event id, obj#, statement id, file number, bucket index (-1 for `rest` / `none`), or the type / schema / tablespace / session name */
  key: number | string
  rows: number
  /** the text of a `bucket`, `none` or name entry (`≤ 1 ms`, `unknown`, `TABLE`) */
  label?: string
}

export interface Coloring {
  /** the distinct colours, `idx` points into it */
  tones: Tone[]
  /** per row of the answer */
  idx: Uint16Array
  legend: LegendEntry[]
  /** per row: its legend entry (an index into `legend`), for the legend's highlight */
  entry: Uint16Array
  /** the colour of each object with extents (its object-mode colour, used by the bands in every mode) */
  objectTone: Map<number, Tone>
}

/** What the colour modes need to know beyond the rows: names of objects, files and sessions (the view passes the document's). */
export interface ColorCtx {
  /** OBJECT_TYPE of an obj# (bundle, else from the plans), undefined when unknown */
  objType?(obj: number): string | undefined
  /** OWNER of an obj# (bundle only) */
  objOwner?(obj: number): string | undefined
  /** the tablespace of a file (bundle's datafiles) */
  tablespace?(file: number): string | undefined
  /** the session of a context (`sid.serial`), undefined when the trace does not say */
  session?(ctx: number): string | undefined
}

/** Upper bounds (µs, exclusive) of the latency buckets; the last bucket has none. */
export const LATENCY_BOUNDS = [50, 200, 1000, 5000, 20000] as const
export const LATENCY_LABELS = ['< 50 µs', '50–200 µs', '0.2–1 ms', '1–5 ms', '5–20 ms', '≥ 20 ms'] as const
/** Upper bounds (blocks, inclusive) of the read-size buckets; the last bucket has none. */
export const SIZE_BOUNDS = [1, 8, 16, 32, 64] as const
export const SIZE_LABELS = ['1 block', '2–8 blocks', '9–16', '17–32', '33–64', '65+ blocks'] as const
/** Upper bounds (reads, inclusive) of the re-read buckets: how often the mark's most read block was read in scope (`IOMap.reads`). */
export const READS_BOUNDS = [1, 2, 4, 8, 16] as const
export const READS_LABELS = ['read once', '2 reads', '3–4', '5–8', '9–16', '17+ reads'] as const

/** The bucket of a value: the first bound it is under (`incl`: at or under), else the last bucket. */
export function bucketOf(v: number, bounds: readonly number[], incl = false): number {
  for (let k = 0; k < bounds.length; k++) if (incl ? v <= bounds[k] : v < bounds[k]) return k
  return bounds.length
}

/** The ramps of the latency and read-size modes: light (fast, small) to strong (slow, big), tokens in styles/blockmap.css. */
const rampTone = (mode: 'latency' | 'size' | 'reread', k: number): Tone => ({ token: `--bm-${mode === 'latency' ? 'lat' : mode === 'size' ? 'size' : 'rr'}-${k}`, shade: 0 })

const TEMP_TONE: Tone = { token: '--bm-temp-r', shade: 0 }

/**
 * The colour of every row in a mode. Objects and statements are ranked by the blocks / rows they have (most first), the other
 * named categories by rows, and take the categorical colours in that order (the first 14; the rest share `--c-idle`); temp
 * waits keep their event colour in object mode (their obj# does not own the temp blocks) and are their own `temp` category in
 * the type and schema modes; rows without an object or a name are an `unknown` (`none`) entry. Latency and read size are ramps
 * of six buckets.
 */
export function colorRows(map: Pick<IOMap, 'rows' | 'events' | 'reads'>, events: readonly Event[], by: ColorBy, cx: ColorCtx = {}): Coloring {
  const rows = map.rows
  const tones: Tone[] = []
  const toneIdx = new Map<string, number>()
  const idxOf = (t: Tone) => {
    const k = `${t.token}:${t.shade}`
    let i = toneIdx.get(k)
    if (i === undefined) { i = tones.length; tones.push(t); toneIdx.set(k, i) }
    return i
  }
  const evTones = eventTones(events, map.events.length ? map.events : [...new Set(rows.map((r) => r[IO.event]))])
  // objects by blocks moved (non-temp rows): their colour, for the object mode and the extent bands
  const objBlocks = new Map<number, number>()
  for (const r of rows) if (r[IO.obj] >= 0 && !isTempEvent(events[r[IO.event]])) objBlocks.set(r[IO.obj], (objBlocks.get(r[IO.obj]) ?? 0) + r[IO.blocks])
  const objRank = [...objBlocks.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([o]) => o)
  const objectTone = new Map(objRank.slice(0, MAX_CATEGORIES).map((o, k) => [o, categoryTone(k)]))
  const idx = new Uint16Array(rows.length)
  const entryKey: string[] = new Array(rows.length)
  const legend = new Map<string, LegendEntry>()
  const put = (i: number, key: string, e: Omit<LegendEntry, 'rows'>) => {
    idx[i] = idxOf(e.tone); entryKey[i] = key
    const x = legend.get(key)
    if (x) x.rows++; else legend.set(key, { ...e, rows: 1 })
  }
  const evTone = (ev: number) => evTones.get(ev) ?? { token: '--c-other', shade: 0 }
  const none = (i: number, label = 'unknown') => put(i, 'none', { tone: REST, kind: 'none', key: -1, label })
  /** a categorical mode over names: ranked by rows, the first MAX_CATEGORIES a colour each */
  const byName = (kind: LegendKind, nameOf: (r: number[]) => string | number | undefined, temp: boolean, noneLabel: string, rank?: Map<string | number, number>) => {
    const keyOf = (r: number[]) => (temp && isTempEvent(events[r[IO.event]]) ? TEMP : nameOf(r))
    if (!rank) {
      const n = new Map<string | number, number>()
      for (const r of rows) { const k = keyOf(r); if (k !== undefined && k !== TEMP) n.set(k, (n.get(k) ?? 0) + 1) }
      rank = new Map([...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k], j) => [k, j]))
    }
    rows.forEach((r, i) => {
      const k = keyOf(r)
      if (k === TEMP) { put(i, 'temp', { tone: TEMP_TONE, kind: 'none', key: 'temp', label: 'temp segments' }); return }
      if (k === undefined) { none(i, noneLabel); return }
      const j = rank!.get(k)!
      if (j >= MAX_CATEGORIES) { put(i, 'rest', { tone: REST, kind: 'rest', key: -1 }); return }
      put(i, `${kind}:${k}`, { tone: categoryTone(j), kind, key: k, ...(typeof k === 'string' ? { label: k } : {}) })
    })
  }
  switch (by) {
    case 'event':
      rows.forEach((r, i) => put(i, `e${r[IO.event]}`, { tone: evTone(r[IO.event]), kind: 'event', key: r[IO.event] }))
      break
    case 'object':
      rows.forEach((r, i) => {
        const ev = r[IO.event], obj = r[IO.obj]
        if (isTempEvent(events[ev])) { put(i, `e${ev}`, { tone: evTone(ev), kind: 'event', key: ev }); return }
        if (obj < 0) { none(i, 'no object'); return }
        const t = objectTone.get(obj)
        if (!t) { put(i, 'rest', { tone: REST, kind: 'rest', key: -1 }); return }
        put(i, `o${obj}`, { tone: t, kind: 'object', key: obj })
      })
      break
    case 'statement': {
      const n = new Map<number, number>()
      for (const r of rows) n.set(r[IO.stmt], (n.get(r[IO.stmt]) ?? 0) + 1)
      const rank = new Map([...n.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([s], k) => [s, k]))
      rows.forEach((r, i) => {
        const s = r[IO.stmt], k = rank.get(s)!
        if (s < 0 || k >= MAX_CATEGORIES) { put(i, 'rest', { tone: REST, kind: 'rest', key: -1 }); return }
        put(i, `s${s}`, { tone: categoryTone(k), kind: 'statement', key: s })
      })
      break
    }
    case 'type': byName('type', (r) => (r[IO.obj] >= 0 ? cx.objType?.(r[IO.obj]) : undefined), true, 'unknown type'); break
    case 'schema': byName('schema', (r) => (r[IO.obj] >= 0 ? cx.objOwner?.(r[IO.obj]) : undefined), true, 'unknown schema'); break
    case 'tablespace': byName('tablespace', (r) => cx.tablespace?.(r[IO.file]), false, 'unknown tablespace'); break
    case 'file': {
      // files keep their number order (the panels' order), not a ranking by rows
      const files = [...new Set(rows.map((r) => r[IO.file]))].sort((a, b) => a - b)
      byName('file', (r) => r[IO.file], false, '', new Map(files.map((f, j) => [f, j])))
      break
    }
    case 'session': byName('session', (r) => cx.session?.(r[IO.ctx]), false, 'unknown session'); break
    case 'latency':
    case 'size':
      rows.forEach((r, i) => {
        const k = by === 'latency' ? bucketOf(r[IO.ela], LATENCY_BOUNDS) : bucketOf(r[IO.blocks], SIZE_BOUNDS, true)
        put(i, `b${k}`, { tone: rampTone(by, k), kind: 'bucket', key: k, label: (by === 'latency' ? LATENCY_LABELS : SIZE_LABELS)[k] })
      })
      break
    case 'reread': {
      // the rows' reads come with the answer (`reads=1`); without them (an older engine, or the answer still on its way) every row is unknown
      const reads = map.reads && map.reads.length === rows.length ? map.reads : null
      rows.forEach((_, i) => {
        if (!reads) { none(i, 'reads unknown'); return }
        const k = bucketOf(reads[i], READS_BOUNDS, true)
        put(i, `b${k}`, { tone: rampTone('reread', k), kind: 'bucket', key: k, label: READS_LABELS[k] })
      })
      break
    }
  }
  // categories first (most rows first; files and buckets in their order), then events (in id order: temp waits in object mode), then temp, unknown, the rest
  const kindOrder = (e: LegendEntry) => (e.kind === 'event' ? (by === 'event' ? 0 : 1) : e.kind === 'none' ? (e.key === 'temp' ? 2 : 3) : e.kind === 'rest' ? 4 : 0)
  const ordered = (a: LegendEntry, b: LegendEntry) => {
    if (a.kind === 'event' || a.kind === 'bucket' || a.kind === 'file') return (a.key as number) - (b.key as number)
    return b.rows - a.rows || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  }
  const keys = [...legend.keys()]
  const order = keys.map((_, j) => j).sort((a, b) => {
    const ea = legend.get(keys[a])!, eb = legend.get(keys[b])!
    return kindOrder(ea) - kindOrder(eb) || ordered(ea, eb)
  })
  const list = order.map((j) => legend.get(keys[j])!)
  const pos = new Map(order.map((j, p) => [keys[j], p]))
  const entry = new Uint16Array(rows.length)
  for (let i = 0; i < rows.length; i++) entry[i] = pos.get(entryKey[i]) ?? 0
  return { tones, idx, legend: list, entry, objectTone }
}

/** The temp category of the type and schema modes (a temp wait's obj# names the statement's object, not the temp blocks' owner). */
const TEMP = '\u0000temp'

// ---- panels and the y axis --------------------------------------------------------------

export const PANEL_MIN = 60
export const PANEL_MAX = 320
/** A file with fewer waits than this gets the smallest panel, whatever its block range (three reads of exp_head$ need no 200 px). */
export const FEW_MARKS = 16

/** A panel's plot height in px: clamp(60, 320, 40 + 40·log10(1 + hi − lo)); 60 for a file of a few marks. */
export function panelHeight(f: Pick<IOMapFile, 'lo' | 'hi' | 'n'>): number {
  if (f.n < FEW_MARKS) return PANEL_MIN
  return Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, 40 + 40 * Math.log10(1 + Math.max(0, f.hi - f.lo)))))
}

/** A block range `[lo, hi)` of one file. */
export interface FileRange { file: number; lo: number; hi: number }

/** A stretch `[lo, hi)` of the blocks of one file drawn on px `[y0, y1]` of a panel (y from the top: `hi` at y0, `lo` at y1). */
export interface YSeg extends FileRange { y0: number; y1: number }

/** A panel's block axis: its segments from the bottom up (by file, then block); one segment when linear. */
export interface YScale { segs: YSeg[]; packed: boolean }

/** How the panels are cut: one per file (y = the block number in the file), or one per object (y = the object's blocks, packed). */
export type PanelsBy = 'file' | 'object'

export interface Panel extends IOMapFile {
  /** `f12` (a file), `o108609` (an object), `t203` (the temp waits of tempfile 203), `n12` (waits without an object in file 12), `rest` */
  key: string
  kind: 'file' | 'object' | 'temp' | 'none' | 'rest'
  /** the obj# of an object panel, else -1 */
  obj: number
  /** the files its rows are in, ascending (a file panel: its file) */
  files: number[]
  height: number
  /** every wait of the panel is temp I/O (a tempfile, or the temp panel of one) */
  temp: boolean
  /** the indices of the answer's rows in this panel, ascending */
  rows: Int32Array
  /** the block axis */
  ys: YScale
  /** a block range of the zoom applies to it */
  zoomed: boolean
}

export interface PanelOpts {
  by?: PanelsBy
  /** file panels: collapse the empty block ranges (object panels always do) */
  packed?: boolean
  /** block ranges of the zoom, by panel key */
  zoom?: Record<string, FileRange[]>
  /** object panels: this many objects get one each, the rest share one */
  maxObjects?: number
}

/** At most this many objects get a panel of their own (panels by object); the rest share "other objects". */
export const MAX_OBJECT_PANELS = 12
/** The tallest panel of one object. */
export const OBJECT_PANEL_MAX = 220

/** An object panel's height: the smallest for a few marks, else clamp(60, 220, 40 + 36·log10(1 + blocks touched)). */
export function objectPanelHeight(n: number, blocks: number): number {
  if (n < FEW_MARKS) return PANEL_MIN
  return Math.round(Math.min(OBJECT_PANEL_MAX, Math.max(PANEL_MIN, 40 + 36 * Math.log10(1 + Math.max(0, blocks)))))
}

/**
 * The panels: one per file with waits, in file order (`by: 'file'`, the default), or one per object (`by: 'object'`): the
 * `maxObjects` objects with the most rows, then the temp waits of each tempfile, the waits without an object of each file, and
 * "other objects". A file panel's block axis is linear over the file's range (the zoom's, when it has one) or packed; an object
 * panel's is always packed.
 */
export function panelsOf(map: Pick<IOMap, 'rows' | 'files'>, events: readonly Event[], opts: PanelOpts = {}): Panel[] {
  const rows = map.rows
  const isTemp = (i: number) => isTempEvent(events[rows[i][IO.event]])
  const zoomOf = (key: string) => { const z = opts.zoom?.[key]; return z && z.length ? z : undefined }
  if ((opts.by ?? 'file') === 'file') {
    const byFile = new Map<number, number[]>()
    rows.forEach((r, i) => { const l = byFile.get(r[IO.file]); if (l) l.push(i); else byFile.set(r[IO.file], [i]) })
    return map.files.filter((f) => f.n > 0).map((f) => {
      const idx = byFile.get(f.file) ?? []
      const key = `f${f.file}`, zoom = zoomOf(key)
      const height = panelHeight(f)
      let ys: YScale
      if (opts.packed && idx.length > 0) {
        const runs = touchedRuns(rows, idx, zoom, segsThatFit(height))
        ys = runs.length ? packedY(runs, height) : linearY(zoom?.[0] ?? f, height)
      } else ys = linearY(zoom ? { file: f.file, lo: Math.min(...zoom.map((z) => z.lo)), hi: Math.max(...zoom.map((z) => z.hi)) } : f, height)
      return { ...f, key, kind: 'file' as const, obj: -1, files: [f.file], height, temp: idx.length > 0 && idx.every(isTemp), rows: Int32Array.from(idx), ys, zoomed: !!zoom }
    })
  }
  // by object
  const groups = new Map<string, { kind: Panel['kind']; obj: number; file: number; idx: number[] }>()
  rows.forEach((r, i) => {
    const temp = isTemp(i), obj = r[IO.obj]
    const key = temp ? `t${r[IO.file]}` : obj >= 0 ? `o${obj}` : `n${r[IO.file]}`
    const g = groups.get(key)
    if (g) g.idx.push(i); else groups.set(key, { kind: temp ? 'temp' : obj >= 0 ? 'object' : 'none', obj: temp ? -1 : obj, file: r[IO.file], idx: [i] })
  })
  const objs = [...groups.entries()].filter(([, g]) => g.kind === 'object').sort((a, b) => b[1].idx.length - a[1].idx.length || a[1].obj - b[1].obj)
  const max = opts.maxObjects ?? MAX_OBJECT_PANELS
  const keep = objs.slice(0, max)
  const rest = objs.slice(max).flatMap(([, g]) => g.idx).sort((a, b) => a - b)
  const others = [...groups.entries()].filter(([, g]) => g.kind !== 'object').sort((a, b) => (a[1].kind === b[1].kind ? a[1].file - b[1].file : a[1].kind === 'temp' ? -1 : 1))
  const list: [string, { kind: Panel['kind']; obj: number; file: number; idx: number[] }][] = [...keep, ...others]
  if (rest.length) list.push(['rest', { kind: 'rest', obj: -1, file: rows[rest[0]][IO.file], idx: rest }])
  return list.map(([key, g]) => {
    const zoom = zoomOf(key)
    let runs = touchedRuns(rows, g.idx, zoom)
    const files = [...new Set(g.idx.map((i) => rows[i][IO.file]))].sort((a, b) => a - b)
    let lo = Infinity, hi = -Infinity
    for (const i of g.idx) { lo = Math.min(lo, rows[i][IO.block]); hi = Math.max(hi, rows[i][IO.block] + rows[i][IO.blocks]) }
    // tall enough for its runs (up to the tallest object panel); runs that still do not fit are merged until they do
    const height = Math.max(objectPanelHeight(g.idx.length, runBlocks(runs)), Math.min(OBJECT_PANEL_MAX, heightFor(runs.length)))
    if (runs.length > segsThatFit(height)) runs = touchedRuns(rows, g.idx, zoom, segsThatFit(height))
    const ys = runs.length ? packedY(runs, height) : linearY({ file: g.file, lo, hi }, height)
    return { key, kind: g.kind, obj: g.obj, file: files[0] ?? g.file, files, lo, hi, n: g.idx.length, height, temp: g.kind === 'temp', rows: Int32Array.from(g.idx), ys, zoomed: !!zoom }
  })
}

/** A block is drawn at most this many px tall: a range of a few blocks is widened (linear) or not stretched (packed), so one block never fills a panel. */
export const MAX_PX_PER_BLOCK = 3

/**
 * The linear block axis of one file range over a panel of `height` (`PANEL_PAD` inside the edges): `yOfBlock`. A range shorter
 * than the panel at `MAX_PX_PER_BLOCK` is widened around its middle.
 */
export function linearY(r: FileRange, height: number): YScale {
  let lo = r.lo, hi = Math.max(r.hi, r.lo + 1)
  const min = Math.ceil(Math.max(1, height - 2 * PANEL_PAD) / MAX_PX_PER_BLOCK)
  if (hi - lo < min) { lo = Math.max(0, Math.floor((lo + hi - min) / 2)); hi = lo + min }
  return { segs: [{ file: r.file, lo, hi, y0: PANEL_PAD, y1: height - PANEL_PAD }], packed: false }
}

/** At most this many segments on a packed axis: more, and the gaps that close double until they fit. */
export const MAX_SEGS = 40
/** px between two segments of a packed axis, and the least height of one. */
export const SEG_GAP_PX = 5
export const MIN_SEG_PX = 6

/** The segments a packed axis of `height` px holds at their least height (at least 1). */
export const segsThatFit = (height: number): number => Math.max(1, Math.min(MAX_SEGS, Math.floor((height - 2 * PANEL_PAD + SEG_GAP_PX) / (MIN_SEG_PX + SEG_GAP_PX))))
/** The panel height `n` segments need at their least height. */
const heightFor = (n: number): number => 2 * PANEL_PAD + n * MIN_SEG_PX + Math.max(0, n - 1) * SEG_GAP_PX

/**
 * The block runs a panel's rows touched, by file: `[block, block + blocks)` of each row, overlapping ones merged, gaps of
 * fewer than `gap` blocks closed (a scan's extents a few blocks apart are one run) — `gap` starts at 1 % of the rows' span
 * (at least 8 blocks) and doubles until there are at most `maxSegs` runs. With `clip`, only what lies inside those ranges.
 */
export function touchedRuns(rows: readonly number[][], idx: ArrayLike<number>, clip?: FileRange[], maxSegs = MAX_SEGS): FileRange[] {
  const byFile = new Map<number, BlockRun[]>()
  for (let k = 0; k < idx.length; k++) {
    const r = rows[idx[k]]
    let lo = r[IO.block], hi = lo + r[IO.blocks]
    const f = r[IO.file]
    if (clip) {
      const c = clip.find((z) => z.file === f && z.lo < hi && z.hi > lo)
      if (!c) continue
      lo = Math.max(lo, c.lo); hi = Math.min(hi, c.hi)
    }
    const l = byFile.get(f)
    if (l) l.push({ lo, hi }); else byFile.set(f, [{ lo, hi }])
  }
  const merged = [...byFile.entries()].sort((a, b) => a[0] - b[0]).map(([file, rs]) => ({ file, runs: mergeRuns(rs) }))
  let span = 0
  for (const m of merged) span += m.runs.length ? m.runs[m.runs.length - 1].hi - m.runs[0].lo : 0
  let gap = Math.max(8, Math.ceil(span / 100))
  for (;;) {
    const out: FileRange[] = []
    for (const m of merged) {
      for (const r of m.runs) {
        const last = out[out.length - 1]
        if (last && last.file === m.file && r.lo - last.hi < gap) last.hi = Math.max(last.hi, r.hi)
        else out.push({ file: m.file, lo: r.lo, hi: r.hi })
      }
    }
    if (out.length <= maxSegs || gap > 1e15) return out
    gap *= 2
  }
}

/**
 * The packed block axis: one segment per run, from the bottom up, `SEG_GAP_PX` apart, as tall as its share of the blocks
 * except that a run shorter than `minPx` is raised to it and the others share the rest (repeated until stable, as the order
 * axis' short stretches).
 */
export function packedY(runs: readonly FileRange[], height: number, minPx = MIN_SEG_PX, gapPx = SEG_GAP_PX): YScale {
  const n = runs.length
  if (n === 0) return { segs: [], packed: true }
  const inner = Math.max(n, height - 2 * PANEL_PAD - (n - 1) * gapPx)
  const min = Math.min(minPx, inner / n)
  const blocks = runs.map((r) => Math.max(1, r.hi - r.lo))
  const total = blocks.reduce((a, b) => a + b, 0)
  let small = new Set<number>()
  let per = inner / total
  for (let iter = 0; iter < 16; iter++) {
    const next = new Set<number>()
    blocks.forEach((b, k) => { if (b * per < min) next.add(k) })
    const smallBlocks = [...next].reduce((a, k) => a + blocks[k], 0)
    if (next.size === n) { per = 0; small = next; break }
    per = (inner - next.size * min) / (total - smallBlocks)
    const stable = next.size === small.size && [...next].every((k) => small.has(k))
    small = next
    if (stable) break
  }
  // a run is at most MAX_PX_PER_BLOCK per block (the least height aside): a few short runs do not fill the panel, they sit in its middle
  const hs = runs.map((_, k) => (small.has(k) ? min : Math.min(blocks[k] * per, Math.max(min, blocks[k] * MAX_PX_PER_BLOCK))))
  const used = hs.reduce((a, h) => a + h, 0)
  const segs: YSeg[] = []
  let y1 = height - PANEL_PAD - Math.max(0, (inner - used) / 2)
  runs.forEach((r, k) => {
    segs.push({ file: r.file, lo: r.lo, hi: Math.max(r.hi, r.lo + 1), y0: y1 - hs[k], y1 })
    y1 -= hs[k] + gapPx
  })
  return { segs, packed: true }
}

/** The segment of a block of a file: the one that holds it (`lo ≤ block ≤ hi`), else undefined. */
function segAt(ys: YScale, file: number, block: number): YSeg | undefined {
  for (const s of ys.segs) if (s.file === file && block >= s.lo && block <= s.hi) return s
  return undefined
}

const yIn = (s: YSeg, block: number) => s.y1 - ((block - s.lo) / (s.hi - s.lo)) * (s.y1 - s.y0)

/** y in px of a block of a file; a linear axis extends past its range, a packed one has no y outside its segments (NaN). */
export function yOf(ys: YScale, file: number, block: number): number {
  const s = segAt(ys, file, block) ?? (!ys.packed && ys.segs[0]?.file === file ? ys.segs[0] : undefined)
  return s ? yIn(s, block) : NaN
}

/** The y extent (`top` < `bottom`) of the blocks `[b0, b1)` of a file, cut to the segment they start in (or the first they overlap); null when no segment has them. */
export function ySpan(ys: YScale, file: number, b0: number, b1: number): { top: number; bottom: number } | null {
  let s = segAt(ys, file, b0)
  if (!s) for (const x of ys.segs) if (x.file === file && x.lo < b1 && x.hi > b0) { s = x; break }
  if (!s) return null
  const lo = Math.max(s.lo, b0), hi = Math.min(s.hi, b1)
  return { top: yIn(s, hi), bottom: yIn(s, lo) }
}

/** The block ranges under the pixel rows `[ya, yb]` of a panel (a drag up or down it): each segment's part between them. */
export function rangesAt(ys: YScale, ya: number, yb: number): FileRange[] {
  const top = Math.min(ya, yb), bottom = Math.max(ya, yb)
  const out: FileRange[] = []
  for (const s of ys.segs) {
    const t = Math.max(top, s.y0), b = Math.min(bottom, s.y1)
    if (t >= b) continue
    const at = (y: number) => s.lo + ((s.y1 - y) / (s.y1 - s.y0)) * (s.hi - s.lo)
    const lo = Math.max(s.lo, Math.floor(at(b))), hi = Math.min(s.hi, Math.ceil(at(t)))
    if (hi > lo) out.push({ file: s.file, lo, hi })
  }
  return out.sort((a, b) => a.file - b.file || a.lo - b.lo)
}

/** The block at a y of a panel (the hover's read-out), or null between segments. */
export function blockAtY(ys: YScale, y: number): { file: number; block: number } | null {
  for (const s of ys.segs) if (y >= s.y0 - 0.5 && y <= s.y1 + 0.5) return { file: s.file, block: Math.round(s.lo + ((s.y1 - y) / Math.max(1e-9, s.y1 - s.y0)) * (s.hi - s.lo)) }
  return null
}

/**
 * Round block numbers for a block axis: per segment a 1-2-5 step giving about one tick per 36 px inside it; a segment of a
 * packed axis under 50 px gets one, its first block, in its middle. A tick closer than `minGap` px to the one before is left
 * out (labels do not overlap). `first`: the tick is a segment's first (a packed axis labels it with the file when the panel
 * spans several).
 */
export function yTicks(ys: YScale, minGap = 12): { block: number; y: number; file: number; first: boolean }[] {
  const out: { block: number; y: number; file: number; first: boolean }[] = []
  let last = Infinity // the y of the last tick kept: labels closer than `minGap` px are left out
  const push = (t: { block: number; y: number; file: number; first: boolean }) => { if (Math.abs(last - t.y) >= minGap) { out.push(t); last = t.y } }
  for (const s of ys.segs) {
    const h = s.y1 - s.y0
    if (h >= 50 || !ys.packed) {
      const step = Math.max(1, niceStep(s.hi - s.lo, Math.max(2, Math.floor(h / 36))))
      let first = true
      for (let b = Math.ceil(s.lo / step) * step; b <= s.hi; b += step) { push({ block: b, y: yIn(s, b), file: s.file, first }); first = false }
    } else push({ block: s.lo, y: (s.y0 + s.y1) / 2, file: s.file, first: true })
  }
  return out
}

/** px kept free at the top and bottom of a panel, so the marks at the ends of its block range are not cut by the edge. */
export const PANEL_PAD = 4

/** y in px (0 = top) of a block address in a panel of `height`: the panel's `lo` at the bottom, `hi` at the top (`PANEL_PAD` inside). */
export function yOfBlock(p: Pick<IOMapFile, 'lo' | 'hi'>, height: number, block: number): number {
  const span = Math.max(1, p.hi - p.lo), inner = Math.max(1, height - 2 * PANEL_PAD)
  return height - PANEL_PAD - ((block - p.lo) / span) * inner
}

/** The block number at a y of the panel (inverse of `yOfBlock`). */
export function blockOfY(p: Pick<IOMapFile, 'lo' | 'hi'>, height: number, y: number): number {
  return p.lo + ((height - PANEL_PAD - y) / Math.max(1, height - 2 * PANEL_PAD)) * Math.max(1, p.hi - p.lo)
}

/** Round block numbers for the y axis of a panel: a 1-2-5 step giving about one tick per 36 px, inside [lo, hi]. */
export function blockTicks(p: Pick<IOMapFile, 'lo' | 'hi'>, height: number): { block: number; y: number }[] {
  const span = p.hi - p.lo
  if (span <= 0) return []
  const step = Math.max(1, niceStep(span, Math.max(2, Math.floor(height / 36))))
  const out: { block: number; y: number }[] = []
  for (let b = Math.ceil(p.lo / step) * step; b <= p.hi; b += step) out.push({ block: b, y: yOfBlock(p, height, b) })
  return out
}

// ---- the x axis ----------------------------------------------------------------------------

/** Rows `[i0, i1)` of the answer drawn on px `[x0, x1)`. */
export interface Segment { i0: number; i1: number; x0: number; x1: number }

export interface XScale {
  mode: 'order' | 'time'
  width: number
  /** rows of the answer */
  n: number
  /** order mode: the piecewise-linear map, consecutive, covering [0, n) and [0, width) */
  segs: Segment[]
  /** time mode: tim at x = 0 and x = width */
  t0: number
  t1: number
  /** order mode: the largest factor a stretch was widened by (1 = linear) */
  stretch: number
}

/** A stretch of rows the axis keeps readable: the statement (or phase) runs the brackets mark. */
export interface Run { i0: number; i1: number }

/** A short stretch is widened to at least this many px. */
export const MIN_STRETCH_PX = 64

/**
 * The order axis over `n` rows: linear, except that runs narrower than `minPx` are widened to `minPx` and the others share the
 * rest (repeated until stable), as the mock-up's broken axis did for the full scans before the sort spill. Linear when nothing is
 * short, when there is a single run, or when the short ones would need more than half of the width.
 */
export function orderScale(n: number, width: number, runs: readonly Run[] = [], minPx = MIN_STRETCH_PX): XScale {
  const linear: XScale = { mode: 'order', width, n, segs: n > 0 ? [{ i0: 0, i1: n, x0: 0, x1: width }] : [], t0: 0, t1: 0, stretch: 1 }
  if (n <= 0 || width <= 0 || runs.length < 2) return linear
  let small = new Set<number>()
  let pBig = width / n
  for (let iter = 0; iter < 16; iter++) {
    const next = new Set<number>()
    runs.forEach((r, k) => { if ((r.i1 - r.i0) * pBig < minPx) next.add(k) })
    if (next.size === 0) return linear
    const smallRows = runs.reduce((a, r, k) => a + (next.has(k) ? r.i1 - r.i0 : 0), 0)
    if (next.size * minPx > width / 2 || smallRows >= n) return linear
    pBig = (width - next.size * minPx) / (n - smallRows)
    const stable = next.size === small.size && [...next].every((k) => small.has(k))
    small = next
    if (stable) break
  }
  const segs: Segment[] = []
  let x = 0, stretch = 1
  runs.forEach((r, k) => {
    const w = small.has(k) ? minPx : (r.i1 - r.i0) * pBig
    if (small.has(k)) stretch = Math.max(stretch, minPx / ((r.i1 - r.i0) * (width / n)))
    const last = segs[segs.length - 1]
    // consecutive runs on the same scale are one segment (continuous ticks)
    if (last && !small.has(k) && !small.has(k - 1) && last.i1 === r.i0) { last.i1 = r.i1; last.x1 = x + w }
    else segs.push({ i0: r.i0, i1: r.i1, x0: x, x1: x + w })
    x += w
  })
  segs[segs.length - 1].x1 = width // rounding
  return { ...linear, segs, stretch }
}

/** The time axis: the rows' [tim - ela, tim] extremes over `width`, or the `domain` (a zoom) when given. */
export function timeScale(rows: readonly number[][], width: number, domain?: { startTim: number; endTim: number } | null): XScale {
  let t0 = Infinity, t1 = -Infinity
  if (domain) { t0 = domain.startTim; t1 = domain.endTim }
  else for (const r of rows) { t0 = Math.min(t0, r[IO.tim] - r[IO.ela]); t1 = Math.max(t1, r[IO.tim]) }
  if (!(t1 > t0)) { t0 = Number.isFinite(t0) ? t0 : 0; t1 = t0 + 1 }
  return { mode: 'time', width, n: rows.length, segs: [], t0, t1, stretch: 1 }
}

/** The segment of an order position (clamped). */
function segOf(xs: XScale, i: number): Segment {
  const s = xs.segs
  let lo = 0, hi = s.length - 1
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].i0 <= i) lo = m; else hi = m - 1 }
  return s[lo]
}

/** x in px of an order position (a row index, fractional allowed): the left edge of its slot. */
export function xOfIndex(xs: XScale, i: number): number {
  if (xs.segs.length === 0) return 0
  const s = segOf(xs, i)
  return s.x0 + ((i - s.i0) * (s.x1 - s.x0)) / Math.max(1, s.i1 - s.i0)
}

/** The order position at x px (inverse of `xOfIndex`), clamped to [0, n]. */
export function indexOfX(xs: XScale, x: number): number {
  const s = xs.segs
  if (s.length === 0) return 0
  let k = 0
  while (k < s.length - 1 && x >= s[k].x1) k++
  const g = s[k]
  const i = g.i0 + ((x - g.x0) * (g.i1 - g.i0)) / Math.max(1e-9, g.x1 - g.x0)
  return Math.max(0, Math.min(xs.n, i))
}

/** x in px of a tim (time mode). */
export const xOfTim = (xs: XScale, tim: number): number => ((tim - xs.t0) / (xs.t1 - xs.t0)) * xs.width
/** The tim at x px (time mode). */
export const timOfX = (xs: XScale, x: number): number => xs.t0 + (Math.max(0, Math.min(xs.width, x)) / xs.width) * (xs.t1 - xs.t0)

/** px per row in the segment of row `i` (order mode). */
const pxPerRow = (xs: XScale, i: number) => { const s = segOf(xs, i); return (s.x1 - s.x0) / Math.max(1, s.i1 - s.i0) }

/** A mark's width in px: 1, or 2 at ≤ 2,000 rows; up to 3 where a widened stretch has the room. */
export function markWidth(xs: XScale, i: number): number {
  const base = xs.n <= 2000 ? 2 : 1
  return xs.mode === 'order' ? Math.max(base, Math.min(3, Math.floor(pxPerRow(xs, i)))) : base
}

export interface Rect { x: number; y: number; w: number; h: number }

/** A panel of few marks (`n` < FEW_MARKS) draws them at least this tall (and 3 px wide), so three single-block reads in 14,000 blocks show. */
export const FEW_MARKS_PX = 5
/** Below this many marks a panel draws them at least 2 px tall. */
export const SPARSE_MARKS = 500

/**
 * The mark of row `i` in its panel: as tall as the blocks it moved (at least 1 px; 2 px in a sparse panel, `FEW_MARKS_PX` in a
 * panel of few marks; centred), at its order slot or its time interval. `p` is a panel (its block axis `ys`) or, for a linear
 * axis, a block range `{ lo, hi }` over `height`. A row the block axis does not show (a packed or zoomed axis) has `h` 0 and
 * `y` NaN.
 */
export function markRect(xs: XScale, rows: readonly number[][], i: number, p: (Pick<IOMapFile, 'lo' | 'hi'> & { n?: number; ys?: YScale }), height: number): Rect {
  const r = rows[i]
  let yTop: number, yBot: number
  if (p.ys) {
    const sp = ySpan(p.ys, r[IO.file], r[IO.block], r[IO.block] + r[IO.blocks])
    if (!sp) return { x: 0, y: NaN, w: 0, h: 0 }
    yTop = sp.top; yBot = sp.bottom
  } else { yTop = yOfBlock(p, height, r[IO.block] + r[IO.blocks]); yBot = yOfBlock(p, height, r[IO.block]) }
  const minH = p.n === undefined ? 1 : p.n < FEW_MARKS ? FEW_MARKS_PX : p.n < SPARSE_MARKS ? 2 : 1
  let y = yTop, h = yBot - yTop
  if (h < minH) { y = (yTop + yBot) / 2 - minH / 2; h = minH }
  let x: number, w: number
  const minW = minH > 1 ? 3 : 0 // and as wide
  if (xs.mode === 'order') { // centred in its slot (a slot is narrower than a pixel when the rows are dense)
    w = Math.max(minW, markWidth(xs, i))
    const x0 = xOfIndex(xs, i), slot = xOfIndex(xs, i + 1) - x0
    x = Math.floor(x0 + Math.max(0, (slot - w) / 2))
  }
  else { const a = xOfTim(xs, r[IO.tim] - r[IO.ela]), b = xOfTim(xs, r[IO.tim]); w = Math.max(minW, markWidth(xs, i), b - a); x = Math.floor(a) }
  return { x, y, w, h }
}

/** Ticks of the x axis: order positions labelled with the wait's place among all matches (× the sampling step), or tims. */
export function xTicks(xs: XScale, map: Pick<IOMap, 'total' | 'rows'>, opts: { base?: number; minGapPx?: number } = {}): { x: number; value: number }[] {
  const gap = opts.minGapPx ?? 90
  const out: { x: number; value: number }[] = []
  if (xs.mode === 'time') {
    const base = opts.base ?? 0, span = xs.t1 - xs.t0
    const step = niceStep(span, Math.max(2, Math.floor(xs.width / gap)))
    for (let t = Math.ceil((xs.t0 - base) / step) * step; base + t <= xs.t1; t += step) out.push({ x: xOfTim(xs, base + t), value: t })
    return out
  }
  const k = sampleStep(map)
  for (const s of xs.segs) {
    const count = (s.i1 - s.i0) * k, w = s.x1 - s.x0
    const step = Math.max(1, niceStep(count, Math.max(1, Math.floor(w / gap)))) // whole waits
    for (let v = Math.ceil((s.i0 * k) / step) * step; v < s.i1 * k; v += step) {
      const x = xOfIndex(xs, v / k)
      if (out.length && x - out[out.length - 1].x < gap * 0.6) continue // the first tick of a widened stretch next to the previous one
      out.push({ x, value: v })
    }
  }
  return out
}

// ---- brackets: the statements' (or phases') stretches over the order ------------------------

export interface Bracket extends Run {
  kind: 'stmt' | 'phase'
  /** statement id, or the phase's label */
  key: number | string
  /** rows of the answer per event in the stretch (for a statement run: its own rows, not the recursive ones inside it) */
  byEvent: Map<ID, number>
}

/** At most this many statement stretches get brackets; with more the phases (contexts' actions) do. */
export const MAX_STMT_BRACKETS = 12
export const MAX_PHASE_BRACKETS = 40

/**
 * The maximal runs of rows of one statement in order. A wait of a deeper (recursive) statement in the same session context belongs
 * to the run it sits in (the QOSD lookup of exp_head$ between two scans breaks nothing), and a run of such waits right before a
 * shallower statement of the same context to that statement's run (recursive SQL of its parse); otherwise a wait at the same or a
 * shallower depth, or of another context, starts a run of its own.
 */
export function stmtRuns(rows: readonly number[][]): Bracket[] {
  const out: (Bracket & { dep: number; ctx: number })[] = []
  rows.forEach((r, i) => {
    const last = out[out.length - 1]
    if (last && (last.key === r[IO.stmt] || (r[IO.dep] > last.dep && r[IO.ctx] === last.ctx))) {
      last.i1 = i + 1
      if (last.key === r[IO.stmt]) last.byEvent.set(r[IO.event], (last.byEvent.get(r[IO.event]) ?? 0) + 1)
      return
    }
    out.push({ kind: 'stmt', key: r[IO.stmt], i0: i, i1: i + 1, byEvent: new Map([[r[IO.event], 1]]), dep: r[IO.dep], ctx: r[IO.ctx] })
  })
  for (let k = out.length - 2; k >= 0; k--) {
    const a = out[k], b = out[k + 1]
    if (a.dep > b.dep && a.ctx === b.ctx) { b.i0 = a.i0; out.splice(k, 1) } // recursive waits before their statement
  }
  return out.map(({ dep: _dep, ctx: _ctx, ...b }) => b)
}

/**
 * The maximal runs of rows whose context has one phase label (`labelOf(ctx)`, e.g. the context's action; '' = none, joins the run
 * before; leading unnamed rows are a run with key ''). Like `stmtRuns` the runs cover the rows without gaps.
 */
export function phaseRuns(rows: readonly number[][], labelOf: (ctx: number) => string): Bracket[] {
  const out: Bracket[] = []
  rows.forEach((r, i) => {
    const l = labelOf(r[IO.ctx])
    const last = out[out.length - 1]
    if (last && (last.key === l || l === '')) { last.i1 = i + 1; last.byEvent.set(r[IO.event], (last.byEvent.get(r[IO.event]) ?? 0) + 1); return }
    out.push({ kind: 'phase', key: l, i0: i, i1: i + 1, byEvent: new Map([[r[IO.event], 1]]) })
  })
  return out
}

/**
 * The bracket rows over the x axis: the statements' runs when there are at most 12 (with the phases above them when those are
 * few and named), else the phases when there are at most 40, else none. `runs` is what the order axis keeps readable.
 */
export function bracketsOf(rows: readonly number[][], labelOf: (ctx: number) => string): { stmts: Bracket[]; phases: Bracket[]; runs: Run[] } {
  const stmts = stmtRuns(rows)
  const phases = phaseRuns(rows, labelOf)
  const named = phases.some((p) => p.key !== '')
  if (stmts.length <= MAX_STMT_BRACKETS) return { stmts, phases: named && phases.length <= MAX_STMT_BRACKETS ? phases : [], runs: stmts }
  if (named && phases.length <= MAX_PHASE_BRACKETS) return { stmts: [], phases, runs: phases }
  return { stmts: [], phases: [], runs: [] }
}

/**
 * Rows for the bracket labels so they do not overlap: each label goes on the first of `maxRows` rows whose previous label ends
 * left of it (labels are left-aligned at the bracket's start, `widthOf` px wide); -1 = no room (the bracket keeps its title).
 */
export function labelRows(spans: readonly { x0: number; x1: number; width: number }[], maxRows = 3, pad = 8): number[] {
  const ends: number[] = []
  return spans.map((s) => {
    for (let k = 0; k < maxRows; k++) {
      if (ends[k] === undefined || ends[k] + pad <= s.x0) { ends[k] = s.x0 + s.width; return k }
    }
    return -1
  })
}

// ---- hit test ---------------------------------------------------------------------------------------

/**
 * The row under (x, y) in a panel: among the panel's rows whose mark is within `slop` px horizontally, the one whose block range
 * holds y, else the nearest vertically (within `slop` px too); the later row on a tie (it is drawn on top). -1 when none.
 */
export function hitTest(xs: XScale, rows: readonly number[][], panel: Panel, x: number, y: number, slop = 3): number {
  let best = -1, bestD = Infinity
  const consider = (i: number) => {
    const m = markRect(xs, rows, i, panel, panel.height)
    if (!(m.h > 0) || x < m.x - slop || x > m.x + m.w + slop) return
    const d = y < m.y ? m.y - y : y > m.y + m.h ? y - (m.y + m.h) : 0
    if (d <= slop && d <= bestD) { best = i; bestD = d }
  }
  if (xs.mode === 'order') {
    const a = Math.floor(indexOfX(xs, x - slop - 3)), b = Math.ceil(indexOfX(xs, x + slop))
    const pr = panel.rows
    let lo = 0, hi = pr.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (pr[m] < a) lo = m + 1; else hi = m }
    for (let k = lo; k < pr.length && pr[k] <= b; k++) consider(pr[k])
  } else {
    for (const i of panel.rows) consider(i)
  }
  return best
}

// ---- drawing ------------------------------------------------------------------------------------

/** The part of a 2-D context `drawBlockMap` uses (a canvas's, or a recording fake in the tests). */
export interface Paint { fillStyle: unknown; globalAlpha: number; fillRect(x: number, y: number, w: number, h: number): void }

export interface PanelColors {
  /** the resolved colour of each `Coloring.tones` entry */
  tones: string[]
  grid: string
  /** extent bands: block runs and their resolved colour */
  bands: { runs: BlockRun[]; color: string }[]
}

/** Alpha of the extent bands; the ruler left of the plot is solid. */
export const BAND_ALPHA = 0.13
export const RULER_PX = 5
/** The ruler sits at x in [-RULER_X, -RULER_X + RULER_PX): the canvas is RULER_X wider than the plot and translated by it. */
export const RULER_X = 8
/** Alpha of the marks a highlight leaves out. */
export const DIM_ALPHA = 0.12

/** The alpha of a density cell of intensity f (0..1): faint at the least, strong at the most, never opaque (the grid and bands show through). */
export const densityAlpha = (f: number): number => (f <= 0 ? 0 : 0.1 + 0.78 * f)

/** The density layer of one panel as `drawBlockMap` paints it: cell rectangles with their intensity, in one resolved colour. */
export interface DensityPaint { rects: readonly { x: number; y: number; w: number; h: number; f: number }[]; color: string }

/**
 * Paints one panel (`width` × `panel.height` px from x = 0; the ruler at negative x, see `RULER_X`): the y grid, a packed axis'
 * gaps, the faint extent bands with their solid ruler, the stretch boundaries, the density cells (`opts.density`), then the marks
 * grouped by colour (one fillStyle per colour; none with `opts.marks` false). With `focus` (per row, 1 = highlighted) the others
 * are painted first and faint. Returns the number of marks painted.
 */
export function drawBlockMap(ctx: Paint, panel: Panel, rows: readonly number[][], xs: XScale, idx: Uint16Array, colors: PanelColors, focus?: Uint8Array | null,
  opts: { density?: DensityPaint | null; marks?: boolean } = {}): number {
  const h = panel.height, w = xs.width
  ctx.globalAlpha = 1
  ctx.fillStyle = colors.grid
  for (const t of yTicks(panel.ys)) ctx.fillRect(0, Math.round(t.y), w, 1)
  if (panel.ys.packed) {
    ctx.globalAlpha = 0.5
    for (const s of panel.ys.segs.slice(1)) ctx.fillRect(0, Math.round(s.y1 + SEG_GAP_PX / 2), w, 1) // the seam between two runs
    ctx.globalAlpha = 1
  }
  if (xs.mode === 'order') for (const s of xs.segs.slice(1)) ctx.fillRect(Math.round(s.x0) - 1, 0, 1, h)
  for (const b of colors.bands) {
    ctx.fillStyle = b.color
    for (const r of b.runs) {
      const sp = ySpan(panel.ys, panel.file, r.lo, r.hi)
      if (!sp) continue
      const bh = Math.max(1, sp.bottom - sp.top)
      ctx.globalAlpha = BAND_ALPHA
      ctx.fillRect(0, sp.top, w, bh)
      ctx.globalAlpha = 0.9
      ctx.fillRect(-RULER_X, sp.top, RULER_PX, bh)
    }
  }
  if (opts.density) {
    ctx.fillStyle = opts.density.color
    for (const r of opts.density.rects) {
      const a = densityAlpha(r.f)
      if (a <= 0) continue
      ctx.globalAlpha = a
      ctx.fillRect(r.x, r.y, r.w, r.h)
    }
  }
  if (opts.marks === false) { ctx.globalAlpha = 1; return 0 }
  const pass = (alpha: number, keep: (i: number) => boolean) => {
    ctx.globalAlpha = alpha
    const byTone: number[][] = colors.tones.map(() => [])
    for (const i of panel.rows) if (keep(i)) byTone[idx[i]]?.push(i)
    let n = 0
    byTone.forEach((list, t) => {
      if (list.length === 0) return
      ctx.fillStyle = colors.tones[t]
      for (const i of list) {
        const m = markRect(xs, rows, i, panel, h)
        if (!(m.h > 0)) continue
        ctx.fillRect(m.x, m.y, m.w, m.h)
        n++
      }
    })
    return n
  }
  let n = 0
  if (focus) { n += pass(DIM_ALPHA, (i) => !focus[i]); n += pass(1, (i) => !!focus[i]) }
  else n = pass(1, () => true)
  ctx.globalAlpha = 1
  return n
}

/** The extent bands of a file panel: each coloured object's block runs in the panel's file, from its non-temp rows. None on other panels. */
export function bandsOf(map: Pick<IOMap, 'rows'>, events: readonly Event[], panel: Pick<Panel, 'file' | 'temp'> & { kind?: Panel['kind'] }, objectTone: Map<number, Tone>): { obj: number; runs: BlockRun[]; blocks: number; tone: Tone }[] {
  if (panel.temp || (panel.kind && panel.kind !== 'file')) return []
  const out: { obj: number; runs: BlockRun[]; blocks: number; tone: Tone }[] = []
  for (const [obj, tone] of objectTone) {
    const runs = extentsOf(map.rows, obj, panel.file, (r) => !isTempEvent(events[r[IO.event]]))
    if (runs.length) out.push({ obj, runs, blocks: runBlocks(runs), tone })
  }
  return out
}

// ---- zoom ----------------------------------------------------------------------------------------

/** A time range (µs, tim). */
export interface TimeRange { startTim: number; endTim: number }

/** The shortest time range the zoom goes to, µs. */
export const MIN_ZOOM_US = 20

/** The rows' time extent: the earliest wait start (tim − ela) to the latest end; null without rows. */
export function timeExtent(rows: readonly number[][]): TimeRange | null {
  if (rows.length === 0) return null
  let a = Infinity, b = -Infinity
  for (const r of rows) { a = Math.min(a, r[IO.tim] - r[IO.ela]); b = Math.max(b, r[IO.tim]) }
  return { startTim: a, endTim: Math.max(b, a + 1) }
}

/**
 * `r` scaled by `factor` (< 1 in, > 1 out) around `at`, which keeps its place on the axis, then kept inside `full` and at
 * least `MIN_ZOOM_US` long. Null when the result covers `full`: no zoom.
 */
export function scaleRange(r: TimeRange, at: number, factor: number, full: TimeRange): TimeRange | null {
  const len = Math.max(MIN_ZOOM_US, (r.endTim - r.startTim) * factor)
  const fullLen = full.endTim - full.startTim
  if (len >= fullLen) return null
  const t = Math.max(0, Math.min(1, (at - r.startTim) / Math.max(1e-9, r.endTim - r.startTim)))
  let a = at - t * len
  a = Math.max(full.startTim, Math.min(full.endTim - len, a))
  return { startTim: a, endTim: a + len }
}

/** `r` moved by `frac` of its length (negative: earlier), kept inside `full`. */
export function panRange(r: TimeRange, frac: number, full: TimeRange): TimeRange {
  const len = r.endTim - r.startTim
  const a = Math.max(full.startTim, Math.min(full.endTim - len, r.startTim + frac * len))
  return { startTim: a, endTim: a + len }
}

/**
 * What a drag on a panel zooms by its shape: sideways the time, up or down the blocks, diagonally both; null while it stays
 * within `flat` px both ways (a click, a little jitter included).
 */
export function dragKind(dx: number, dy: number, flat = 10): 'x' | 'y' | 'xy' | null {
  const ax = Math.abs(dx), ay = Math.abs(dy)
  if (ax < flat && ay < flat) return null
  if (ay < flat) return 'x'
  if (ax < flat) return 'y'
  return 'xy'
}

/** The answer's rows that overlap `range` ([tim − ela, tim] meets it), as an answer: the same object when every row does. */
export function rowsIn(map: IOMap, range: TimeRange | null): IOMap {
  if (!range) return map
  const keep = map.rows.map((r) => r[IO.tim] - r[IO.ela] <= range.endTim && r[IO.tim] >= range.startTim)
  const rows = map.rows.filter((_, i) => keep[i])
  if (rows.length === map.rows.length) return map
  const reads = map.reads && map.reads.length === map.rows.length ? map.reads.filter((_, i) => keep[i]) : undefined
  const k = sampleStep(map)
  const files = new Map<number, IOMapFile>()
  for (const r of rows) {
    const f = files.get(r[IO.file]), lo = r[IO.block], hi = lo + r[IO.blocks]
    if (!f) files.set(r[IO.file], { file: r[IO.file], lo, hi, n: k })
    else { f.lo = Math.min(f.lo, lo); f.hi = Math.max(f.hi, hi); f.n += k }
  }
  return { ...map, rows, total: rows.length * k, files: [...files.values()].sort((a, b) => a.file - b.file), ...(reads ? { reads } : { reads: undefined }) }
}
