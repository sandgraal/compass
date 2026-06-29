import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type PropertyConfig,
  bucketFor,
  buildDepreciationSchedule,
  buildPropertyPnl
} from './finance-property'

describe('bucketFor', () => {
  const base = { geo: null, purpose: null }
  it('routes capex tags + CR capex purpose to capex (wins over operating)', () => {
    expect(bucketFor({ ...base, tax_tag: 'tax:capex-airbnb' })).toBe('capex')
    expect(bucketFor({ tax_tag: 'tax:none', geo: 'CR', purpose: 'capex' })).toBe('capex')
    // capex precedence: a capex tag with an operating purpose is still capex.
    expect(bucketFor({ tax_tag: 'tax:capex-airbnb', geo: 'CR', purpose: 'operating' })).toBe(
      'capex'
    )
  })
  it('routes schedule-e-expense + CR operating to operating', () => {
    expect(bucketFor({ ...base, tax_tag: 'tax:schedule-e-expense' })).toBe('operating')
    expect(bucketFor({ tax_tag: 'tax:none', geo: 'CR', purpose: 'operating' })).toBe('operating')
  })
  it('routes schedule-e-income to revenue', () => {
    expect(bucketFor({ ...base, tax_tag: 'tax:schedule-e-income' })).toBe('revenue')
  })
  it('ignores unrelated rows', () => {
    expect(bucketFor({ tax_tag: 'tax:none', geo: 'US', purpose: null })).toBeNull()
    expect(bucketFor({ tax_tag: 'tax:none', geo: 'CR', purpose: 'household' })).toBeNull()
  })
})

describe('buildDepreciationSchedule', () => {
  it('returns [] without an in-service date or basis', () => {
    expect(
      buildDepreciationSchedule({
        depreciableBasis: 100000,
        placedInService: null,
        recoveryYears: 30
      })
    ).toEqual([])
    expect(
      buildDepreciationSchedule({
        depreciableBasis: 0,
        placedInService: '2024-01-01',
        recoveryYears: 30
      })
    ).toEqual([])
  })

  it('prorates the first year by the mid-month convention', () => {
    // Placed in service July (month 7): first-year fraction = (12-7+0.5)/12 = 5.5/12.
    const sched = buildDepreciationSchedule({
      depreciableBasis: 300000,
      placedInService: '2024-07-15',
      recoveryYears: 30
    })
    const annual = 300000 / 30 // 10,000
    expect(sched[0].year).toBe(2024)
    expect(sched[0].depreciation).toBeCloseTo(annual * (5.5 / 12), 2) // ≈ 4583.33
    expect(sched[1].depreciation).toBeCloseTo(annual, 2) // full year
  })

  it('fully depreciates the basis (accumulated reaches basis, remaining hits 0)', () => {
    const sched = buildDepreciationSchedule({
      depreciableBasis: 30000,
      placedInService: '2024-01-10', // month 1 → first-year fraction 11.5/12
      recoveryYears: 30
    })
    const last = sched[sched.length - 1]
    expect(last.remainingBasis).toBe(0)
    expect(last.accumulated).toBeCloseTo(30000, 2)
    const sum = sched.reduce((s, y) => s + y.depreciation, 0)
    expect(sum).toBeCloseTo(30000, 2)
  })

  it('defaults to a 30-year recovery span (foreign ADS)', () => {
    const sched = buildDepreciationSchedule({
      depreciableBasis: 300000,
      placedInService: '2024-01-01',
      recoveryYears: 30
    })
    // Jan placement: ~30.something calendar years until basis exhausts.
    expect(sched.length).toBeGreaterThanOrEqual(30)
    expect(sched.length).toBeLessThanOrEqual(32)
  })
})

// ─── buildPropertyPnl (real DB) ──────────────────────────────────────────────

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE fx_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL,
      rate REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual', fetched_at INTEGER
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
      description TEXT NOT NULL DEFAULT '', tax_tag TEXT NOT NULL DEFAULT 'tax:none',
      geo TEXT NOT NULL DEFAULT 'US', purpose TEXT
    );
  `)
  return sqlite
}

function addTxn(
  sqlite: Database.Database,
  t: {
    date: string
    amount: number
    currency?: string
    taxTag?: string
    geo?: string
    purpose?: string | null
  }
): void {
  sqlite
    .prepare(
      'INSERT INTO finance_transactions (date, amount, currency, tax_tag, geo, purpose) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      t.date,
      t.amount,
      t.currency ?? 'USD',
      t.taxTag ?? 'tax:none',
      t.geo ?? 'US',
      t.purpose ?? null
    )
}

function addRate(sqlite: Database.Database, date: string, quote: string, rate: number): void {
  sqlite
    .prepare("INSERT INTO fx_rates (date, base, quote, rate) VALUES (?, 'USD', ?, ?)")
    .run(date, quote, rate)
}

const CFG: PropertyConfig = {
  placedInService: '2024-06-15',
  landValue: 0,
  recoveryYears: 30,
  basisOverride: null
}

let sqlite: Database.Database
beforeEach(() => {
  sqlite = makeDb()
})

describe('buildPropertyPnl', () => {
  it('values colón capex in USD and accumulates it into the cost basis', () => {
    // ₡10,000,000 of CR construction at ₡500/$1 = $20,000 capex.
    addRate(sqlite, '2024-03-01', 'CRC', 500)
    addTxn(sqlite, {
      date: '2024-03-10',
      amount: -10_000_000,
      currency: 'CRC',
      taxTag: 'tax:capex-airbnb',
      geo: 'CR',
      purpose: 'capex'
    })

    const pnl = buildPropertyPnl(sqlite, CFG)
    expect(pnl.baseCurrency).toBe('USD')
    expect(pnl.totals.capex).toBe(20_000)
    expect(pnl.basisToDate).toBe(20_000)
    expect(pnl.byYear[0]).toMatchObject({ year: 2024, capex: 20_000 })
  })

  it('buckets revenue / operating / capex by year and computes net', () => {
    addRate(sqlite, '2024-01-01', 'CRC', 500)
    // Revenue (USD Airbnb payout, user-tagged schedule-e-income).
    addTxn(sqlite, { date: '2024-05-01', amount: 3000, taxTag: 'tax:schedule-e-income' })
    // Operating: ₡250,000 CR utilities at 500 = $500.
    addTxn(sqlite, {
      date: '2024-05-02',
      amount: -250_000,
      currency: 'CRC',
      geo: 'CR',
      purpose: 'operating'
    })
    // Capex: $8,000 USD materials tagged capex-airbnb.
    addTxn(sqlite, { date: '2024-04-01', amount: -8000, taxTag: 'tax:capex-airbnb' })

    const pnl = buildPropertyPnl(sqlite, CFG)
    const y = pnl.byYear.find((r) => r.year === 2024)
    expect(y).toMatchObject({ revenue: 3000, operating: 500, capex: 8000, netOperating: 2500 })
    expect(pnl.totals.netOperating).toBe(2500)
    // net yield on basis = 2500 / 8000.
    expect(pnl.netYieldOnBasis).toBeCloseTo(2500 / 8000, 4)
  })

  it('subtracts land from the depreciable basis and derives the schedule', () => {
    addTxn(sqlite, { date: '2024-04-01', amount: -300_000, taxTag: 'tax:capex-airbnb' })
    const pnl = buildPropertyPnl(sqlite, {
      ...CFG,
      landValue: 50_000,
      placedInService: '2024-01-01'
    })
    expect(pnl.basisToDate).toBe(300_000)
    expect(pnl.depreciableBasis).toBe(250_000) // 300k - 50k land
    expect(pnl.depreciation.length).toBeGreaterThan(0)
    expect(pnl.depreciation[0].depreciation).toBeCloseTo((250_000 / 30) * (11.5 / 12), 1)
  })

  it('honors a basis override', () => {
    addTxn(sqlite, { date: '2024-04-01', amount: -10_000, taxTag: 'tax:capex-airbnb' })
    const pnl = buildPropertyPnl(sqlite, { ...CFG, basisOverride: 400_000, landValue: 0 })
    expect(pnl.basisToDate).toBe(10_000) // accumulated capex unchanged
    expect(pnl.depreciableBasis).toBe(400_000) // override drives depreciation
  })

  it('counts rows it cannot value in base currency (no FX rate)', () => {
    // CRC capex but no CRC rate on file → unconvertible, excluded from totals.
    addTxn(sqlite, {
      date: '2024-03-10',
      amount: -1_000_000,
      currency: 'CRC',
      taxTag: 'tax:capex-airbnb'
    })
    const pnl = buildPropertyPnl(sqlite, CFG)
    expect(pnl.unconvertedCount).toBe(1)
    expect(pnl.totals.capex).toBe(0)
  })

  it('reports an empty P&L (and no schedule) when nothing is tagged', () => {
    addTxn(sqlite, { date: '2024-05-01', amount: -100, geo: 'US' }) // unrelated
    const pnl = buildPropertyPnl(sqlite, CFG)
    expect(pnl.byYear).toEqual([])
    expect(pnl.totals.netOperating).toBe(0)
    expect(pnl.depreciation).toEqual([]) // basis 0 → nothing to depreciate
    expect(pnl.netYieldOnBasis).toBeNull()
  })
})
