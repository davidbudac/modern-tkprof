import { describe, expect, it } from 'vitest'
import { escHtml } from './format'

describe('escHtml', () => {
  it('turns markup characters into entities', () => {
    expect(escHtml(`<img src=x onerror="alert('1')">`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;')
    expect(escHtml('a & b')).toBe('a &amp; b')
    expect(escHtml('&lt;')).toBe('&amp;lt;')
  })
  it('leaves ordinary names alone', () => {
    for (const s of ['db file sequential read', 'SQL*Net message from client', '7r10y07tqpg98', 'hv:123456']) expect(escHtml(s)).toBe(s)
  })
  it('takes anything', () => {
    expect(escHtml(undefined)).toBe('')
    expect(escHtml(null)).toBe('')
    expect(escHtml(42)).toBe('42')
  })
})
