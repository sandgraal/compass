import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CAJA_RATE_PCT_DEFAULT,
  addTravelSegment,
  buildResidencySummary,
  cajaEstimate,
  crResidencyCheck,
  dayCountsForYear,
  daysInYear,
  deleteTravelSegment,
  getResidencyConfig,
  listTravelSegments,
  residencyPathways,
  segmentDaysInYear,
  setResidencyConfig,
  substantialPresenceTest
} from './residency'

describe('day counting', () => {
  it('counts calendar days per year (leap-aware)', () => {
    expect(daysInYear(2024)).toBe(366)
    expect(daysInYear(2025)).toBe(365)
  })

  it('counts a segment’s in-year days inclusively, clipped to the year', () => {
    // 2024-01-01..2024-03-31 = 31 + 29 (leap) + 31 = 91 days.
    expect(
      segmentDaysInYear({ country: 'CR', startDate: '2024-01-01', endDate: '2024-03-31' }, 2024)
    ).toBe(91)
    // A segment spanning a year boundary only counts the in-year part.
    expect(
      segmentDaysInYear({ country: 'CR', startDate: '2023-12-20', endDate: '2024-01-10' }, 2024)
    ).toBe(10)
    // No overlap → 0.
    expect(
      segmentDaysInYear({ country: 'CR', startDate: '2023-01-01', endDate: '2023-06-01' }, 2024)
    ).toBe(0)
  })

  it('fills the home country with the year remainder, ignoring home segments', () => {
    const segs = [
      { country: 'CR', startDate: '2024-01-01', endDate: '2024-03-31' }, // 91
      { country: 'ES', startDate: '2024-07-01', endDate: '2024-07-10' }, // 10
      { country: 'US', startDate: '2024-09-01', endDate: '2024-09-30' } // home → ignored
    ]
    const counts = dayCountsForYear(segs, 'US', 2024)
    expect(counts.CR).toBe(91)
    expect(counts.ES).toBe(10)
    expect(counts.US).toBe(366 - 101) // remainder
  })
})

describe('substantialPresenceTest', () => {
  it('weights current + prior1/3 + prior2/6 and applies the 183 threshold', () => {
    const under = substantialPresenceTest(120, 120, 120) // 120+40+20 = 180
    expect(under.weightedDays).toBe(180)
    expect(under.meetsTest).toBe(false)
    const over = substantialPresenceTest(130, 130, 130) // 195
    expect(over.meetsTest).toBe(true)
  })

  it('fails the 31-day current-year gate even with huge prior years', () => {
    const r = substantialPresenceTest(20, 365, 365) // weighted huge but current < 31
    expect(r.weightedDays).toBeGreaterThan(183)
    expect(r.meetsTest).toBe(false)
  })
})

describe('crResidencyCheck + pathways + caja', () => {
  it('flags CR residency at ≥183 days', () => {
    expect(crResidencyCheck(182).meets).toBe(false)
    expect(crResidencyCheck(183).meets).toBe(true)
  })

  it('checks pensionado / rentista / inversionista thresholds', () => {
    const p = residencyPathways({
      pensionMonthly: 1200,
      rentaMonthly: 2000,
      investmentUsd: 200_000
    })
    expect(p.find((x) => x.id === 'pensionado')?.meets).toBe(true) // 1200 ≥ 1000
    expect(p.find((x) => x.id === 'rentista')?.meets).toBe(false) // 2000 < 2500
    expect(p.find((x) => x.id === 'inversionista')?.meets).toBe(true) // 200k ≥ 150k
  })

  it('estimates CAJA as a % of declared income', () => {
    const c = cajaEstimate(3000, 11)
    expect(c.monthlyUsd).toBe(330) // 3000 * 11%
    expect(c.annualUsd).toBe(3960)
  })
})

// ─── DB layer ────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE travel_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL,
      start_date TEXT NOT NULL, end_date TEXT NOT NULL, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER
    );
    CREATE TABLE fx_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, base TEXT NOT NULL,
      quote TEXT NOT NULL, rate REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual', fetched_at INTEGER
    );
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, is_debt INTEGER DEFAULT 0,
      balance REAL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', asset_class TEXT NOT NULL DEFAULT 'spending'
    );
    CREATE TABLE finance_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
      captured_at INTEGER NOT NULL, balance REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual'
    );
  `)
  return sqlite
}

let sqlite: Database.Database
beforeEach(() => {
  sqlite = makeDb()
})

describe('travel segment CRUD + config', () => {
  it('adds, lists (newest-first), and deletes segments', () => {
    addTravelSegment(sqlite, { country: 'cr', startDate: '2024-01-01', endDate: '2024-03-31' })
    const id2 = addTravelSegment(sqlite, {
      country: 'ES',
      startDate: '2024-07-01',
      endDate: '2024-07-10'
    })
    let list = listTravelSegments(sqlite)
    expect(list).toHaveLength(2)
    expect(list[0].startDate).toBe('2024-07-01') // newest first
    expect(list[1].country).toBe('CR') // uppercased on insert
    deleteTravelSegment(sqlite, id2)
    list = listTravelSegments(sqlite)
    expect(list).toHaveLength(1)
    expect(list[0].country).toBe('CR')
  })

  it('defaults config then round-trips a patch (home upper-cased, investment nullable)', () => {
    const d = getResidencyConfig(sqlite)
    expect(d.homeCountry).toBe('US')
    expect(d.cajaRatePct).toBe(CAJA_RATE_PCT_DEFAULT)
    expect(d.investmentUsd).toBeNull()
    setResidencyConfig(sqlite, { homeCountry: 'us', pensionMonthly: 1200, investmentUsd: 250_000 })
    const cfg = getResidencyConfig(sqlite)
    expect(cfg.homeCountry).toBe('US')
    expect(cfg.pensionMonthly).toBe(1200)
    expect(cfg.investmentUsd).toBe(250_000)
    setResidencyConfig(sqlite, { investmentUsd: null })
    expect(getResidencyConfig(sqlite).investmentUsd).toBeNull()
  })
})

describe('buildResidencySummary', () => {
  function seedProperty(value: number): void {
    const info = sqlite
      .prepare(
        "INSERT INTO finance_accounts (name, asset_class) VALUES ('CR Property', 'real_estate')"
      )
      .run()
    sqlite
      .prepare(
        'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance) VALUES (?, ?, ?)'
      )
      .run(Number(info.lastInsertRowid), Date.now(), value)
  }

  it('assembles day counts, SPT, CR residency, pathways (investment from net worth), CAJA', () => {
    seedProperty(180_000) // → inversionista default
    // Spend most of 2024 + 2023 in CR (heavy CR presence, light US).
    addTravelSegment(sqlite, { country: 'CR', startDate: '2024-01-01', endDate: '2024-10-31' }) // 305 days
    addTravelSegment(sqlite, { country: 'CR', startDate: '2023-01-01', endDate: '2023-12-31' }) // 365
    setResidencyConfig(sqlite, { cajaMonthlyIncome: 3000 })

    const s = buildResidencySummary(sqlite, 2024)
    expect(s.years[0].year).toBe(2024)
    const cr2024 = s.years[0].countries.find((c) => c.country === 'CR')?.days
    expect(cr2024).toBe(305)
    expect(s.crResidency.meets).toBe(true) // 305 ≥ 183
    // US 2024 = 366-305 = 61; 2023 US = 0; SPT weighted = 61 → under 183.
    expect(s.substantialPresence.usCurrent).toBe(61)
    expect(s.substantialPresence.meetsTest).toBe(false)
    // Inversionista pathway uses the net-worth property value (180k ≥ 150k).
    expect(s.investmentUsd).toBe(180_000)
    expect(s.pathways.find((p) => p.id === 'inversionista')?.meets).toBe(true)
    expect(s.caja.monthlyUsd).toBe(330)
  })

  it('honors an investment override instead of net worth', () => {
    seedProperty(180_000)
    setResidencyConfig(sqlite, { investmentUsd: 50_000 })
    const s = buildResidencySummary(sqlite, 2024)
    expect(s.investmentUsd).toBe(50_000)
    expect(s.pathways.find((p) => p.id === 'inversionista')?.meets).toBe(false)
  })
})
