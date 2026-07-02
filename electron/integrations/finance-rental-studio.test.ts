import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addComp,
  buildRentalStudio,
  deleteComp,
  getSettings,
  getUnits,
  listComps,
  setSettings,
  setUnits,
  studioPlanAnnualNet,
  updateComp
} from './finance-rental-studio'

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE fx_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, base TEXT NOT NULL,
      quote TEXT NOT NULL, rate REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual', fetched_at INTEGER
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD', tax_tag TEXT NOT NULL DEFAULT 'tax:none',
      geo TEXT NOT NULL DEFAULT 'US', purpose TEXT
    );
    CREATE TABLE rental_comps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
      zone TEXT NOT NULL DEFAULT 'Cartago', bedrooms INTEGER NOT NULL DEFAULT 2,
      nightly_usd REAL, occupancy_pct REAL, rating REAL, review_count INTEGER,
      notes TEXT, saved_at TEXT, created_at INTEGER, updated_at INTEGER
    );
  `)
  return sqlite
}

let sqlite: Database.Database
beforeEach(() => {
  sqlite = makeDb()
})

describe('rental comps CRUD', () => {
  it('adds, lists, updates, and deletes comps', () => {
    const id = addComp(sqlite, {
      name: 'Cabin A',
      zone: 'Orosi Valley',
      bedrooms: 2,
      nightlyUsd: 95
    })
    addComp(sqlite, { name: 'Cabin B', bedrooms: 1, nightlyUsd: 60 })
    let rows = listComps(sqlite)
    expect(rows.length).toBe(2)
    expect(rows[0]).toMatchObject({
      name: 'Cabin A',
      zone: 'Orosi Valley',
      bedrooms: 2,
      nightlyUsd: 95
    })

    updateComp(sqlite, id, { nightlyUsd: 110, notes: 'raised' })
    rows = listComps(sqlite)
    const a = rows.find((r) => r.id === id)
    expect(a?.nightlyUsd).toBe(110)
    expect(a?.notes).toBe('raised')

    deleteComp(sqlite, id)
    expect(listComps(sqlite).length).toBe(1)
  })

  it('defaults unset fields (zone, bedrooms) and tolerates a partial update', () => {
    const id = addComp(sqlite, { name: 'Bare' })
    const row = listComps(sqlite)[0]
    expect(row.zone).toBe('Cartago')
    expect(row.bedrooms).toBe(2)
    expect(row.nightlyUsd).toBeNull()
    updateComp(sqlite, id, {}) // no-op patch
    expect(listComps(sqlite)[0].name).toBe('Bare')
  })
})

describe('units + settings (JSON in app_settings)', () => {
  it('round-trips units', () => {
    expect(getUnits(sqlite)).toEqual([])
    setUnits(sqlite, [
      { id: 'u1', name: 'Studio', bedrooms: 1, occupancy: 0.5, nightlyOverride: 80 }
    ])
    const units = getUnits(sqlite)
    expect(units.length).toBe(1)
    expect(units[0]).toMatchObject({ name: 'Studio', nightlyOverride: 80 })
  })

  it('defaults settings then round-trips a partial patch', () => {
    expect(getSettings(sqlite)).toEqual({ includeInPlan: true, rentalYears: 20 })
    setSettings(sqlite, { rentalYears: 10 })
    expect(getSettings(sqlite)).toEqual({ includeInPlan: true, rentalYears: 10 })
    setSettings(sqlite, { includeInPlan: false })
    expect(getSettings(sqlite)).toEqual({ includeInPlan: false, rentalYears: 10 })
  })
})

describe('buildRentalStudio', () => {
  it('assembles totals from comps + units and flags untagged actuals', () => {
    addComp(sqlite, { name: 'A', bedrooms: 2, nightlyUsd: 90 })
    addComp(sqlite, { name: 'B', bedrooms: 2, nightlyUsd: 110 })
    setUnits(sqlite, [{ id: 'u1', name: 'Cabin', bedrooms: 2, occupancy: 0.5 }])

    const r = buildRentalStudio(sqlite)
    expect(r.baseCurrency).toBe('USD')
    expect(r.comps.length).toBe(2)
    expect(r.units.length).toBe(1)
    expect(r.totals.annualNet).toBeGreaterThan(0)
    // No Schedule-E-tagged income yet → actuals 0, deltaPct null, explanatory note.
    expect(r.reconciliation.actualsNetOperating).toBe(0)
    expect(r.reconciliation.deltaPct).toBeNull()
    expect(r.reconciliation.note).toMatch(/tax:schedule-e-income/)
  })

  it('reconciles against tagged Schedule-E actuals', () => {
    addComp(sqlite, { name: 'A', bedrooms: 2, nightlyUsd: 100 })
    setUnits(sqlite, [{ id: 'u1', name: 'Cabin', bedrooms: 2, occupancy: 0.5 }])
    // A tagged Airbnb payout → the property P&L now has real revenue.
    sqlite
      .prepare(
        "INSERT INTO finance_transactions (date, amount, currency, tax_tag, geo) VALUES ('2026-03-01', 24000, 'USD', 'tax:schedule-e-income', 'CR')"
      )
      .run()
    const r = buildRentalStudio(sqlite)
    expect(r.reconciliation.actualsNetOperating).toBe(24000)
    expect(r.reconciliation.actualsYear).toBe(2026)
    expect(r.reconciliation.deltaPct).not.toBeNull()
    expect(r.reconciliation.note).toMatch(/actual net operating/)
  })
})

describe('studioPlanAnnualNet', () => {
  it('is the projected net when included, 0 when excluded', () => {
    addComp(sqlite, { name: 'A', bedrooms: 2, nightlyUsd: 120 })
    setUnits(sqlite, [{ id: 'u1', name: 'Cabin', bedrooms: 2, occupancy: 0.6 }])
    expect(studioPlanAnnualNet(sqlite)).toBeGreaterThan(0)
    setSettings(sqlite, { includeInPlan: false })
    expect(studioPlanAnnualNet(sqlite)).toBe(0)
  })
})
