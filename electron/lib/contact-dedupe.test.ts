import { describe, expect, it } from 'vitest'
import { type DedupeContact, computeDedupe, dedupePairKey, normalizePhone } from './contact-dedupe'

let nextId = 1
function c(over: Partial<DedupeContact> & { displayName: string }): DedupeContact {
  return {
    id: over.id ?? nextId++,
    externalId: over.externalId ?? `ext:${over.displayName}:${nextId}`,
    source: 'google',
    createdAt: 1000,
    emails: [],
    phones: [],
    filledScore: 0,
    ...over
  }
}
const run = (rows: DedupeContact[], dismissed: string[] = []) =>
  computeDedupe(rows, { dismissedPairs: new Set(dismissed) })

describe('normalizePhone', () => {
  it('strips formatting and compares NANP variants on the last 10 digits', () => {
    expect(normalizePhone('+1 (415) 555-0100')).toBe('4155550100')
    expect(normalizePhone('415-555-0100')).toBe('4155550100')
    expect(normalizePhone('001 415 555 0100')).toBe('4155550100')
  })
  it('keeps 7-9 digit numbers whole and rejects shorter fragments', () => {
    expect(normalizePhone('555-0100')).toBe('5550100')
    expect(normalizePhone('x123')).toBeNull()
    expect(normalizePhone('911')).toBeNull()
    expect(normalizePhone('')).toBeNull()
  })
})

describe('computeDedupe — auto groups', () => {
  it('groups contacts sharing an email, case-insensitively', () => {
    const a = c({ displayName: 'Jane Doe', emails: [{ value: 'Jane@X.com' }] })
    const b = c({
      displayName: 'Jane D.',
      emails: [{ value: 'jane@x.com' }],
      source: 'google-other'
    })
    const { autoGroups, fuzzyPairs } = run([a, b])
    expect(autoGroups).toHaveLength(1)
    expect(autoGroups[0].reason).toBe('email')
    expect(fuzzyPairs).toHaveLength(0)
  })

  it('merges transitive chains (A~B email, B~C phone with matching names) into one group', () => {
    const a = c({ displayName: 'Bob Roe', emails: [{ value: 'bob@x.com' }] })
    const b = c({
      displayName: 'Bob Roe',
      emails: [{ value: 'bob@x.com' }],
      phones: [{ value: '+1 415 555 0100' }]
    })
    const d = c({ displayName: 'Bob Roe', phones: [{ value: '(415) 555-0100' }] })
    const { autoGroups } = run([a, b, d])
    expect(autoGroups).toHaveLength(1)
    expect(autoGroups[0].loserIds).toHaveLength(2)
  })

  it('demotes a phone-only link between DIFFERENT names to the review queue (shared landline)', () => {
    const wife = c({ displayName: 'Ann Smith', phones: [{ value: '415 555 0100' }] })
    const husband = c({ displayName: 'Tom Smith', phones: [{ value: '415-555-0100' }] })
    const { autoGroups, fuzzyPairs } = run([wife, husband])
    expect(autoGroups).toHaveLength(0)
    expect(fuzzyPairs).toHaveLength(1)
    expect(fuzzyPairs[0].nameKey).toBe('shared-phone')
  })

  it('lets a phone link stand when one side is an email-as-name row (name-less Other Contact)', () => {
    const named = c({ displayName: 'Cara Lee', phones: [{ value: '415 555 0100' }] })
    const bare = c({
      displayName: 'cara@x.com',
      phones: [{ value: '+1 (415) 555-0100' }],
      source: 'google-other'
    })
    const { autoGroups } = run([named, bare])
    expect(autoGroups).toHaveLength(1)
    expect(autoGroups[0].reason).toBe('phone')
  })

  it('picks the survivor by source rank, then filledness, then age', () => {
    const derived = c({
      id: 1,
      displayName: 'Dana Fox',
      source: 'derived',
      emails: [{ value: 'dana@x.com' }],
      filledScore: 9
    })
    const google = c({
      id: 2,
      displayName: 'Dana Fox',
      source: 'google',
      emails: [{ value: 'dana@x.com' }],
      filledScore: 1
    })
    expect(run([derived, google]).autoGroups[0].survivorId).toBe(2) // source beats filledness

    const a = c({ id: 3, displayName: 'Eve Ray', emails: [{ value: 'e@x.com' }], filledScore: 1 })
    const b = c({ id: 4, displayName: 'Eve Ray', emails: [{ value: 'e@x.com' }], filledScore: 5 })
    expect(run([a, b]).autoGroups[0].survivorId).toBe(4) // filledness within same source

    const older = c({
      id: 5,
      displayName: 'Fay Woo',
      emails: [{ value: 'f@x.com' }],
      createdAt: 100
    })
    const newer = c({
      id: 6,
      displayName: 'Fay Woo',
      emails: [{ value: 'f@x.com' }],
      createdAt: 900
    })
    expect(run([older, newer]).autoGroups[0].survivorId).toBe(5) // oldest wins ties
  })

  it('is idempotent: no groups over an already-unique set', () => {
    const a = c({ displayName: 'Gil Ono', emails: [{ value: 'g@x.com' }] })
    const b = c({ displayName: 'Hal Ito', emails: [{ value: 'h@x.com' }] })
    const { autoGroups, fuzzyPairs } = run([a, b])
    expect(autoGroups).toHaveLength(0)
    expect(fuzzyPairs).toHaveLength(0)
  })
})

describe('computeDedupe — fuzzy pairs', () => {
  it('pairs same-name contacts with no shared identifier', () => {
    const a = c({ displayName: 'Ivy Chen', emails: [{ value: 'ivy@work.com' }] })
    const b = c({ displayName: 'ivy  chen', emails: [{ value: 'ivy@home.net' }] })
    const { autoGroups, fuzzyPairs } = run([a, b])
    expect(autoGroups).toHaveLength(0)
    expect(fuzzyPairs).toHaveLength(1)
    expect(fuzzyPairs[0].nameKey).toBe('ivy chen')
  })

  it('never pairs single-token names', () => {
    const a = c({ displayName: 'John' })
    const b = c({ displayName: 'John' })
    expect(run([a, b]).fuzzyPairs).toHaveLength(0)
  })

  it('suppresses dismissed pairs', () => {
    const a = c({ displayName: 'Kim Ray', externalId: 'x|1' })
    const b = c({ displayName: 'Kim Ray', externalId: 'y|2' })
    const key = dedupePairKey('x|1', 'y|2')
    expect(run([a, b]).fuzzyPairs).toHaveLength(1)
    expect(run([a, b], [key]).fuzzyPairs).toHaveLength(0)
  })

  it('excludes contacts already in an auto group this run', () => {
    const a = c({ displayName: 'Lee Park', emails: [{ value: 'lee@x.com' }] })
    const b = c({ displayName: 'Lee Park', emails: [{ value: 'lee@x.com' }] })
    const d = c({ displayName: 'Lee Park', emails: [{ value: 'other@z.com' }] })
    const { autoGroups, fuzzyPairs } = run([a, b, d])
    expect(autoGroups).toHaveLength(1)
    // d pairs with nobody: a+b are consumed by the auto group.
    expect(fuzzyPairs).toHaveLength(0)
  })
})
