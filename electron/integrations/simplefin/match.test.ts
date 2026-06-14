/**
 * Tests for the conservative SimpleFIN account matcher. The bar is high on
 * purpose — only an unambiguous institution + last-4 match adopts an existing
 * account; everything else creates new (and the user can merge later).
 */

import { describe, expect, it } from 'vitest'
import { type MatchCandidate, findAccountMatch, last4 } from './match'

describe('last4', () => {
  it('reads a bare mask', () => expect(last4('1234')).toBe('1234'))
  it('reads a number embedded in a name', () => expect(last4('Platinum Card (·2001)')).toBe('2001'))
  it('takes the trailing 4 when more digits are present', () =>
    expect(last4('····81003')).toBe('1003'))
  it('returns null with fewer than 4 digits', () => {
    expect(last4('abc')).toBeNull()
    expect(last4('12')).toBeNull()
    expect(last4(null)).toBeNull()
  })
})

describe('findAccountMatch', () => {
  const candidates: MatchCandidate[] = [
    { id: 1, name: 'Chase Checking (1234)', institution: 'Chase', mask: null },
    { id: 2, name: 'Amex Platinum', institution: 'American Express', mask: '2001' }
  ]

  it('matches on institution + last-4 (last-4 from incoming name)', () => {
    expect(
      findAccountMatch({ name: 'Platinum Card (2001)', orgName: 'American Express' }, candidates)
    ).toBe(2)
  })

  it('matches using last-4 parsed from the candidate name', () => {
    expect(findAccountMatch({ name: 'Checking ··1234', orgName: 'chase' }, candidates)).toBe(1)
  })

  it('no match when the institution differs', () => {
    expect(findAccountMatch({ name: 'Card (2001)', orgName: 'Citi' }, candidates)).toBeNull()
  })

  it('no match when the last-4 differs', () => {
    expect(
      findAccountMatch({ name: 'Card (9999)', orgName: 'American Express' }, candidates)
    ).toBeNull()
  })

  it('no match when the incoming account has no parseable last-4', () => {
    expect(
      findAccountMatch({ name: 'Platinum Card', orgName: 'American Express' }, candidates)
    ).toBeNull()
  })

  it('skips ambiguous matches (>1 candidate with same institution + last-4)', () => {
    const dup: MatchCandidate[] = [
      { id: 3, name: 'A (2001)', institution: 'American Express', mask: null },
      { id: 4, name: 'B', institution: 'American Express', mask: '2001' }
    ]
    expect(findAccountMatch({ name: 'Card (2001)', orgName: 'American Express' }, dup)).toBeNull()
  })
})
