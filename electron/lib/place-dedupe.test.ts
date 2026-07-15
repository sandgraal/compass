import { describe, expect, it } from 'vitest'
import {
  type DedupePlaceRow,
  computePlaceDedupe,
  dedupePairKey,
  pickPlaceSurvivor,
  placesLikelyDuplicate,
  tokenizePlaceName
} from './place-dedupe'

let nextId = 1
function p(over: Partial<DedupePlaceRow> & { name: string }): DedupePlaceRow {
  return {
    id: over.id ?? nextId++,
    externalId: over.externalId ?? `ext:${over.name}:${nextId}`,
    kind: 'merchant',
    createdAt: 1000,
    filledScore: 0,
    ...over
  }
}
const run = (rows: DedupePlaceRow[], dismissed: string[] = []) =>
  computePlaceDedupe(rows, { dismissedPairs: new Set(dismissed) })

describe('tokenizePlaceName', () => {
  it('lowercases, strips punctuation, and drops stopwords/numeric/short tokens', () => {
    expect(tokenizePlaceName('Starbucks Coffee #4521')).toEqual(['starbucks', 'coffee'])
    expect(tokenizePlaceName('The CVS Store, Inc.')).toEqual(['cvs'])
  })
})

describe('placesLikelyDuplicate', () => {
  it('flags full token-set containment', () => {
    expect(placesLikelyDuplicate(['starbucks'], ['starbucks', 'coffee'])).toBe(true)
  })
  it('flags high Jaccard overlap without full containment', () => {
    expect(placesLikelyDuplicate(['whole', 'foods', 'market'], ['whole', 'foods'])).toBe(true)
  })
  it('rejects unrelated names', () => {
    expect(placesLikelyDuplicate(['starbucks', 'coffee'], ['chevron', 'gas'])).toBe(false)
  })
  it('rejects when either side has no tokens left after stripping', () => {
    expect(placesLikelyDuplicate([], ['starbucks'])).toBe(false)
  })
})

describe('computePlaceDedupe', () => {
  it('suggests a pair for similar names within the same kind', () => {
    const a = p({ name: 'Starbucks' })
    const b = p({ name: 'Starbucks Coffee #4521' })
    const pairs = run([a, b])
    expect(pairs).toHaveLength(1)
    expect(new Set([pairs[0].aId, pairs[0].bId])).toEqual(new Set([a.id, b.id]))
  })

  it('never pairs across kinds', () => {
    const a = p({ name: 'Starbucks', kind: 'merchant' })
    const b = p({ name: 'Starbucks', kind: 'place' })
    expect(run([a, b])).toHaveLength(0)
  })

  it('does not suggest unrelated names', () => {
    const a = p({ name: 'Starbucks' })
    const b = p({ name: 'Chevron Gas Station' })
    expect(run([a, b])).toHaveLength(0)
  })

  it('excludes pairs the user already dismissed', () => {
    const a = p({ name: 'Starbucks', externalId: 'ext:a' })
    const b = p({ name: 'Starbucks Coffee #4521', externalId: 'ext:b' })
    const dismissed = dedupePairKey(a.externalId, b.externalId)
    expect(run([a, b], [dismissed])).toHaveLength(0)
  })

  it('is idempotent — does not duplicate a pair found via multiple shared tokens', () => {
    const a = p({ name: 'Whole Foods Market' })
    const b = p({ name: 'Whole Foods' })
    expect(run([a, b])).toHaveLength(1)
  })
})

describe('pickPlaceSurvivor', () => {
  it('prefers the richer profile', () => {
    const a = p({ name: 'A', filledScore: 1 })
    const b = p({ name: 'B', filledScore: 5 })
    expect(pickPlaceSurvivor([a, b]).id).toBe(b.id)
  })
  it('falls back to the older record on a tie', () => {
    const a = p({ name: 'A', filledScore: 2, createdAt: 500 })
    const b = p({ name: 'B', filledScore: 2, createdAt: 1500 })
    expect(pickPlaceSurvivor([a, b]).id).toBe(a.id)
  })
  it('falls back to the lowest id on a full tie', () => {
    const a = p({ name: 'A', filledScore: 2, createdAt: 1000, id: 10 })
    const b = p({ name: 'B', filledScore: 2, createdAt: 1000, id: 5 })
    expect(pickPlaceSurvivor([a, b]).id).toBe(5)
  })
})
