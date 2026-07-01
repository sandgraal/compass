import { describe, expect, it } from 'vitest'
import { annualizeCost, detectCadence, median, normalizeMerchant } from './normalize'

// These lock the SHARED normalizers whose output is a persisted key (the
// `detected:<merchant>::<account>` subscription external id). Changing any of
// these expectations means migrating existing rows — treat as a contract.

describe('normalizeMerchant (contract — do not drift)', () => {
  it('strips "Payment to" prefix (PayPal)', () => {
    expect(normalizeMerchant('Payment to Apple Services')).toBe('apple services')
  })
  it('strips long numeric IDs', () => {
    expect(normalizeMerchant('STARBUCKS STORE 12345')).toBe('starbucks store')
  })
  it('strips company suffixes', () => {
    expect(normalizeMerchant('Acme Inc.')).toBe('acme')
    expect(normalizeMerchant('Foo LLC')).toBe('foo')
  })
  it('caps to 4 tokens for stable bucketing', () => {
    expect(normalizeMerchant('LONG MERCHANT NAME WITH MANY WORDS HERE')).toBe(
      'long merchant name with'
    )
  })
  it('is stable across casing/whitespace so cross-source rows merge', () => {
    expect(normalizeMerchant('  NETFLIX.COM  ')).toBe(normalizeMerchant('netflix com'))
  })
})

describe('detectCadence', () => {
  const dates = (...ymd: string[]): Date[] => ymd.map((s) => new Date(s))
  it('detects monthly', () => {
    expect(detectCadence(dates('2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15'))).toBe(
      'monthly'
    )
  })
  it('detects yearly', () => {
    expect(detectCadence(dates('2024-04-01', '2025-04-02', '2026-04-01'))).toBe('yearly')
  })
  it('returns null for a single date', () => {
    expect(detectCadence([new Date('2026-01-01')])).toBe(null)
  })
})

describe('annualizeCost', () => {
  it('multiplies by the per-year cadence factor', () => {
    expect(annualizeCost(10, 'monthly')).toBe(120)
    expect(annualizeCost(100, 'yearly')).toBe(100)
    expect(annualizeCost(5, 'weekly')).toBe(260)
  })
  it('falls back to monthly (×12) for an unknown cadence', () => {
    expect(annualizeCost(10, 'whenever')).toBe(120)
  })
})

describe('median', () => {
  it('averages the two middle values when even', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
  it('returns the middle value when odd', () => {
    expect(median([5, 1, 3])).toBe(3)
  })
})
