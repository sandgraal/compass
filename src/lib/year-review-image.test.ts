/**
 * Shareable Year-in-Review SVG card (Timeline 2.1). Pure: escaping, word-wrap,
 * and a well-formed self-contained SVG with no external refs.
 */

import { describe, expect, it } from 'vitest'
import { buildYearReviewSvg, escapeXml, wrapText } from './year-review-image'

describe('escapeXml', () => {
  it('escapes the five XML entities', () => {
    expect(escapeXml(`A & B < C > "D" 'E'`)).toBe(
      'A &amp; B &lt; C &gt; &quot;D&quot; &apos;E&apos;'
    )
  })
})

describe('wrapText', () => {
  it('greedily wraps to the char budget', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 15, 5)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(16)
  })
  it('caps line count and ellipsizes the overflow', () => {
    const lines = wrapText('one two three four five six seven eight nine ten', 8, 2)
    expect(lines).toHaveLength(2)
    expect(lines[1].endsWith('…')).toBe(true)
  })
})

describe('buildYearReviewSvg', () => {
  const card = {
    year: 2024,
    totalRecords: 12431,
    sources: 16,
    newPeople: 3,
    countries: 2,
    narrative: 'A quiet, bingeable year with one great show & a trip abroad.'
  }

  it('produces a self-contained SVG with the year, stats, and escaped narrative', () => {
    const svg = buildYearReviewSvg(card)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('width="1200"')
    expect(svg).toContain('>2024<')
    expect(svg).toContain('12,431') // localized record count
    expect(svg).toContain('YEAR IN REVIEW')
    expect(svg).toContain('&amp;') // narrative ampersand escaped
    // No external fetches that CSP would block / that would taint the canvas.
    // (The `xmlns="http://www.w3.org/2000/svg"` namespace is an identifier, not a fetch.)
    expect(svg).not.toMatch(/<image|xlink:href|@import|url\(\s*https?:/)
  })
})
