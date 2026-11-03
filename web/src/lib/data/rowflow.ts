// Row flow: one STAT dump as a Sankey (views/RowFlow.tsx). The tree, the self numbers and the whole layout
// (positions, band paths, label boxes) are computed here, so they are unit-tested without a DOM.
import type { PlanLine } from './types'
import { fmtCompact, fmtDur, fmtInt } from './format'

export interface FlowNode {
  line: PlanLine
  /** position of the line in the dump: its STAT line is `plan.line + index`; -1 for the statement line (id 0) that several
   *  top-level row sources hang off, which STAT does not print */
  index: number
  /** depth in the tree (root 0); `line.depth` for a well-formed dump */
  depth: number
  parent: FlowNode | null
  /** ordered by pos, then id */
  children: FlowNode[]
  /** A-Rows = line.rows (total over all starts) */
  rows: number
  /** Σ children.rows */
  inRows: number
  /** E-Rows: line.card if ≥ 0 (STAT lines with statistics), else line.eRows if ≥ 0, else -1 */
  est: number
  /**
   * The estimate comparable with `rows`: E-Rows is per start, so a row source started S > 1 times (the inner side of a
   * nested loop) compares est × S; below an iterator (INLIST ITERATOR, PARTITION …, PX BLOCK ITERATOR) the card already
   * covers all iterations and stays as it is. -1 = no estimate, or a row source that never started here (starts 0: the PX
   * slaves' lines in the coordinator's dump), which has no actual rows to compare with.
   */
  estRows: number
  inclusiveUs: number
  /** max(0, timeUs - Σ children.timeUs); 0 when the parent reports less than its children */
  selfUs: number
  selfCr: number
  selfPr: number
  selfPw: number
  /** the line reports less time than its children (sampled timings): noted */
  clamped: boolean
}

export interface RowFlow {
  /** parentId 0 (or a missing parent); several → the first, noted */
  root: FlowNode | null
  /** DFS pre-order from the root: the layout order */
  nodes: FlowNode[]
  maxDepth: number
  /** root inclusive */
  totalUs: number
  /** Σ selfUs over the tree: the denominator of a node's share (above totalUs when a clamped parent reports less than its children) */
  selfSumUs: number
  /** the largest flow at any node: max over nodes of max(rows, inRows) */
  maxRows: number
  /** any line.hasStats */
  hasStats: boolean
  notes: string[]
}

export const NO_STATS_NOTE = 'No row-source statistics in this plan dump (statistics_level basic, or the cursor was not closed before the dump): the flow needs rows and times per line.'

const ITERATOR = /^(INLIST ITERATOR|PARTITION |PX BLOCK ITERATOR)/

/** The tree of one dump's lines (`doc.planLines.slice(plan.first, plan.first + plan.n)`), with self numbers and notes. */
export function rowFlow(lines: readonly PlanLine[]): RowFlow {
  const notes: string[] = []
  const hasStats = lines.some((l) => l.hasStats)
  if (lines.length > 0 && !hasStats) notes.push(NO_STATS_NOTE)
  // a repeated id ends the dump: two STAT blocks glued together
  const byId = new Map<number, number>()
  let n = lines.length
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i].id
    if (byId.has(id)) {
      notes.push(`id ${id} appears twice (two STAT blocks in one dump?): the flow stops at the repeat, ${lines.length - i} of ${lines.length} lines left out.`)
      n = i
      break
    }
    byId.set(id, i)
  }
  const all: FlowNode[] = []
  for (let i = 0; i < n; i++) {
    const l = lines[i]
    const est = l.hasStats && l.card >= 0 ? l.card : (l.eRows ?? -1) >= 0 ? (l.eRows as number) : -1
    all.push({
      line: l, index: i, depth: 0, parent: null, children: [], rows: l.rows, inRows: 0, est, estRows: est,
      inclusiveUs: l.timeUs, selfUs: 0, selfCr: 0, selfPr: 0, selfPw: 0, clamped: false,
    })
  }
  const top: FlowNode[] = [], orphans: FlowNode[] = []
  for (const node of all) {
    const p = node.line.parentId
    const pi = p === 0 ? undefined : byId.get(p)
    if (p === 0) top.push(node)
    else if (pi === undefined || pi >= n) orphans.push(node)
    else all[pi].children.push(node)
  }
  for (const node of all) node.children.sort((a, b) => a.line.pos - b.line.pos || a.line.id - b.line.id)
  // Several lines with parent 0 are siblings under the statement line (id 0), which STAT does not print: a scalar
  // subquery of the select list beside the main query (the last one, whose rows reach the client).
  let statement: FlowNode | null = null
  if (top.length > 1) {
    top.sort((a, b) => a.line.pos - b.line.pos || a.line.id - b.line.id)
    const sum = (k: 'timeUs' | 'cr' | 'pr' | 'pw') => top.reduce((a, x) => a + x.line[k], 0)
    const main = top[top.length - 1].line
    const line: PlanLine = {
      plan: main.plan, id: 0, parentId: -1, pos: 0, depth: -1, obj: 0, op: 'STATEMENT', object: '', rows: main.rows, starts: 1,
      cr: sum('cr'), pr: sum('pr'), pw: sum('pw'), timeUs: sum('timeUs'), cost: -1, size: -1, card: -1, hasStats,
    }
    statement = { line, index: -1, depth: 0, parent: null, children: top, rows: line.rows, inRows: 0, est: -1, estRows: -1, inclusiveUs: line.timeUs, selfUs: 0, selfCr: 0, selfPr: 0, selfPw: 0, clamped: false }
    notes.push(`${top.length} row sources at the top (a scalar subquery beside the main query, or alike): they hang off the statement, id 0, which the trace does not print; its rows are the last one's.`)
  }
  const roots: FlowNode[] = statement ? [statement, ...orphans] : [...top, ...orphans]

  // reachability from every root: what no root reaches hangs off a cycle
  const seen = new Set<FlowNode>()
  const walk = (r: FlowNode, visit?: (x: FlowNode) => void) => {
    const stack: FlowNode[] = [r]
    while (stack.length) {
      const x = stack.pop() as FlowNode
      if (seen.has(x)) continue
      seen.add(x)
      visit?.(x)
      for (let k = x.children.length - 1; k >= 0; k--) {
        const c = x.children[k]
        if (seen.has(c)) continue
        c.parent = x
        c.depth = x.depth + 1
        stack.push(c)
      }
    }
  }
  const root = roots[0] ?? null
  const nodes: FlowNode[] = []
  if (root) walk(root, (x) => nodes.push(x))
  for (const r of roots.slice(1)) walk(r)
  const lost = all.filter((x) => !seen.has(x))
  if (lost.length > 0) {
    const ids = lost.map((x) => x.line.id).sort((a, b) => a - b)
    notes.push(`cycle at id ${ids[0]}: ${lost.length} line${lost.length === 1 ? '' : 's'} never reach a root and ${lost.length === 1 ? 'is' : 'are'} left out.`)
  }
  const left = roots.slice(1).filter((r) => r.line.parentId !== 0)
  if (left.length > 0) {
    const ids = left.map((r) => r.line.id)
    notes.push(`${left.length} line${left.length === 1 ? '' : 's'} whose parent is not in the dump (id ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ' …' : ''}): the flow shows the tree of id ${roots[0].line.id} only.`)
  }
  // a reached node's children are reached too, except the ones a cycle or a duplicate visit cut off
  for (const x of nodes) x.children = x.children.filter((c) => c.parent === x)

  let maxDepth = 0, maxRows = 0
  const clamped: FlowNode[] = []
  for (const x of nodes) {
    let t = 0, cr = 0, pr = 0, pw = 0, rows = 0
    for (const c of x.children) { t += c.line.timeUs; cr += c.line.cr; pr += c.line.pr; pw += c.line.pw; rows += c.rows }
    const l = x.line
    x.inRows = rows
    x.selfUs = Math.max(0, l.timeUs - t)
    x.clamped = l.hasStats && l.timeUs < t
    x.selfCr = Math.max(0, l.cr - cr)
    x.selfPr = Math.max(0, l.pr - pr)
    x.selfPw = Math.max(0, l.pw - pw)
    if (x.clamped) clamped.push(x)
    let iterated = false
    for (let a = x.parent; a && !iterated; a = a.parent) iterated = ITERATOR.test(a.line.op)
    x.estRows = x.est < 0 || notStarted(x) ? -1 : l.starts > 1 && !iterated ? x.est * l.starts : x.est
    maxDepth = Math.max(maxDepth, x.depth)
    maxRows = Math.max(maxRows, x.rows, rows)
  }
  if (clamped.length > 0) {
    const shown = clamped.slice(0, 3).map((x) => `${opText(x.line)} (id ${x.line.id}) reports ${fmtDur(x.line.timeUs)}, less than its children (${fmtDur(x.children.reduce((a, c) => a + c.line.timeUs, 0))})`)
    const more = clamped.length > 3 ? ` and ${clamped.length - 3} more` : ''
    notes.push(`${shown.join('; ')}${more}: row-source timings are sampled, so ${clamped.length === 1 ? 'its' : 'their'} self time is shown as 0 (marked *).`)
  }
  if (hasStats) {
    const idle = nodes.filter(notStarted).length
    if (idle > 0 && nodes.some((x) => x.line.op.startsWith('PX '))) {
      notes.push(`PX: ${idle} row source${idle === 1 ? '' : 's'} ran in the slave processes and show${idle === 1 ? 's' : ''} 0 starts here; their rows and times are in the slaves' trace files.`)
    } else if (idle > 0) {
      notes.push(`${idle} row source${idle === 1 ? '' : 's'} never started (starts 0): no rows, no time.`)
    }
  }
  const selfSumUs = nodes.reduce((a, x) => a + x.selfUs, 0)
  return { root, nodes, maxDepth, totalUs: root ? root.inclusiveUs : 0, selfSumUs, maxRows, hasStats, notes }
}

/** A row source with statistics that never started (starts 0): no rows, no time, nothing to compare an estimate with. */
export function notStarted(x: FlowNode): boolean {
  return x.index >= 0 && x.line.hasStats && x.line.starts === 0
}

/** The operation and object of a line, as one label ("HASH JOIN", "TABLE ACCESS FULL MTK_ORDERS"). */
export function opText(l: PlanLine): string {
  const op = l.op.replace(/\s+/g, ' ').trim()
  return l.object && !op.endsWith(' ' + l.object) ? `${op} ${l.object}` : op
}

/** The self-time bin of the node fill: < 1 ms, 1 to 10 ms, 10 to 100 ms, 0.1 to 1 s, ≥ 1 s. */
export function toneOf(selfUs: number): 0 | 1 | 2 | 3 | 4 {
  return selfUs < 1e3 ? 0 : selfUs < 1e4 ? 1 : selfUs < 1e5 ? 2 : selfUs < 1e6 ? 3 : 4
}
export const TONE_LABELS = ['< 1 ms', '1–10 ms', '10–100 ms', '0.1–1 s', '≥ 1 s'] as const

export type FlowScale = 'sqrt' | 'linear'

/** Rows → px: `maxBand` px for `maxRows`; sqrt keeps a 1-row lookup visible next to a 10 M-row scan, linear is proportional. */
export function bandScale(scale: FlowScale, maxRows: number, maxBand: number): (rows: number) => number {
  const top = Math.max(1, maxRows)
  return scale === 'linear'
    ? (v) => (v <= 0 ? 0 : (maxBand * v) / top)
    : (v) => (v <= 0 ? 0 : maxBand * Math.sqrt(v / top))
}

/** A label box in figure coordinates (`align` end = right-aligned text ending at `x + w`). */
export interface LabelBox { x: number; y: number; w: number; h: number; align: 'end' | 'center' }
export interface FlowNodeBox { node: FlowNode; x: number; y: number; w: number; h: number; col: number; tone: 0 | 1 | 2 | 3 | 4; label: LabelBox }
/** "rows · est. N" on a band: centred at (x, y); `inside` = written on the band, else just above it. */
export interface BandLabel { x: number; y: number; w: number; text: string; inside: boolean }
export interface FlowLink {
  from: FlowNode
  to: FlowNode | 'client'
  path: string
  /** the dashed ghost at the estimate's width (same slot); null without an estimate */
  estPath: string | null
  width: number
  estWidth: number
  /** the estimate is wider than the figure's scale allows: the ghost is cut at 1.5 × maxBand */
  estClipped: boolean
  label: BandLabel | null
}
export interface FlowLayout {
  width: number
  height: number
  /** maxDepth + 2 (the client bar is the last column) */
  columns: number
  colStep: number
  nodes: FlowNodeBox[]
  links: FlowLink[]
  /** the client bar; `text` its second label line (the root's rows) */
  client: { x: number; y: number; w: number; h: number; label: LabelBox; text: string } | null
}

export interface FlowLayoutOptions {
  /** the room there is: the figure fills it, wider only when the columns would be narrower than nodeW + colGap */
  width: number
  scale: FlowScale
  /** bar width (12) */
  nodeW?: number
  /** the least gap between two columns (44) */
  colGap?: number
  /** between two stacked subtrees (14) */
  rowGap?: number
  /** the thinnest band (1.5 px): a 1-row band stays visible */
  minBand?: number
  /** the thickest flow; default `defaultMaxBand(flow.maxRows)`: 29 px for 1 row to 120 px from 1 M rows */
  maxBand?: number
  /** the two label lines of a node (30 px) */
  labelH?: number
}

const MAX_STEP = 300
const PAD = 6
/** average advance of the label fonts (11 px tabular numbers, 12 px semibold names) */
const CH_SMALL = 6.3, CH_HEAD = 7.1, BAND_LABEL_H = 15

/**
 * Columns right to left by depth (leaves left: column = maxDepth - depth; the client bar last); within a column the nodes
 * stack in DFS order, each subtree in its own vertical slot, so no two bands cross. A node is as tall as its larger flow
 * (rows out or rows in) and at least as tall as its children's bands stacked (with sqrt they are wider than the sum's
 * band); a leaf's label sits to its left, an inner node's above it, both inside the node's slot.
 */
export function flowLayout(flow: RowFlow, o: FlowLayoutOptions): FlowLayout {
  const nodeW = o.nodeW ?? 12, colGap = o.colGap ?? 44, rowGap = o.rowGap ?? 14, minBand = o.minBand ?? 1.5
  const maxBand = o.maxBand ?? defaultMaxBand(flow.maxRows), labelH = o.labelH ?? 30
  const columns = flow.maxDepth + 2
  const root = flow.root
  if (!root) return { width: Math.max(0, o.width), height: 0, columns, colStep: 0, nodes: [], links: [], client: null }
  // the leaves' labels sit left of column 0: room for the widest, taken from what the columns leave at their widest
  // (or up to 30 % of the width), never less than 96 px
  const base = Math.min(240, Math.max(96, o.width * 0.24))
  const need = flow.nodes.reduce((a, x) => (x.children.length ? a : Math.max(a, labelTextW(x) + 6)), 0)
  const room = o.width - PAD - nodeW - (columns - 1) * MAX_STEP
  const gutter = Math.round(Math.max(base, Math.min(need, Math.max(room, o.width * 0.3))))
  const colStep = Math.min(MAX_STEP, Math.max(nodeW + colGap, (o.width - PAD - gutter - nodeW) / (columns - 1)))
  const width = gutter + (columns - 1) * colStep + nodeW + PAD
  const s = bandScale(o.scale, flow.maxRows, maxBand)
  const bw = (rows: number) => Math.max(minBand, s(rows))
  const colOf = (x: FlowNode) => flow.maxDepth - x.depth
  const xOf = (col: number) => gutter + col * colStep

  // heights, then the slots bottom-up
  const h = new Map<FlowNode, number>(), slotH = new Map<FlowNode, number>(), barOff = new Map<FlowNode, number>(), kidOff = new Map<FlowNode, number>()
  for (let i = flow.nodes.length - 1; i >= 0; i--) {
    const x = flow.nodes[i]
    const stacked = x.children.reduce((a, c) => a + bw(c.rows), 0)
    const hx = Math.max(2, s(Math.max(x.rows, x.inRows)), stacked)
    h.set(x, hx)
    if (x.children.length === 0) {
      const H = Math.max(hx, labelH)
      slotH.set(x, H); barOff.set(x, (H - hx) / 2); kidOff.set(x, 0)
    } else {
      const span = x.children.reduce((a, c) => a + (slotH.get(c) as number), 0) + rowGap * (x.children.length - 1)
      const off = Math.max(0, labelH + hx / 2 - span / 2)
      const bar = off + span / 2 - hx / 2
      slotH.set(x, Math.max(off + span, bar + hx)); barOff.set(x, bar); kidOff.set(x, off)
    }
  }
  const y = new Map<FlowNode, number>()
  const place = (x: FlowNode, top: number) => {
    y.set(x, top + (barOff.get(x) as number))
    let cur = top + (kidOff.get(x) as number)
    for (const c of x.children) { place(c, cur); cur += (slotH.get(c) as number) + rowGap }
  }
  place(root, 0)

  const est = (rows: number) => {
    const w = Math.max(minBand, s(rows))
    return w > 1.5 * maxBand ? { w: 1.5 * maxBand, clipped: true } : { w, clipped: false }
  }
  // geometry before the vertical shift
  interface Raw { from: FlowNode; to: FlowNode | 'client'; x1: number; x2: number; a1: number; a2: number; t: number; te: number; clipped: boolean; hasEst: boolean }
  const raws: Raw[] = []
  for (const p of flow.nodes) {
    if (p.children.length === 0) continue
    const hp = h.get(p) as number
    let entry = (y.get(p) as number) + (hp - p.children.reduce((a, c) => a + bw(c.rows), 0)) / 2
    for (const c of p.children) {
      const t = bw(c.rows)
      const cy = (y.get(c) as number) + (h.get(c) as number) / 2
      const e = est(c.estRows)
      raws.push({ from: c, to: p, x1: xOf(colOf(c)) + nodeW, x2: xOf(colOf(p)), a1: cy - t / 2, a2: entry, t, te: e.w, clipped: e.clipped, hasEst: c.estRows >= 0 })
      entry += t
    }
  }
  const rootCy = (y.get(root) as number) + (h.get(root) as number) / 2
  const tRoot = bw(root.rows)
  const eRoot = est(root.estRows)
  const clientX = xOf(columns - 1), clientH = Math.max(4, tRoot)
  raws.push({ from: root, to: 'client', x1: xOf(colOf(root)) + nodeW, x2: clientX, a1: rootCy - tRoot / 2, a2: rootCy - tRoot / 2, t: tRoot, te: eRoot.w, clipped: eRoot.clipped, hasEst: root.estRows >= 0 })

  // labels: leaves to the left (the slot is empty there), inner nodes above, the client's right-aligned above its bar
  const nodeBoxes: FlowNodeBox[] = flow.nodes.map((x) => {
    const col = colOf(x), nx = xOf(col), ny = y.get(x) as number, hx = h.get(x) as number
    let label: LabelBox
    if (x.children.length === 0) label = { x: 0, y: ny + hx / 2 - labelH / 2, w: Math.max(0, nx - 6), h: labelH, align: 'end' }
    else {
      const w = Math.max(0, colStep - 8)
      label = { x: Math.min(Math.max(0, nx + nodeW / 2 - w / 2), Math.max(0, width - w)), y: ny - labelH, w, h: labelH, align: 'center' }
    }
    return { node: x, x: nx, y: ny, w: nodeW, h: hx, col, tone: toneOf(x.selfUs), label }
  })
  // the client's label above its bar, or under it where the root's label already takes that place
  type Box = { x: number; y: number; w: number; h: number }
  const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  const taken: Box[] = nodeBoxes.map((b) => textBox(b))
  // (never wider than the room right of the root's bar)
  const clientLabelW = Math.max(0, Math.min(Math.max(72, colStep / 2 - 4), colStep - 4))
  const clientY = rootCy - clientH / 2
  const clientLabel: LabelBox = { x: width - PAD - clientLabelW, y: clientY - labelH, w: clientLabelW, h: labelH, align: 'end' }
  if (nodeBoxes.some((b) => overlaps(b.label, clientLabel))) clientLabel.y = clientY + clientH + 2
  const text = clientSubline(root, clientLabelW - 4)
  const client = { x: clientX, y: clientY, w: nodeW, h: clientH, label: clientLabel, text }
  const clientText = Math.min(clientLabelW, Math.max(6 * CH_HEAD, text.length * CH_SMALL) + 4)
  taken.push({ x: width - PAD - clientText, y: clientLabel.y, w: clientText, h: labelH })

  // band labels where they fit and collide with nothing written
  const hit = (a: Box) => taken.some((b) => overlaps(a, b))
  const labels = raws.map((r): BandLabel | null => {
    const room = r.x2 - r.x1 - 12
    const rows = r.from.rows, e = r.from.estRows
    const idle = notStarted(r.from)
    const texts = [
      `${fmtInt(rows)} row${rows === 1 ? '' : 's'} · ${e >= 0 ? `est. ${fmtInt(e)}` : idle ? 'not started' : 'no estimate'}`,
      `${fmtCompact(rows)} · ${e >= 0 ? `est. ${fmtCompact(e)}` : idle ? 'not started' : 'no est.'}`,
      fmtCompact(rows),
    ]
    const inside = r.t >= BAND_LABEL_H
    // a point of the band's top edge at parameter u of its cubic (u 0.5 = the middle of the band)
    const at = (u: number) => ({ x: r.x1 + (r.x2 - r.x1) * (1.5 * u * (1 - u) + u ** 3), top: r.a1 + (r.a2 - r.a1) * (3 * u * u - 2 * u ** 3) })
    // the longest text that fits the room and collides with nothing: in the middle, else a little left or right of it;
    // on a band thicker than the label, else lower or higher within the band; on a thin one above it, else under it.
    // A shorter text may clear what a long one hits.
    const slack = inside ? (r.t - BAND_LABEL_H) / 2 : 0
    for (const text of texts) {
      const w = text.length * CH_SMALL + 8
      if (w > room) continue
      for (const u of [0.5, 0.38, 0.62]) {
        const p = at(u)
        if (p.x - w / 2 < r.x1 + 6 || p.x + w / 2 > r.x2 - 6) continue
        const cy = inside ? p.top + r.t / 2 : p.top - BAND_LABEL_H / 2 - 1
        const ys = inside ? (slack > 0.5 ? [cy, cy + slack, cy - slack] : [cy]) : [cy, p.top + r.t + BAND_LABEL_H / 2 + 1]
        for (const y of ys) {
          const box = { x: p.x - w / 2, y: y - BAND_LABEL_H / 2, w, h: BAND_LABEL_H }
          if (hit(box)) continue
          taken.push(box)
          return { x: p.x, y, w, text, inside }
        }
      }
    }
    return null
  })

  // shift everything so the top-most box sits at PAD
  let minY = Infinity, maxY = -Infinity
  const span = (top: number, bottom: number) => { minY = Math.min(minY, top); maxY = Math.max(maxY, bottom) }
  for (const b of nodeBoxes) { span(b.y, b.y + b.h); span(b.label.y, b.label.y + b.label.h) }
  for (const r of raws) span(Math.min(r.a1, r.a2, r.a1 + r.t / 2 - r.te / 2, r.a2 + r.t / 2 - r.te / 2), Math.max(r.a1 + r.t, r.a2 + r.t, r.a1 + r.t / 2 + r.te / 2, r.a2 + r.t / 2 + r.te / 2))
  span(client.y, client.y + client.h); span(client.label.y, client.label.y + client.label.h)
  for (const l of labels) if (l) span(l.y - BAND_LABEL_H / 2, l.y + BAND_LABEL_H / 2)
  const dy = PAD - minY
  for (const b of nodeBoxes) { b.y += dy; b.label.y += dy }
  client.y += dy; client.label.y += dy
  const links: FlowLink[] = raws.map((r, i) => {
    const l = labels[i]
    const m1 = r.a1 + r.t / 2 + dy, m2 = r.a2 + r.t / 2 + dy
    return {
      from: r.from, to: r.to, width: r.t, estWidth: r.hasEst ? r.te : 0, estClipped: r.hasEst && r.clipped,
      path: band(r.x1, r.a1 + dy, r.x2, r.a2 + dy, r.t),
      estPath: r.hasEst ? band(r.x1, m1 - r.te / 2, r.x2, m2 - r.te / 2, r.te) : null,
      label: l ? { ...l, y: l.y + dy } : null,
    }
  })
  return { width, height: maxY - minY + 2 * PAD, columns, colStep, nodes: nodeBoxes, links, client }
}

/** The thickest band of a figure: grows with the decades of its largest flow, so a 5-row plan is not drawn as thick as a 100 k-row one. */
export function defaultMaxBand(maxRows: number): number {
  return Math.min(120, 24 + 16 * Math.log10(1 + Math.max(0, maxRows)))
}

/** The width a node's two label lines take (estimated from their length). */
function labelTextW(x: FlowNode): number {
  const head = (String(x.line.id).length + 1) * CH_SMALL + opText(x.line).length * CH_HEAD
  return Math.max(head, nodeSubline(x).length * CH_SMALL) + 4
}

/** The box a node's label text takes, for the band labels' collision test. */
function textBox(b: FlowNodeBox): { x: number; y: number; w: number; h: number } {
  const w = Math.min(b.label.w, labelTextW(b.node))
  const x = b.label.align === 'end' ? b.label.x + b.label.w - w : b.label.x + (b.label.w - w) / 2
  return { x, y: b.label.y, w, h: b.label.h }
}

/** The second label line of a node: "self 604 ms · pr 5,612 · pw 276" (self I/O only; starts when more than one). */
export function nodeSubline(x: FlowNode): string {
  if (notStarted(x)) return 'not started'
  const parts = [`self ${x.clamped ? '0 ms*' : fmtDur(x.selfUs)}`]
  if (x.selfPr > 0) parts.push(`pr ${fmtInt(x.selfPr)}`)
  if (x.selfPw > 0) parts.push(`pw ${fmtInt(x.selfPw)}`)
  if (x.line.starts > 1) parts.push(`${fmtCompact(x.line.starts)} starts`)
  return parts.join(' · ')
}

/** The client bar's second label line: the root's rows ("100,001 rows", or "100K rows" when that does not fit `room` px). */
export function clientSubline(root: FlowNode, room = Infinity): string {
  const unit = ` row${root.rows === 1 ? '' : 's'}`
  const full = fmtInt(root.rows) + unit
  return full.length * CH_SMALL <= room ? full : fmtCompact(root.rows) + unit
}

const r1 = (v: number) => Math.round(v * 10) / 10

/** A band of thickness t from (x1, a1) on the left to (x2, a2) on the right: two cubic edges with horizontal tangents. */
function band(x1: number, a1: number, x2: number, a2: number, t: number): string {
  const xm = r1((x1 + x2) / 2)
  return `M${r1(x1)},${r1(a1)} C${xm},${r1(a1)} ${xm},${r1(a2)} ${r1(x2)},${r1(a2)} L${r1(x2)},${r1(a2 + t)} C${xm},${r1(a2 + t)} ${xm},${r1(a1 + t)} ${r1(x1)},${r1(a1 + t)} Z`
}

/** The nodes a selection highlights: its path to the root and its subtree. */
export function flowPath(node: FlowNode): Set<FlowNode> {
  const out = new Set<FlowNode>()
  for (let a: FlowNode | null = node; a; a = a.parent) out.add(a)
  const stack = [...node.children]
  while (stack.length) { const x = stack.pop() as FlowNode; if (out.has(x)) continue; out.add(x); stack.push(...x.children) }
  return out
}
