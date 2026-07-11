/**
 * Per-trip cost bundles — travel_segments × finance × timeline. Real in-memory
 * SQLite mirroring the relevant columns.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildTripBundles } from './trip-bundles'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE travel_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL, start_date TEXT NOT NULL,
      end_date TEXT NOT NULL, notes TEXT, source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, date TEXT NOT NULL,
      amount REAL NOT NULL, currency TEXT DEFAULT 'USD', description TEXT NOT NULL DEFAULT '', category TEXT
    );
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
      title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
  `)
})
afterEach(() => db.close())

function trip(country: string, startDate: string, endDate: string, source = 'manual'): void {
  db.prepare(
    'INSERT INTO travel_segments (country, start_date, end_date, source) VALUES (?,?,?,?)'
  ).run(country, startDate, endDate, source)
}
function txn(date: string, amount: number, category: string, currency = 'USD'): void {
  db.prepare(
    'INSERT INTO finance_transactions (hash, date, amount, currency, category) VALUES (?,?,?,?,?)'
  ).run(`${date}-${amount}-${category}-${Math.random()}`, date, amount, currency, category)
}
let recN = 0
function rec(ymd: string): void {
  recN++
  db.prepare(
    'INSERT INTO records (source, type, occurred_at, title, dedup_hash) VALUES (?,?,?,?,?)'
  ).run('amazon', 'order', new Date(`${ymd}T12:00:00`).getTime(), `rec ${recN}`, `tb-${recN}`)
}

describe('buildTripBundles', () => {
  it('joins a trip to the spend + timeline events that fell within its window', () => {
    trip('CR', '2026-02-01', '2026-02-14')
    txn('2026-02-03', -200, 'Dining')
    txn('2026-02-05', -150, 'Lodging')
    txn('2026-02-06', -1000, 'Transfers') // excluded from spend
    txn('2026-01-20', -500, 'Dining') // before the trip → excluded
    rec('2026-02-03')
    rec('2026-02-10')
    rec('2026-03-01') // outside the trip → not counted

    const [b] = buildTripBundles(db)
    expect(b.countryName).toBe('Costa Rica')
    expect(b.days).toBe(14)
    expect(b.spend).toBe(350) // 200 + 150; transfer + pre-trip excluded
    expect(b.recordCount).toBe(2)
    expect(b.topCategories[0]).toEqual({ category: 'Dining', amount: 200 })
  })

  it('returns a zeroed bundle for a trip with no spend or activity', () => {
    trip('ES', '2025-09-01', '2025-09-05')
    const [b] = buildTripBundles(db)
    expect(b).toMatchObject({ spend: 0, recordCount: 0, topCategories: [], days: 5 })
  })

  it('orders trips newest-first and returns [] when travel_segments is absent', () => {
    trip('CR', '2026-02-01', '2026-02-14')
    trip('US', '2026-06-01', '2026-06-10')
    expect(buildTripBundles(db).map((b) => b.country)).toEqual(['US', 'CR'])
    db.exec('DROP TABLE travel_segments')
    expect(buildTripBundles(db)).toEqual([])
  })

  it('still works when finance/records tables are absent (older DB)', () => {
    trip('CR', '2026-02-01', '2026-02-14')
    db.exec('DROP TABLE finance_transactions; DROP TABLE records;')
    const [b] = buildTripBundles(db)
    expect(b).toMatchObject({ spend: 0, recordCount: 0 })
  })
})
