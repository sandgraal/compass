/**
 * Tests for the pure helpers exported from Finance.tsx. The component itself
 * is React-rendered and is exercised manually via npm run dev — we don't
 * have a React Testing Library setup yet (separate decision).
 *
 * `buildTrajectoryChartData` is the one piece with non-trivial logic
 * (forward-fill of latest balance per account across days) and benefits
 * from focused tests.
 */

import { describe, expect, it } from 'vitest'
import { buildTrajectoryChartData } from './Finance'

const isLiability = (c: string) => c === 'liability'

describe('buildTrajectoryChartData', () => {
  it('returns [] for empty trajectory', () => {
    expect(buildTrajectoryChartData([], isLiability)).toEqual([])
  })

  it('produces one point per unique date with assets - liabilities', () => {
    const out = buildTrajectoryChartData(
      [
        {
          accountId: 1,
          accountName: 'Chase',
          assetClass: 'spending',
          date: '2026-01-01',
          balance: 1000
        },
        {
          accountId: 2,
          accountName: 'Amex',
          assetClass: 'liability',
          date: '2026-01-01',
          balance: 200
        }
      ],
      isLiability
    )
    expect(out).toEqual([{ date: '2026-01-01', net: 800 }])
  })

  it('forward-fills missing accounts on later dates', () => {
    // Day 1: both accounts captured. Day 2: only Chase captured. The
    // trajectory should still include the Amex liability from day 1 in
    // day 2's net calculation, NOT drop to assets-only.
    const out = buildTrajectoryChartData(
      [
        {
          accountId: 1,
          accountName: 'Chase',
          assetClass: 'spending',
          date: '2026-01-01',
          balance: 1000
        },
        {
          accountId: 2,
          accountName: 'Amex',
          assetClass: 'liability',
          date: '2026-01-01',
          balance: 200
        },
        {
          accountId: 1,
          accountName: 'Chase',
          assetClass: 'spending',
          date: '2026-01-02',
          balance: 1100
        }
      ],
      isLiability
    )
    expect(out).toEqual([
      { date: '2026-01-01', net: 800 }, // 1000 - 200
      { date: '2026-01-02', net: 900 } // 1100 - 200 (Amex forward-filled)
    ])
  })

  it('updates an account when a new snapshot lands for it', () => {
    const out = buildTrajectoryChartData(
      [
        {
          accountId: 1,
          accountName: 'A',
          assetClass: 'spending',
          date: '2026-01-01',
          balance: 1000
        },
        {
          accountId: 1,
          accountName: 'A',
          assetClass: 'spending',
          date: '2026-01-02',
          balance: 1500
        }
      ],
      isLiability
    )
    expect(out.map((p) => p.net)).toEqual([1000, 1500])
  })

  it('sorts dates chronologically regardless of input order', () => {
    const out = buildTrajectoryChartData(
      [
        {
          accountId: 1,
          accountName: 'A',
          assetClass: 'spending',
          date: '2026-03-01',
          balance: 300
        },
        {
          accountId: 1,
          accountName: 'A',
          assetClass: 'spending',
          date: '2026-01-01',
          balance: 100
        },
        { accountId: 1, accountName: 'A', assetClass: 'spending', date: '2026-02-01', balance: 200 }
      ],
      isLiability
    )
    expect(out.map((p) => p.date)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01'])
    expect(out.map((p) => p.net)).toEqual([100, 200, 300])
  })

  it('rounds to two decimals to avoid float-precision noise', () => {
    const out = buildTrajectoryChartData(
      [
        {
          accountId: 1,
          accountName: 'A',
          assetClass: 'spending',
          date: '2026-01-01',
          balance: 100.001
        },
        {
          accountId: 2,
          accountName: 'B',
          assetClass: 'liability',
          date: '2026-01-01',
          balance: 0.005
        }
      ],
      isLiability
    )
    // 100.001 - 0.005 = 99.996 → round to 100.0 (two decimals)
    expect(out[0].net).toBe(100)
  })
})
