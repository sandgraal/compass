/**
 * Merchant profile aggregation — pure-function coverage: stats (spend vs
 * refunds, YTD trend, monthly median), monthly buckets, price trend (both
 * directions + the drift guards), tax rollup, mixed currencies.
 */
import { describe, expect, it } from 'vitest'
import {
  type MerchantSlimTxn,
  computeMerchantStats,
  computeMonthlyBuckets,
  computePriceTrend,
  computeTaxSummary,
  dominantCurrency
} from './merchant-profile'

const txn = (date: string, amount: number, over?: Partial<MerchantSlimTxn>): MerchantSlimTxn => ({
  date,
  amount,
  currency: 'USD',
  ...over
})

const NOW = new Date('2026-07-13T12:00:00Z')

describe('computeMerchantStats', () => {
  it('sums expenses, excludes refunds from spend, and averages per charge', () => {
    const stats = computeMerchantStats(
      [txn('2026-01-05', -10), txn('2026-02-05', -20), txn('2026-02-20', 5)],
      NOW
    )
    expect(stats.totalSpend).toBe(30)
    expect(stats.refundTotal).toBe(5)
    expect(stats.txnCount).toBe(3)
    expect(stats.spendCount).toBe(2)
    expect(stats.avgTxn).toBe(15)
    expect(stats.firstTxnDate).toBe('2026-01-05')
    expect(stats.lastTxnDate).toBe('2026-02-20')
  })

  it('compares YTD against the same span last year, not the full year', () => {
    const stats = computeMerchantStats(
      [
        txn('2025-03-01', -100), // last year, inside Jan-1→Jul-13 span
        txn('2025-11-01', -900), // last year, AFTER the span — must not count
        txn('2026-03-01', -150)
      ],
      NOW
    )
    expect(stats.thisYearSpend).toBe(150)
    expect(stats.lastYearSameSpanSpend).toBe(100)
    expect(stats.trendPct).toBe(50)
  })

  it('trendPct is null when last year had no spend in the span', () => {
    const stats = computeMerchantStats([txn('2026-03-01', -150)], NOW)
    expect(stats.trendPct).toBeNull()
  })

  it('monthlyMedian needs ≥3 active months', () => {
    const two = computeMerchantStats([txn('2026-01-05', -10), txn('2026-02-05', -30)], NOW)
    expect(two.monthlyMedian).toBeNull()
    const three = computeMerchantStats(
      [txn('2026-01-05', -10), txn('2026-02-05', -30), txn('2026-03-05', -20)],
      NOW
    )
    expect(three.monthlyMedian).toBe(20)
  })

  it('detects a monthly cadence from steady expense dates', () => {
    const dates = ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05', '2026-05-05']
    const stats = computeMerchantStats(
      dates.map((d) => txn(d, -15.99)),
      NOW
    )
    expect(stats.cadence).toBe('monthly')
  })

  it('restricts money figures to the dominant currency', () => {
    const stats = computeMerchantStats(
      [
        txn('2026-01-05', -10),
        txn('2026-02-05', -10),
        txn('2026-03-05', -5000, { currency: 'CRC' })
      ],
      NOW
    )
    expect(stats.currency).toBe('USD')
    expect(stats.totalSpend).toBe(20)
    expect(stats.txnCount).toBe(3) // count still covers everything
  })
})

describe('computeMonthlyBuckets', () => {
  it('buckets expenses by month ascending, skipping refunds and empty months', () => {
    const buckets = computeMonthlyBuckets([
      txn('2026-03-10', -7.5),
      txn('2026-01-05', -10),
      txn('2026-01-20', -5),
      txn('2026-02-14', 12) // refund — not spend
    ])
    expect(buckets).toEqual([
      { month: '2026-01', spend: 15, count: 2 },
      { month: '2026-03', spend: 7.5, count: 1 }
    ])
  })
})

describe('computePriceTrend', () => {
  const steady = (n: number, amount: number, from = 1): MerchantSlimTxn[] =>
    Array.from({ length: n }, (_, i) => txn(`2026-0${from + i}-05`, -amount))

  it('flags a hike when the recent median steps up', () => {
    const t = computePriceTrend([...steady(4, 10), txn('2026-05-05', -13), txn('2026-06-05', -13)])
    expect(t).not.toBeNull()
    expect(t?.direction).toBe('up')
    expect(t?.recentMedian).toBe(13)
    expect(t?.historicalMedian).toBe(10)
    expect(t?.pct).toBe(30)
  })

  it('flags a drop too', () => {
    const t = computePriceTrend([...steady(4, 20), txn('2026-05-05', -15), txn('2026-06-05', -15)])
    expect(t?.direction).toBe('down')
  })

  it('ignores sub-$0.50 / sub-8% drift and short histories', () => {
    expect(computePriceTrend([...steady(4, 10), txn('2026-05-05', -10.3)])).toBeNull()
    expect(computePriceTrend(steady(3, 10))).toBeNull()
  })
})

describe('computeTaxSummary', () => {
  it('rolls up tagged expenses by (tag, year) and skips tax:none', () => {
    const rows = computeTaxSummary([
      txn('2025-02-01', -100, { taxTag: 'tax:schedule-c-expense', taxYear: 2025 }),
      txn('2025-03-01', -50, { taxTag: 'tax:schedule-c-expense', taxYear: 2025 }),
      txn('2026-02-01', -75, { taxTag: 'tax:charitable', taxYear: 2026 }),
      txn('2026-03-01', -10, { taxTag: 'tax:none', taxYear: 2026 })
    ])
    expect(rows).toEqual([
      { taxTag: 'tax:charitable', taxYear: 2026, total: 75, count: 1 },
      { taxTag: 'tax:schedule-c-expense', taxYear: 2025, total: 150, count: 2 }
    ])
  })
})

describe('dominantCurrency', () => {
  it('defaults to USD on empty input and picks the most-seen currency', () => {
    expect(dominantCurrency([])).toBe('USD')
    expect(
      dominantCurrency([
        txn('2026-01-01', -1, { currency: 'CRC' }),
        txn('2026-01-02', -1, { currency: 'CRC' }),
        txn('2026-01-03', -1)
      ])
    ).toBe('CRC')
  })
})
