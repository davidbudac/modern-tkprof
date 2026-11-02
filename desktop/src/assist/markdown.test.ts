import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, mtkprofLinks, parseMarkdown, parseInline, type ChipRenderer } from './markdown'

const chips: string[] = []
const chip: ChipRenderer = (hash, label: ReactNode, key) => {
  chips.push(hash)
  return createElement('button', { key, 'data-chip': hash }, label)
}
const html = (text: string) => {
  chips.length = 0
  return renderToStaticMarkup(createElement(Markdown, { text, chip }))
}

describe('markdown: no HTML path', () => {
  it('shows <script> and raw HTML as text', () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> and <b>bold</b>\n\n<div onclick="x()">hi</div>')
    expect(out).not.toMatch(/<script|<img|<b>|<div onclick/)
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(out).toContain('&lt;b&gt;bold&lt;/b&gt;')
  })

  it('keeps markup in code as text too', () => {
    const out = html('`<img src=x>`\n\n```html\n<script>x</script>\n```')
    expect(out).toContain('<code>&lt;img src=x&gt;</code>')
    expect(out).toContain('<pre class="md-code" data-lang="html"><code>&lt;script&gt;x&lt;/script&gt;</code></pre>')
  })
})

describe('markdown: links', () => {
  it('makes anchors of https links only and chips of mtkprof links', () => {
    const out = html([
      '[docs](https://docs.oracle.com/en/database/)',
      '[stmt](mtkprof:#view=statements&sql=f6jyzt7462kx2)',
      '[js](javascript:alert(1))',
      '[JS](JavaScript:alert(1))',
      '[http](http://example.com)',
      '[data](data:text/html,<b>x</b>)',
      '[rel](/etc/passwd)',
      '[vb](vbscript:msgbox)',
      '[proto](//evil.example/x)',
      '<https://example.com/auto>',
      '<javascript:alert(2)>',
    ].join('\n'))
    expect(out.match(/<a /g)).toHaveLength(2)
    expect(out).toContain('<a href="https://docs.oracle.com/en/database/" target="_blank" rel="noopener noreferrer" title="https://docs.oracle.com/en/database/">docs</a>')
    expect(out).toContain('<a href="https://example.com/auto"')
    expect(chips).toEqual(['#view=statements&sql=f6jyzt7462kx2'])
    for (const src of ['[js](javascript:alert(1))', '[http](http://example.com)', '[rel](/etc/passwd)', '[vb](vbscript:msgbox)', '[proto](//evil.example/x)'])
      expect(out).toContain(`<span class="md-nolink" title="Not a link: only https and mtkprof links open">${src}</span>`)
    expect(out).toContain('&lt;javascript:alert(2)&gt;')
    expect(out).not.toMatch(/href="(?!https:)/)
  })

  it('takes the link grammar of the system prompt, + and * in names included', () => {
    html('[waits](mtkprof:#view=waits&ev=SQL*Net+message+from+client&win=1200000-3400000) and [line 4521](mtkprof:#view=lines&file=0&line=4521)')
    expect(chips).toEqual(['#view=waits&ev=SQL*Net+message+from+client&win=1200000-3400000', '#view=lines&file=0&line=4521'])
  })

  it('leaves a link that is still streaming as text', () => {
    const out = html('see [f6jyzt7462kx2](mtkprof:#view=statements&sq')
    expect(chips).toEqual([])
    expect(out).toContain('see [f6jyzt7462kx2](mtkprof:#view=statements&amp;sq')
  })
})

describe('markdown: blocks and inlines', () => {
  it('parses paragraphs, headings, lists, quotes, rules, code and tables', () => {
    const blocks = parseMarkdown([
      '## Findings', '', 'One line', 'and the next.', '', '- a', '- b', '  1. nested', '  2. two', '', '3. three', '4. four', '',
      '> quoted', '', '---', '', '```', 'select 1', '  from dual', '```', '', '| sql | own |', '|:---|--:|', '| `x\\|y` | 1 ms |', '| z |',
    ].join('\n'))
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'list', 'list', 'quote', 'hr', 'code', 'table'])
    expect(blocks[0]).toEqual({ t: 'h', level: 2, children: ['Findings'] })
    expect(blocks[1]).toEqual({ t: 'p', children: ['One line', { t: 'br' }, 'and the next.'] })
    const ul = blocks[2] as Extract<(typeof blocks)[number], { t: 'list' }>
    expect(ul.ordered).toBe(false)
    expect(ul.items).toHaveLength(2)
    expect(ul.items[1].map((b) => b.t)).toEqual(['p', 'list'])
    expect(blocks[3]).toMatchObject({ t: 'list', ordered: true, start: 3 })
    expect(blocks[6]).toEqual({ t: 'code', lang: '', text: 'select 1\n  from dual' })
    expect(blocks[7]).toEqual({
      t: 'table', align: ['left', 'right'],
      head: [['sql'], ['own']],
      rows: [[[{ t: 'code', text: 'x|y' }], ['1 ms']], [['z'], []]],
    })
  })

  it('renders an unclosed code fence (a streaming answer) as code', () => {
    expect(html('```sql\nselect *')).toBe('<div class="md"><pre class="md-code" data-lang="sql"><code>select *</code></pre></div>')
  })

  it('reads emphasis, code and escapes, and leaves snake_case and lone stars alone', () => {
    expect(parseInline('**bold** *em* _em_ ~~gone~~ ***both***')).toEqual([
      { t: 'strong', children: ['bold'] }, ' ', { t: 'em', children: ['em'] }, ' ', { t: 'em', children: ['em'] }, ' ',
      { t: 'del', children: ['gone'] }, ' ', { t: 'strong', children: [{ t: 'em', children: ['both'] }] },
    ])
    expect(parseInline('sql_id and db_file_multiblock_read_count')).toEqual(['sql_id and db_file_multiblock_read_count'])
    expect(parseInline('2 * 3 * 4 and a * b')).toEqual(['2 * 3 * 4 and a * b'])
    expect(parseInline('\\*not em\\* and ``a ` b``')).toEqual(['*not em* and ', { t: 'code', text: 'a ` b' }])
    expect(parseInline('`SQL*Net message from client` is idle')).toEqual([{ t: 'code', text: 'SQL*Net message from client' }, ' is idle'])
  })

  it('renders a tight list item without a paragraph and an ordered start', () => {
    expect(html('3. a\n4. b')).toBe('<div class="md"><ol start="3"><li>a</li><li>b</li></ol></div>')
    expect(html('- **x** [y](https://e.example/)')).toBe('<div class="md"><ul><li><strong>x</strong> <a href="https://e.example/" target="_blank" rel="noopener noreferrer" title="https://e.example/">y</a></li></ul></div>')
  })
})

describe('mtkprofLinks', () => {
  it('lists the mtkprof: links in order with their label as plain text, and skips code and other links', () => {
    const text = [
      'The slowest is [`f6jyzt7462kx2`](mtkprof:#view=statements&sql=f6jyzt7462kx2), see [the docs](https://docs.oracle.com/x).',
      '',
      '- **[execution #3](mtkprof:#view=statements&sql=abc&exec=118:3)** took long',
      '- `[no](mtkprof:#view=waits)` is code',
      '',
      '| what | where |',
      '| --- | --- |',
      '| a window | [+1 s](mtkprof:#view=timeline&win=1-2) |',
      '',
      '> quoted [wait](mtkprof:#view=waits&ev=x)',
      '',
      '[bad](javascript:alert(1))',
    ].join('\n')
    expect(mtkprofLinks(text)).toEqual([
      { source: '[`f6jyzt7462kx2`](mtkprof:#view=statements&sql=f6jyzt7462kx2)', label: 'f6jyzt7462kx2', hash: '#view=statements&sql=f6jyzt7462kx2' },
      { source: '[execution #3](mtkprof:#view=statements&sql=abc&exec=118:3)', label: 'execution #3', hash: '#view=statements&sql=abc&exec=118:3' },
      { source: '[+1 s](mtkprof:#view=timeline&win=1-2)', label: '+1 s', hash: '#view=timeline&win=1-2' },
      { source: '[wait](mtkprof:#view=waits&ev=x)', label: 'wait', hash: '#view=waits&ev=x' },
    ])
  })
})
