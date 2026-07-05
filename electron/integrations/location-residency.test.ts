/**
 * Integration test (Phase 10.8): raw location points → derived travel segments →
 * the existing residency engine. Verifies the projector writes source='location'
 * rows, never touches manual rows, is idempotent, and that derived days flow into
 * the day-count / substantial-presence math WITHOUT double-counting an overlapping
 * manual trip (the unique-day guarantee).
 *
 * Uses real coordinates through the real offline point-in-polygon set, so this also
 * exercises `countryForPoint` end-to-end. Dates use the current year + spans (not
 * exact strings) to stay leap/TZ tolerant, per the residency test convention.
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { deriveLocationSegments } from './location-residency'
import { addTravelSegment, buildResidencySummary } from './residency'

const YEAR = new Date().getFullYear()
const CR: [number, number] = [9.93, -84.08] // San José
const US: [number, number] = [40.71, -74.01] // New York City

function makeDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE travel_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL,
      start_date TEXT NOT NULL, end_date TEXT NOT NULL, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER
    );
    CREATE TABLE location_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL,
      lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL, src TEXT NOT NULL,
      dedup_hash TEXT NOT NULL UNIQUE, ingested_at INTEGER
    );
  `)
  // Pin investmentUsd so buildResidencySummary never reaches the net-worth tables.
  sqlite
    .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run('residencyInvestmentUsd', '150000', 1)
  return sqlite
}

let sqlite: Database.Database
beforeEach(() => {
  sqlite = makeDb()
})

/** Insert `count` daily points starting `startDom` March at noon UTC at [lat,lng]. */
function seedDailyPoints(
  [lat, lng]: [number, number],
  startDom: number,
  count: number,
  tag: string
): void {
  const insert = sqlite.prepare(
    'INSERT INTO location_points (occurred_at, lat, lng, accuracy, src, dedup_hash, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  for (let i = 0; i < count; i++) {
    const at = Date.UTC(YEAR, 2, startDom + i, 12)
    insert.run(at, lat, lng, null, 'google', `${tag}-${i}`, 1)
  }
}

function segments(): Array<{
  country: string
  source: string
  startDate: string
  endDate: string
}> {
  return sqlite
    .prepare(
      'SELECT country, source, start_date AS startDate, end_date AS endDate FROM travel_segments ORDER BY start_date'
    )
    .all() as Array<{ country: string; source: string; startDate: string; endDate: string }>
}

describe('deriveLocationSegments', () => {
  it('writes source=location segments, preserves manual rows, and is idempotent', () => {
    addTravelSegment(sqlite, {
      country: 'ES',
      startDate: `${YEAR}-06-01`,
      endDate: `${YEAR}-06-10`
    })
    seedDailyPoints(CR, 10, 10, 'cr')

    const r1 = deriveLocationSegments(sqlite, 1)
    expect(r1.derived).toBe(1)
    expect(r1.removed).toBe(0)

    const after = segments()
    expect(after.find((s) => s.source === 'manual' && s.country === 'ES')).toBeTruthy() // manual survives
    const cr = after.find((s) => s.source === 'location' && s.country === 'CR')
    expect(cr).toBeTruthy()

    // Second run replaces only the derived row → same result, removed == prior derived count.
    const r2 = deriveLocationSegments(sqlite, 1)
    expect(r2.removed).toBe(1)
    expect(r2.derived).toBe(1)
    expect(segments().filter((s) => s.source === 'location')).toHaveLength(1)
    expect(segments().filter((s) => s.source === 'manual')).toHaveLength(1)
  })

  it('feeds day-counts / SPT — a 10-day CR trip counts as 10 CR days', () => {
    seedDailyPoints(CR, 10, 10, 'cr')
    deriveLocationSegments(sqlite, 1)

    const summary = buildResidencySummary(sqlite, YEAR)
    const crDays = summary.years[0].countries.find((c) => c.country === 'CR')?.days
    expect(crDays).toBe(10)
  })

  it('reflects a US trip in the substantial-presence test', () => {
    // home = CR, so a US trip is "away" and produces a counted US segment.
    sqlite
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('residencyHomeCountry', 'CR', 1)
    seedDailyPoints(US, 1, 20, 'us') // 20 US days this year

    const r = deriveLocationSegments(sqlite, 1)
    expect(r.derived).toBe(1)

    const summary = buildResidencySummary(sqlite, YEAR)
    expect(summary.substantialPresence.usCurrent).toBe(20)
  })

  it('does NOT double-count a derived run overlapping a manual trip (unique days)', () => {
    // Manual CR trip + a derived CR trip over (roughly) the same window.
    addTravelSegment(sqlite, {
      country: 'CR',
      startDate: `${YEAR}-03-10`,
      endDate: `${YEAR}-03-19`
    })
    seedDailyPoints(CR, 10, 10, 'cr')
    deriveLocationSegments(sqlite, 1)

    const summary = buildResidencySummary(sqlite, YEAR)
    const crDays = summary.years[0].countries.find((c) => c.country === 'CR')?.days ?? 0
    expect(crDays).toBeGreaterThanOrEqual(10)
    expect(crDays).toBeLessThanOrEqual(11) // union of the overlap, NOT 20
  })
})
