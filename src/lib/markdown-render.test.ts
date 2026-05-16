/**
 * Tests for the minimal Markdown → HTML renderer used by the Ask
 * Compass chat panel. Two contracts to lock in:
 *
 *   1. Recognised constructs (headings, lists, code, links, etc.)
 *      render to the expected HTML tags.
 *   2. Everything else is escaped — no raw HTML, no event handlers,
 *      no `javascript:` URLs can leak through `dangerouslySetInnerHTML`.
 */

import { describe, expect, it } from 'vitest'
import { _internal, renderAssistantMarkdown } from './markdown-render'

const { escapeHtml, renderInline } = _internal

describe('escapeHtml', () => {
  it('escapes the html-significant characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    )
  })
  it('escapes ampersands first so we do not double-encode', () => {
    expect(escapeHtml('A & B < C')).toBe('A &amp; B &lt; C')
  })
})

describe('renderInline', () => {
  it('renders bold', () => {
    expect(renderInline('**bold**')).toBe('<strong>bold</strong>')
  })
  it('renders italic', () => {
    expect(renderInline('an *italic* word')).toBe('an <em>italic</em> word')
  })
  it('renders inline code with literal angle brackets escaped', () => {
    expect(renderInline('`<x>`')).toBe('<code>&lt;x&gt;</code>')
  })
  it('renders safe links', () => {
    expect(renderInline('see [docs](https://example.com)')).toBe(
      'see <a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>'
    )
  })
  it('refuses unsafe link schemes', () => {
    const out = renderInline('[bad](javascript:alert(1))')
    expect(out).not.toContain('href="javascript:')
    expect(out).toContain('[bad]')
  })
})

describe('renderAssistantMarkdown blocks', () => {
  it('renders headings', () => {
    expect(renderAssistantMarkdown('# H1\n## H2\n### H3')).toBe(
      '<h1>H1</h1>\n<h2>H2</h2>\n<h3>H3</h3>'
    )
  })

  it('renders an unordered list', () => {
    expect(renderAssistantMarkdown('- one\n- two\n- three')).toBe(
      '<ul><li>one</li><li>two</li><li>three</li></ul>'
    )
  })

  it('renders an ordered list', () => {
    expect(renderAssistantMarkdown('1. first\n2. second')).toBe(
      '<ol><li>first</li><li>second</li></ol>'
    )
  })

  it('coalesces wrapped paragraph lines', () => {
    expect(renderAssistantMarkdown('hello\nworld')).toBe('<p>hello world</p>')
  })

  it('renders blockquotes', () => {
    expect(renderAssistantMarkdown('> quoted\n> line two')).toBe(
      '<blockquote><p>quoted</p><p>line two</p></blockquote>'
    )
  })

  it('renders fenced code blocks with the language class', () => {
    const md = '```ts\nconst x = 1\n```'
    const html = renderAssistantMarkdown(md)
    expect(html).toContain('<pre><code class="language-ts">')
    expect(html).toContain('const x = 1')
  })

  it('escapes html inside fenced code', () => {
    const html = renderAssistantMarkdown('```\n<div onerror=alert(1)>\n```')
    expect(html).toContain('&lt;div onerror=alert(1)&gt;')
    expect(html).not.toContain('<div onerror=')
  })

  it('escapes raw HTML in a regular paragraph', () => {
    const html = renderAssistantMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('preserves bracketed citation markers like [3]', () => {
    expect(renderAssistantMarkdown('this is true [3].')).toBe('<p>this is true [3].</p>')
  })

  it('tolerates an unclosed fenced block', () => {
    const html = renderAssistantMarkdown('```\nunclosed')
    expect(html).toContain('<pre><code>')
    expect(html).toContain('unclosed')
  })
})
