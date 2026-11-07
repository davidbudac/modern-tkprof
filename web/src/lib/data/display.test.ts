import { describe, expect, it } from 'vitest'
import { LINES_PREFS_DEFAULTS } from '../state/linesPrefs'
import { deltaChipParts, displayBadge, fmtMs, panelAfter, PANEL_TABS, SHOW_TOGGLES } from './display'

describe('the Display button badge', () => {
  const D = LINES_PREFS_DEFAULTS
  it('is 0 with the defaults', () => expect(displayBadge(D, D)).toBe(0))
  it('counts each Show toggle that differs, the gap ticks threshold and every dimmed group', () => {
    expect(displayBadge({ ...D, wrap: true, heat: false }, D)).toBe(2)
    expect(displayBadge({ ...D, gapMs: 0 }, D)).toBe(1)
    expect(displayBadge({ ...D, mute: ['waits', 'binds'] }, D)).toBe(2)
    expect(displayBadge({ ...D, wrap: true, gapMs: 250, mute: ['stat'] }, D)).toBe(3)
  })
  it('does not count the settings that have their own sign (the Δ filter, the lane colours, Fold repeats, the Δ column)', () => {
    expect(displayBadge({ ...D, ...({ deltaMode: 'filter', laneColor: 'dur', foldRepeats: true, rdDelta: false } as object) }, D)).toBe(0)
  })
  it('lists the toggles the View menu had', () => {
    expect(SHOW_TOGGLES.map((t) => t.key)).toEqual(['wrap', 'heat', 'strip', 'links', 'hints', 'clock', 'delta'])
  })
})

describe('the Δ filter chip', () => {
  const text = (...a: Parameters<typeof deltaChipParts>) => { const p = deltaChipParts(...a); return p.what + p.doing }
  it('says the threshold, the mode and the count once it is known', () => {
    expect(text('filter', 10, 34)).toBe('Δ ≥ 10 ms · filter · 34')
    expect(text('highlight', 10, 1234)).toBe('Δ ≥ 10 ms · highlight · 1,234')
  })
  it('has no count until the engine has answered, and a + when more rows qualify than the list holds', () => {
    expect(text('filter', 250)).toBe('Δ ≥ 250 ms · filter')
    expect(text('filter', 0.5, 100_000, true)).toBe('Δ ≥ 500 µs · filter · 100,000+')
  })
  it('is in two parts, what it is and what it is doing, so a narrow bar can keep the first', () => {
    expect(deltaChipParts('filter', 10, 34)).toEqual({ what: 'Δ ≥ 10 ms', doing: ' · filter · 34' })
  })
  it('writes the threshold in seconds from 1000 ms', () => {
    expect(fmtMs(1500)).toBe('1.5 s')
    expect(fmtMs(2)).toBe('2 ms')
  })
})

describe('the side panel and the Display tab', () => {
  const closed = { open: false, tab: 'hits' as const, last: 'hits' as const }
  it('Display is a tab of the panel, last', () => expect(PANEL_TABS[PANEL_TABS.length - 1]).toMatchObject({ tab: 'display', label: 'Display' }))
  it('every tab has a name and a tooltip: the panel shows icons', () => { for (const t of PANEL_TABS) { expect(t.label).not.toBe(''); expect(t.title).not.toBe('') } })
  it('the Display button opens the panel on Display, and closes it when it is already on Display', () => {
    expect(panelAfter(closed, 'display')).toEqual({ open: true, tab: 'display' })
    expect(panelAfter({ open: true, tab: 'line', last: 'line' }, 'display')).toEqual({ open: true, tab: 'display' })
    expect(panelAfter({ open: true, tab: 'display', last: 'line' }, 'display')).toEqual({ open: false, tab: 'display' })
  })
  it('the panel button closes an open panel, and opens a closed one at the tab it showed', () => {
    expect(panelAfter({ open: true, tab: 'bookmarks', last: 'bookmarks' })).toEqual({ open: false, tab: 'bookmarks' })
    expect(panelAfter(closed)).toEqual({ open: true, tab: 'hits' })
  })
  it('the panel button never opens on Display: it opens at the last other tab', () => {
    expect(panelAfter({ open: false, tab: 'display', last: 'outline' })).toEqual({ open: true, tab: 'outline' })
    expect(panelAfter({ open: true, tab: 'display', last: 'outline' })).toEqual({ open: false, tab: 'display' })
  })
  it('a tab key (i for the Line tab) closes the panel when it is already there, else opens it at that tab', () => {
    expect(panelAfter({ open: true, tab: 'line', last: 'line' }, 'line')).toEqual({ open: false, tab: 'line' })
    expect(panelAfter({ open: true, tab: 'display', last: 'line' }, 'line')).toEqual({ open: true, tab: 'line' })
  })
})
