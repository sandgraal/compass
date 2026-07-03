import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addComp,
  buildRentalStudio,
  deleteComp,
  getSettings,
  getUnits,
  importComps,
  listComps,
  parseRentalCompsCsv,
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

describe('parseRentalCompsCsv (retire-early-hub cabin-tracker export)', () => {
  // The real export's header row.
  const HEADERS = [
    'name',
    'zone',
    'bedrooms',
    'maxGuests',
    'nightlyUSD',
    'cleaningUSD',
    'minNights',
    'rating',
    'reviewCount',
    'occupancyPct',
    'amenities',
    'notes',
    'url'
  ]

  it('maps columns and folds maxGuests / notes into the notes field', () => {
    const rows = [
      // name, zone, br, guests, nightly, clean, min, rating, reviews, occ, amenities, notes, url
      [
        'La Margarita Cabin',
        'Cartago',
        '2',
        '2',
        '41',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        'https://airbnb/1'
      ],
      [
        'Cartago 1BR — mid, well-reviewed', // embedded comma survives (readCsv handles quoting upstream)
        'Cartago',
        '1',
        '2',
        '58',
        '',
        '',
        '',
        '',
        '21',
        '',
        'Market estimate — anchor ×0.73',
        ''
      ]
    ]
    const comps = parseRentalCompsCsv(HEADERS, rows)
    expect(comps.length).toBe(2)
    expect(comps[0]).toMatchObject({
      name: 'La Margarita Cabin',
      zone: 'Cartago',
      bedrooms: 2,
      nightlyUsd: 41,
      url: 'https://airbnb/1'
    })
    // Blank numeric cells become null, not 0.
    expect(comps[0].rating).toBeNull()
    expect(comps[0].reviewCount).toBeNull()
    // maxGuests has no schema column → folded into notes.
    expect(comps[0].notes).toBe('sleeps 2')
    // occupancyPct is captured; notes column + maxGuests both fold in, notes first.
    expect(comps[1].occupancyPct).toBe(21)
    expect(comps[1].notes).toBe('Market estimate — anchor ×0.73 · sleeps 2')
  })

  it('defaults zone/bedrooms, clamps bedrooms, and skips empty rows', () => {
    const rows = [
      ['', '', '', '', '', '', '', '', '', '', '', '', ''], // fully empty → skipped
      ['Big House', '', '99', '', '148', '', '', '', '', '', '', '', ''] // no zone, huge br
    ]
    const comps = parseRentalCompsCsv(HEADERS, rows)
    expect(comps.length).toBe(1)
    expect(comps[0]).toMatchObject({ name: 'Big House', zone: 'Cartago', bedrooms: 20 })
    expect(comps[0].notes).toBeNull()
  })

  it('rejects a CSV with no name column (returns no comps → caller errors)', () => {
    // An unrelated CSV that happens to have a nightly-like column must not seed
    // empty-name junk rows into the comps table.
    expect(parseRentalCompsCsv(['nightly', 'zone'], [['80', 'Cartago']])).toEqual([])
  })

  it('tolerates reordered / partial headers', () => {
    const comps = parseRentalCompsCsv(
      ['url', 'nightly', 'name'],
      [['https://x/9', '72', 'Orosi Lodge']]
    )
    expect(comps[0]).toMatchObject({
      name: 'Orosi Lodge',
      nightlyUsd: 72,
      url: 'https://x/9',
      bedrooms: 2
    })
  })
})

describe('importComps', () => {
  it('inserts parsed comps and dedups on re-import', () => {
    const parsed = parseRentalCompsCsv(
      ['name', 'zone', 'bedrooms', 'nightlyUSD'],
      [
        ['Cabin A', 'Cartago', '2', '90'],
        ['Cabin B', 'Orosi Valley', '1', '60']
      ]
    )
    const first = importComps(sqlite, parsed)
    expect(first).toEqual({ imported: 2, skipped: 0 })
    expect(listComps(sqlite).length).toBe(2)

    // Re-importing the same file is a no-op (dedup by name+nightly+zone).
    const second = importComps(sqlite, parsed)
    expect(second).toEqual({ imported: 0, skipped: 2 })
    expect(listComps(sqlite).length).toBe(2)
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
