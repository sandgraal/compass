import { describe, expect, it } from 'vitest'
import { _internal } from './finance-subscriptions'

const { normalizeMerchant, detectCadence, median } = _internal

describe('normalizeMerchant', () => {
  it('strips "Payment to" prefix used by PayPal', () => {
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
})

describe('detectCadence', () => {
  const dates = (...ymd: string[]): Date[] => ymd.map((s) => new Date(s))

  it('detects monthly (28-32 day gaps)', () => {
    expect(detectCadence(dates('2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15'))).toBe(
      'monthly'
    )
  })

  it('detects weekly', () => {
    expect(detectCadence(dates('2026-04-01', '2026-04-08', '2026-04-15', '2026-04-22'))).toBe(
      'weekly'
    )
  })

  it('detects quarterly', () => {
    expect(detectCadence(dates('2025-07-01', '2025-10-01', '2026-01-01', '2026-04-01'))).toBe(
      'quarterly'
    )
  })

  it('detects yearly', () => {
    expect(detectCadence(dates('2024-04-01', '2025-04-02', '2026-04-01'))).toBe('yearly')
  })

  it('returns null for irregular cadences', () => {
    expect(detectCadence(dates('2026-01-01', '2026-01-05', '2026-04-15'))).toBe(null)
  })

  it('returns null for too few dates', () => {
    expect(detectCadence([new Date('2026-01-01')])).toBe(null)
  })
})

describe('median', () => {
  it('handles odd-length arrays', () => {
    expect(median([1, 5, 3])).toBe(3)
  })

  it('handles even-length arrays', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
})
