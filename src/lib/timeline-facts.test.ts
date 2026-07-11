/**
 * Payload → fact-grid parsing for the detail drawer (Timeline 2.1). Pure:
 * scalars only, humanized keys, sentinel/noise/id keys dropped, capped + truncated.
 */

import { describe, expect, it } from 'vitest'
import { humanizeKey, memoryTier, payloadFacts, sourceColor } from './timeline-facts'

describe('sourceColor', () => {
  it('returns a stable HSL for known sources', () => {
    expect(sourceColor('netflix')).toBe('hsl(0 62% 52%)')
    expect(sourceColor('spotify')).toBe('hsl(141 62% 52%)')
    expect(sourceColor('linkedin')).toBe('hsl(205 62% 52%)')
  })
  it('returns null for neutral / unknown sources (stay gray)', () => {
    expect(sourceColor('generic')).toBeNull()
    expect(sourceColor('browser')).toBeNull()
    expect(sourceColor('document')).toBeNull()
    expect(sourceColor('something-new')).toBeNull()
  })
})

describe('memoryTier', () => {
  it('buckets scores into high / mid / low, defaulting to mid when absent', () => {
    expect(memoryTier(85)).toBe('high')
    expect(memoryTier(70)).toBe('high')
    expect(memoryTier(50)).toBe('mid')
    expect(memoryTier(35)).toBe('mid')
    expect(memoryTier(20)).toBe('low')
    expect(memoryTier(undefined)).toBe('mid')
  })
})

describe('humanizeKey', () => {
  it('title-cases snake, kebab, and camelCase keys', () => {
    expect(humanizeKey('product_name')).toBe('Product Name')
    expect(humanizeKey('MostRecentWatchDate')).toBe('Most Recent Watch Date')
    expect(humanizeKey('total-reading-milliseconds')).toBe('Total Reading Milliseconds')
  })
})

describe('payloadFacts', () => {
  it('extracts scalar facts, humanizes keys, drops noise/sentinels/ids', () => {
    const payload = JSON.stringify({
      ASIN: 'B07TDDPZCW', // id/noise → dropped
      Album_ASIN: 'B07T86HP77',
      product_name: 'Old Town Road (Remix)',
      Primary_Genre: 'Country',
      Runtime: 157,
      LatestWatchProgress: 'Not Available', // sentinel → dropped
      Composer: '', // empty → dropped
      nested: { a: 1 } // object → dropped
    })
    const facts = payloadFacts(payload)
    const byLabel = Object.fromEntries(facts.map((f) => [f.label, f.value]))
    expect(byLabel['Product Name']).toBe('Old Town Road (Remix)')
    expect(byLabel['Primary Genre']).toBe('Country')
    expect(byLabel.Runtime).toBe('157')
    expect(facts.find((f) => f.label.includes('ASIN'))).toBeUndefined()
    expect(facts.find((f) => f.value === 'Not Available')).toBeUndefined()
    expect(facts.find((f) => f.label === 'Composer')).toBeUndefined()
    expect(facts.find((f) => f.label === 'Nested')).toBeUndefined()
  })

  it('caps the count and truncates long values', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${i}`, `v${i}`]))
    expect(payloadFacts(JSON.stringify(many), 8)).toHaveLength(8)
    const long = payloadFacts(JSON.stringify({ note: 'x'.repeat(300) }))[0]
    expect(long.value.length).toBeLessThanOrEqual(140)
    expect(long.value.endsWith('…')).toBe(true)
  })

  it('returns [] for null, non-JSON, or a JSON array', () => {
    expect(payloadFacts(null)).toEqual([])
    expect(payloadFacts('not json')).toEqual([])
    expect(payloadFacts('[1,2,3]')).toEqual([])
  })
})
