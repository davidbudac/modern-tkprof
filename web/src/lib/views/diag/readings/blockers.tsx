// The session cards joined into a tree, shared by the system state (the blocker forest) and the hang analysis (each chain): the final blocker on top, each session
// below it blocked by the one above (docs/mockups/diag-reader/, shots/sysstate-light.png and hang-light.png). A card says who the session is, what it waits for and
// since when, how many sessions it blocks and the statement it runs; its process and its line in the file are links.
import type { ReactNode } from 'react'
import type { DiagSource } from '../../../data/diag'
import type { BlockCard, BlockTree } from '../../../data/diagsys'
import { fmtInt } from '../../../data/format'
import { secs } from '../../../data/diagstack'
import { TraceMark } from '../../../components/DumpMark'
import { LineLink } from './parts'

export const TAG_TEXT: Record<NonNullable<BlockCard['tag']>, { label: string; title: string }> = {
  final: { label: 'final blocker', title: 'The session the sessions below it wait for, directly or through others. It is not blocked itself.' },
  cycle: { label: 'blocks itself', title: 'The direct blockers of this session lead back to it, so the tree is cut here.' },
  victim: { label: 'victim', title: 'The session that wrote this trace: ORA-00060 is raised in one of the sessions of the cycle, and its process writes the dump.' },
  foreign: { label: 'not in this dump', title: 'The dump names this session as a blocker, but it is no process of this dump (another instance, or a session that has ended): only the mention is known.' },
}

/** Whether a node of the outline can be opened from a reading: always in the engine's views, in the standalone report only the nodes it holds. */
export function nodeReach(source: DiagSource): (id: string | undefined) => boolean {
  if (!source.digest) return (id) => !!id
  const held = new Set<string>()
  for (const c of source.preloaded?.values() ?? []) for (const n of c.children) held.add(n.id)
  return (id) => !!id && held.has(id)
}

export interface CardProps {
  card: BlockCard
  source: DiagSource
  goLine(line: number): void
  selectNode(id: string): void
  canOpen(id: string | undefined): boolean
  /** after the wait line (a hang analysis: the timeout) */
  wait?: ReactNode
  /** under the statement (a hang analysis: the details that open) */
  more?: ReactNode
}

/** The statement of a card: its sql_id and text on one line, or the library handle a level that prints no text names, or the command. */
function Statement({ card }: { card: BlockCard }) {
  if (card.sqlText || card.sqlId) {
    return (
      <div className="bt-sql" title={card.sqlText}>
        {card.sqlId ? <span className="rd-mono rd-strong bt-sqlid">{card.sqlId}</span> : null}
        {card.sqlId ? <TraceMark by={{ sqlId: card.sqlId }} /> : null}
        {card.sqlText ? <span className="rd-mono bt-sqlt">{card.sqlText}</span> : null}
      </div>
    )
  }
  if (card.sqlHandle) {
    return (
      <div className="bt-sql dim">
        {card.cmd ? <span>{card.cmd}</span> : null}
        <span>statement at library handle <span className="rd-mono">{card.sqlHandle}</span>; this level prints the handle, not the text</span>
      </div>
    )
  }
  return card.cmd ? <div className="bt-sql dim"><span>{card.cmd}</span></div> : null
}

export function SessionCard({ card, source, goLine, selectNode, canOpen, wait, more }: CardProps) {
  const link = (line: number, text: ReactNode) => <LineLink line={line} text={text} source={source} goLine={goLine} />
  const tag = card.tag ? TAG_TEXT[card.tag] : undefined
  const who = [card.user, card.where].filter(Boolean)
  return (
    <div className={`bt-n${card.tag === 'final' ? ' final' : ''}${card.tag === 'victim' ? ' victim' : ''}${card.tag === 'foreign' ? ' foreign' : ''}`} data-session={card.key}>
      <div className="bt-h">
        <span className="rd-mono rd-strong">{card.key}</span>
        <TraceMark by={{ session: card.key }} />
        {who.length > 0 ? <span className="rd-dim bt-who">{who.join(' · ')}</span> : null}
        {tag ? <span className={`bt-tag${card.tag === 'final' || card.tag === 'victim' ? ' acc' : ''}`} title={tag.title}>{tag.label}</span> : null}
        <span className="rd-grow" />
        {card.procNode && canOpen(card.procNode)
          ? <button type="button" className="rd-lnk" title="Show the reading of this process" onClick={() => selectNode(card.procNode!)}>process {card.procPid}</button>
          : card.procPid !== undefined ? <span className="rd-lnk off" title="The reading of this process is not in this report">process {card.procPid}</span> : null}
        {card.line ? link(card.line, `line ${fmtInt(card.line)}`) : null}
      </div>
      {card.tag === 'foreign' || card.noWait ? null : (
        <div className="bt-w">
          {card.event
            ? <>waiting for <span className="rd-mono">&apos;{card.event}&apos;</span>{card.waitSec !== undefined ? <span className="rd-dim"> · {secs(card.waitSec)}</span> : null}</>
            : <span className="rd-dim">{card.inWait === false ? 'not in a wait' : 'no wait recorded'}</span>}
          {wait}
          {card.blocks ? <span className="rd-dim"> · blocks {fmtInt(card.blocks)} {card.blocks === 1 ? 'session' : 'sessions'}</span> : null}
        </div>
      )}
      {card.alsoBlockedBy && card.alsoBlockedBy.length > 0 ? <div className="bt-w rd-dim">also blocked by <span className="rd-mono">{card.alsoBlockedBy.join(', ')}</span>; the tree shows it under the first blocker</div> : null}
      {card.tag === 'foreign' ? null : <Statement card={card} />}
      {more}
    </div>
  )
}

/** A forest of cards: each child list indented under its parent with the hairline that joins them. */
export function BlockerTree<R>({ forest, props, extra }: { forest: readonly BlockTree<R>[]; props: Omit<CardProps, 'card' | 'wait' | 'more'>; extra?: (n: BlockTree<R>) => { wait?: ReactNode; more?: ReactNode } }) {
  const go = (n: BlockTree<R>): ReactNode => (
    <li key={n.card.key + ':' + n.card.line}>
      <SessionCard card={n.card} {...props} {...extra?.(n)} />
      {n.children.length > 0 ? <ul>{n.children.map(go)}</ul> : null}
    </li>
  )
  return <ul className="bt" aria-label="Blocker tree">{forest.map(go)}</ul>
}
