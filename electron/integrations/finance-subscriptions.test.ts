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

// ── Price-hike enrichment (May 2026 Tier 2 #8) ──────────────────────────────
//
// We exercise the price-hike pathway end-to-end through `auditSubscriptions`
// using a minimal Drizzle-compatible mock — same shape the function would
// see from better-sqlite3 in production. The point is to lock in:
//   - A clean Netflix-style $7.99 → $11.99 jump fires `priceHike: true`
//   - A flat charge stream stays `priceHike: false`
//   - The reported delta + pct match the recent/historical split

import { auditSubscriptions } from './finance-subscriptions'

type MockRow = {
  date: string
  amount: number
  description: string
  account: number
  category: string
  subcategory: string | null
}

function buildMockDb(rows: MockRow[], accounts = [{ id: 1, name: 'Chase' }]) {
  // Match the very narrow `.select(...).from(table).all()` surface that
  // `auditSubscriptions` calls. Two paths: subscription rows (the txn
  // table) and account rows (for the name lookup).
  let callIdx = 0
  return {
    select() {
      callIdx++
      return {
        from() {
          return {
            all() {
              return callIdx === 1 ? rows : accounts
            }
          }
        }
      }
    }
  } as unknown as Parameters<typeof auditSubscriptions>[0]
}

function streamlinedHikeRows(): MockRow[] {
  // 8 monthly charges, latest 3 jump from $7.99 to $11.99.
  const dates = [
    '2025-10-15',
    '2025-11-15',
    '2025-12-15',
    '2026-01-15',
    '2026-02-15',
    '2026-03-15',
    '2026-04-15',
    '2026-05-15'
  ]
  return dates.map((d, i) => ({
    date: d,
    amount: i < 5 ? -7.99 : -11.99,
    description: 'NETFLIX.COM',
    account: 1,
    category: 'Entertainment',
    subcategory: null
  }))
}

describe('subscription price-hike enrichment', () => {
  it('flags a recent jump and reports the delta + pct', () => {
    const db = buildMockDb(streamlinedHikeRows())
    const result = auditSubscriptions(db, { today: new Date('2026-05-30') })
    const netflix = result.active.find((s) => s.merchant.includes('netflix'))
    expect(netflix).toBeDefined()
    expect(netflix!.priceHike).toBe(true)
    expect(netflix!.recentMedian).toBeCloseTo(11.99, 1)
    expect(netflix!.historicalMedian).toBeCloseTo(7.99, 1)
    expect(netflix!.priceHikeDelta).toBeCloseTo(4, 1)
    expect(netflix!.priceHikePct).toBeGreaterThan(40)
    expect(netflix!.priceHikePct).toBeLessThan(60)
  })

  it('does NOT flag a flat charge stream', () => {
    const flat: MockRow[] = Array.from({ length: 6 }, (_, i) => ({
      date: `2026-${String(i + 1).padStart(2, '0')}-15`,
      amount: -9.99,
      description: 'SPOTIFY',
      account: 1,
      category: 'Entertainment',
      subcategory: null
    }))
    const db = buildMockDb(flat)
    const result = auditSubscriptions(db, { today: new Date('2026-07-01') })
    const spotify = result.active.find((s) => s.merchant.includes('spotify'))
    expect(spotify).toBeDefined()
    expect(spotify!.priceHike).toBe(false)
  })

  it('ignores tiny noise (a few cents of drift)', () => {
    const noisy: MockRow[] = [
      {
        date: '2025-12-15',
        amount: -9.99,
        description: 'HULU',
        account: 1,
        category: 'Entertainment',
        subcategory: null
      },
      {
        date: '2026-01-15',
        amount: -10.0,
        description: 'HULU',
        account: 1,
        category: 'Entertainment',
        subcategory: null
      },
      {
        date: '2026-02-15',
        amount: -9.99,
        description: 'HULU',
        account: 1,
        category: 'Entertainment',
        subcategory: null
      },
      {
        date: '2026-03-15',
        amount: -10.02,
        description: 'HULU',
        account: 1,
        category: 'Entertainment',
        subcategory: null
      },
      {
        date: '2026-04-15',
        amount: -10.05,
        description: 'HULU',
        account: 1,
        category: 'Entertainment',
        subcategory: null
      }
    ]
    const db = buildMockDb(noisy)
    const result = auditSubscriptions(db, { today: new Date('2026-05-01') })
    const hulu = result.active.find((s) => s.merchant.includes('hulu'))
    expect(hulu).toBeDefined()
    expect(hulu!.priceHike).toBe(false)
  })
})
