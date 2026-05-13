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
import { buildForecastChartData, buildTrajectoryChartData, groupEventsByWeek } from './Finance'

type Point = {
  accountId: number
  accountName: string
  assetClass: string
  isDebt: boolean
  date: string
  balance: number
}

const cash = (accountId: number, date: string, balance: number, name = 'Chase'): Point => ({
  accountId,
  accountName: name,
  assetClass: 'spending',
  isDebt: false,
  date,
  balance
})

const debt = (accountId: number, date: string, balance: number, name = 'Amex'): Point => ({
  accountId,
  accountName: name,
  assetClass: 'liability',
  isDebt: true,
  date,
  balance
})

describe('buildTrajectoryChartData', () => {
  it('returns [] for empty trajectory', () => {
    expect(buildTrajectoryChartData([])).toEqual([])
  })

  it('produces one point per unique date with assets - liabilities', () => {
    const out = buildTrajectoryChartData([cash(1, '2026-01-01', 1000), debt(2, '2026-01-01', 200)])
    expect(out).toEqual([{ date: '2026-01-01', net: 800 }])
  })

  it('forward-fills missing accounts on later dates', () => {
    // Day 1: both accounts captured. Day 2: only Chase captured. The
    // trajectory should still include the Amex liability from day 1 in
    // day 2's net calculation, NOT drop to assets-only.
    const out = buildTrajectoryChartData([
      cash(1, '2026-01-01', 1000),
      debt(2, '2026-01-01', 200),
      cash(1, '2026-01-02', 1100)
    ])
    expect(out).toEqual([
      { date: '2026-01-01', net: 800 }, // 1000 - 200
      { date: '2026-01-02', net: 900 } // 1100 - 200 (Amex forward-filled)
    ])
  })

  it('updates an account when a new snapshot lands for it', () => {
    const out = buildTrajectoryChartData([cash(1, '2026-01-01', 1000), cash(1, '2026-01-02', 1500)])
    expect(out.map((p) => p.net)).toEqual([1000, 1500])
  })

  it('sorts dates chronologically regardless of input order', () => {
    const out = buildTrajectoryChartData([
      cash(1, '2026-03-01', 300),
      cash(1, '2026-01-01', 100),
      cash(1, '2026-02-01', 200)
    ])
    expect(out.map((p) => p.date)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01'])
    expect(out.map((p) => p.net)).toEqual([100, 200, 300])
  })

  it('rounds to two decimals to avoid float-precision noise', () => {
    const out = buildTrajectoryChartData([
      {
        accountId: 1,
        accountName: 'A',
        assetClass: 'spending',
        isDebt: false,
        date: '2026-01-01',
        balance: 100.001
      },
      {
        accountId: 2,
        accountName: 'B',
        assetClass: 'liability',
        isDebt: true,
        date: '2026-01-01',
        balance: 0.005
      }
    ])
    // 100.001 - 0.005 = 99.996 → round to 100.0 (two decimals)
    expect(out[0].net).toBe(100)
  })

  it('classifies liabilities by isDebt, not by assetClass', () => {
    // Regression: a debt account whose Accounts-tab upsert never set
    // asset_class (so it stays at the default 'spending') was getting
    // bucketed as an ASSET in the chart even though the snapshot tiles
    // correctly subtracted it. With isDebt as the source of truth, both
    // sides agree.
    const out = buildTrajectoryChartData([
      cash(1, '2026-01-01', 1000),
      // is_debt=true but asset_class='spending' (Accounts upsert default).
      {
        accountId: 2,
        accountName: 'Misclassified Card',
        assetClass: 'spending',
        isDebt: true,
        date: '2026-01-01',
        balance: 300
      }
    ])
    // 1000 - 300 = 700, NOT 1300.
    expect(out[0].net).toBe(700)
  })
})

// ─── Forecast helpers ────────────────────────────────────────────────────────

type TrajectoryRow = { date: string; accountId: number; balance: number }

describe('buildForecastChartData', () => {
  it('returns empty shape for empty input', () => {
    expect(buildForecastChartData([])).toEqual({ points: [], accountIds: [] })
  })

  it('produces one point per date with one column per account', () => {
    const traj: TrajectoryRow[] = [
      { date: '2026-05-01', accountId: 1, balance: 1000 },
      { date: '2026-05-01', accountId: 2, balance: 500 },
      { date: '2026-05-15', accountId: 1, balance: 900 }
    ]
    const out = buildForecastChartData(traj)
    expect(out.accountIds).toEqual([1, 2])
    expect(out.points).toEqual([
      { date: '2026-05-01', acct_1: 1000, acct_2: 500 },
      { date: '2026-05-15', acct_1: 900, acct_2: 500 } // account 2 forward-filled
    ])
  })

  it('sorts dates chronologically', () => {
    const traj: TrajectoryRow[] = [
      { date: '2026-06-01', accountId: 1, balance: 300 },
      { date: '2026-04-01', accountId: 1, balance: 100 },
      { date: '2026-05-01', accountId: 1, balance: 200 }
    ]
    const out = buildForecastChartData(traj)
    expect(out.points.map((p) => p.date)).toEqual(['2026-04-01', '2026-05-01', '2026-06-01'])
  })

  it('keys account columns by id so Recharts can index them', () => {
    const traj: TrajectoryRow[] = [{ date: '2026-05-01', accountId: 42, balance: 100 }]
    const out = buildForecastChartData(traj)
    expect(out.points[0]).toHaveProperty('acct_42', 100)
  })
})

type ForecastEvent = {
  date: string
  accountId: number | null
  amount: number
  label: string
  source: 'subscription' | 'income' | 'debt' | 'calendar' | 'override'
  confidence: 'high' | 'medium' | 'low'
}

const ev = (date: string, label = 'x'): ForecastEvent => ({
  date,
  accountId: 1,
  amount: -10,
  label,
  source: 'subscription',
  confidence: 'high'
})

describe('groupEventsByWeek', () => {
  it('groups events into ISO weeks starting Monday', () => {
    // 2026-05-11 is a Monday. 2026-05-13 is the Wednesday in that week.
    // 2026-05-18 is the next Monday (start of the following week).
    const out = groupEventsByWeek([
      ev('2026-05-13', 'a'),
      ev('2026-05-18', 'b'),
      ev('2026-05-11', 'c')
    ])
    expect(out).toHaveLength(2)
    expect(out[0].weekStart).toBe('2026-05-11')
    expect(out[0].events.map((e) => e.label)).toEqual(['c', 'a'])
    expect(out[1].weekStart).toBe('2026-05-18')
    expect(out[1].events.map((e) => e.label)).toEqual(['b'])
  })

  it('treats Sunday as the last day of the previous Monday-based week', () => {
    // 2026-05-17 is a Sunday; its ISO-week Monday is 2026-05-11.
    const out = groupEventsByWeek([ev('2026-05-17', 'sun'), ev('2026-05-11', 'mon')])
    expect(out).toHaveLength(1)
    expect(out[0].weekStart).toBe('2026-05-11')
  })

  it('returns [] for empty input', () => {
    expect(groupEventsByWeek([])).toEqual([])
  })

  it('sorts weeks chronologically', () => {
    const out = groupEventsByWeek([ev('2026-07-06'), ev('2026-05-04'), ev('2026-06-01')])
    expect(out.map((w) => w.weekStart)).toEqual(['2026-05-04', '2026-06-01', '2026-07-06'])
  })
})
